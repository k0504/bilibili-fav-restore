    // ─── Backup import (ZIP) ────────────────────────────────────────────
    //
    // The mirror of 15c-backup-export.js: it reads a container this script
    // wrote and merges it back INTO the IndexedDB store. Three jobs nothing
    // else can do — restoring after the browser evicted the origin-scoped
    // database, carrying an archive between the two origin-scoped databases
    // (space.bilibili.com and www.bilibili.com keep SEPARATE ones, see 15a),
    // and moving a backup to another machine or browser profile.
    //
    // Constraints that shaped the implementation:
    //   - No third-party library, same as the writer: the reader below is
    //     hand-written and works off the CENTRAL DIRECTORY, the only part of a
    //     ZIP that is authoritative about what the archive contains. DEFLATE
    //     entries go through the browser's own DecompressionStream — native,
    //     zero core bytes — so a container the user re-zipped with a file
    //     manager still imports even though this script only ever writes STORE.
    //   - The bootstrap's @grant list is frozen, so the file arrives through a
    //     plain <input type="file">: no GM_download, no reading a local path.
    //   - MEMORY IS THE HARD PART, exactly as in the writer. The picked File is
    //     a disk-backed lazy handle and stays one: a STORE cover is handed to
    //     IndexedDB as a file.slice() HANDLE, never as copied bytes. Only two
    //     things ever enter the heap — one cover at a time for its CRC-32
    //     (dropped immediately) and a DEFLATE payload, which cannot be
    //     inflated any other way.
    //   - The slice handle is safe to store: structured clone at put() time
    //     copies the bytes INTO the database, so the record survives the user
    //     deleting the .zip afterwards. The handle avoids a heap copy, it is
    //     not a reference the store depends on.
    //   - This module WRITES the store, which the export never does, so every
    //     15a invariant is law here too: an existing record is READ before it
    //     is replaced, media_ids are UNIONED rather than overwritten, and the
    //     cover quad (cover_url / cover_blob / cover_type / cover_size)
    //     travels as ONE unit — cover bytes have no upstream to re-fetch from,
    //     so they are never overwritten with null.

    // ─── ZIP reader ─────────────────────────────────────────────────────
    //
    // PURE functions: no DOM, no toast, no IndexedDB. That is deliberate —
    // they are the half of this module that can be exercised outside a
    // browser, and keeping them free of side effects is what makes an archive
    // written by the export testable end to end.
    //
    // Every multi-byte field is little-endian, hence DataView with the
    // explicit `true`, matching the writer in 15c.

    var ZIP_SIG_LOCAL = 0x04034b50;
    var ZIP_SIG_CD    = 0x02014b50;
    var ZIP_SIG_EOCD  = 0x06054b50;

    // An archive comment can push the EOCD up to 65535 bytes away from the end
    // of the file, so its position is not fixed and has to be searched for.
    var ZIP_MAX_COMMENT = 65535;

    // Flag bit 0: the entry is encrypted. Bit 3 (not needed by name here) says
    // sizes and CRC live in a data descriptor AFTER the payload, so the LOCAL
    // header's copies are legitimately zero — which is why nothing below ever
    // reads a size or a CRC from a local header.
    var ZIP_FLAG_ENCRYPTED = 0x0001;

    var _zipDecoder = null;
    function zipDecoder() {
        if (!_zipDecoder) _zipDecoder = new TextDecoder('utf-8');
        return _zipDecoder;
    }

    // Reads the central directory of `file` (a Blob) and returns
    // { entries: [...], byName: Map }. Throws an Error with a human-readable
    // .message on anything structurally wrong — the caller turns that message
    // into the refusal toast, so it is written for a user, not for a log.
    async function zipReadDirectory(file) {
        var size = file.size;
        if (!size || size < 22) throw new Error('文件过小，不是有效的 ZIP');

        // Scan BACKWARDS: the EOCD is the last record, but a trailing comment
        // may sit behind it, and a forward scan would happily stop on the
        // first four bytes that merely look like the signature.
        var tailLen = Math.min(size, 22 + ZIP_MAX_COMMENT);
        var tail = new Uint8Array(await file.slice(size - tailLen, size).arrayBuffer());
        var tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
        var eocd = -1;
        for (var t = tail.length - 22; t >= 0; t--) {
            if (tv.getUint32(t, true) !== ZIP_SIG_EOCD) continue;
            // The signature alone is not proof. Those four bytes can occur
            // inside the trailing comment as ordinary data, and such a match
            // sits CLOSER to the end than the real record — so the backwards
            // scan reaches it first and would read the directory offset out of
            // the middle of a comment. The comment-length field settles it:
            // the genuine EOCD declares exactly the bytes that follow its own
            // 22-byte record, arithmetic a signature embedded in that comment
            // cannot satisfy. Keep scanning whenever it disagrees.
            if (tv.getUint16(t + 20, true) !== tailLen - t - 22) continue;
            eocd = t;
            break;
        }
        if (eocd < 0) throw new Error('找不到 ZIP 结尾记录（EOCD）');

        var count    = tv.getUint16(eocd + 10, true);
        var cdSize   = tv.getUint32(eocd + 12, true) >>> 0;
        var cdOffset = tv.getUint32(eocd + 16, true) >>> 0;
        // The all-ones sentinels mean "the real value is in a ZIP64 record".
        // This reader emits no ZIP64 support at all, and guessing past the
        // sentinel would read the directory from the wrong offset — refuse
        // outright instead. The writer never produces one (it refuses well
        // short of both caps), so only a foreign container can land here.
        if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
            throw new Error('不支持 ZIP64 归档');
        }
        if (cdOffset + cdSize > size) throw new Error('中央目录越界，文件可能被截断');

        // ONE read for the whole directory: it is a few tens of KB even for a
        // thousand entries, and re-slicing per record would be a syscall per
        // entry for no gain.
        var cd = new Uint8Array(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
        var dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
        var entries = [], byName = new Map(), p = 0;
        for (var i = 0; i < count; i++) {
            if (p + 46 > cd.length) throw new Error('中央目录在第 ' + (i + 1) + ' 项处被截断');
            if (dv.getUint32(p, true) !== ZIP_SIG_CD) {
                throw new Error('中央目录第 ' + (i + 1) + ' 项签名无效');
            }
            var flags    = dv.getUint16(p + 8, true);
            var method   = dv.getUint16(p + 10, true);
            var crc      = dv.getUint32(p + 16, true) >>> 0;
            var compSize = dv.getUint32(p + 20, true) >>> 0;
            var uncomp   = dv.getUint32(p + 24, true) >>> 0;
            var nameLen  = dv.getUint16(p + 28, true);
            var extraLen = dv.getUint16(p + 30, true);
            var cmtLen   = dv.getUint16(p + 32, true);
            var localOff = dv.getUint32(p + 42, true) >>> 0;
            if (p + 46 + nameLen + extraLen + cmtLen > cd.length) {
                throw new Error('中央目录在第 ' + (i + 1) + ' 项处被截断');
            }
            if (compSize === 0xFFFFFFFF || uncomp === 0xFFFFFFFF || localOff === 0xFFFFFFFF) {
                throw new Error('不支持 ZIP64 归档');
            }
            // Names are decoded as UTF-8 unconditionally. The writer sets the
            // UTF-8 flag on every entry, and the members this importer looks
            // for (manifest.json, items.json, covers/<av>.<ext>) are ASCII by
            // construction, so a legacy CP437 name could only appear in a
            // foreign container and would not be a member we consult.
            var name = zipDecoder().decode(cd.subarray(p + 46, p + 46 + nameLen));
            var entry = {
                name: name, method: method, flags: flags, crc: crc,
                compSize: compSize, size: uncomp, localOffset: localOff
            };
            entries.push(entry);
            // FIRST record wins for a duplicated name. A duplicate is already
            // a malformed container; picking deterministically beats letting
            // the later record silently shadow the earlier one.
            if (!byName.has(name)) byName.set(name, entry);
            p += 46 + nameLen + extraLen + cmtLen;
        }
        return { entries: entries, byName: byName };
    }

    // Offset of the first payload byte of `entry`. The local header has to be
    // read for this — its name and extra lengths are its OWN and routinely
    // differ from the central-directory copies (Python's zipfile, for one,
    // writes an extended-timestamp extra field locally and a different one
    // centrally), so computing the offset from the CD lengths lands mid-payload.
    async function zipEntryDataStart(file, entry) {
        var head = new Uint8Array(
            await file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
        if (head.length < 30) throw new Error('本地文件头被截断：' + entry.name);
        var dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
        if (dv.getUint32(0, true) !== ZIP_SIG_LOCAL) {
            throw new Error('本地文件头签名无效：' + entry.name);
        }
        var nameLen  = dv.getUint16(26, true);
        var extraLen = dv.getUint16(28, true);
        return entry.localOffset + 30 + nameLen + extraLen;
    }

    // The payload of a STORE entry as a Blob HANDLE over the source file —
    // the whole reason a 200 MB archive can be imported without the bytes ever
    // reaching the heap. `type` is applied here so the handle can go straight
    // into a record without a re-wrap.
    function zipEntryStoreSlice(file, entry, dataStart, type) {
        return file.slice(dataStart, dataStart + entry.compSize, type || '');
    }

    // The DECOMPRESSED payload of `entry` as a Uint8Array. Sizes and CRC are
    // taken from the central-directory values carried on `entry` and never
    // from the local header: with flag bit 3 the local copies are legitimately
    // zero, and the CD is authoritative in any case.
    async function zipEntryBytes(file, entry) {
        if (entry.flags & ZIP_FLAG_ENCRYPTED) {
            throw new Error('条目已加密，无法读取：' + entry.name);
        }
        var dataStart = await zipEntryDataStart(file, entry);
        if (entry.method === 0) {
            return new Uint8Array(
                await zipEntryStoreSlice(file, entry, dataStart, '').arrayBuffer());
        }
        if (entry.method === 8) {
            if (typeof DecompressionStream === 'undefined') {
                throw new Error('当前浏览器不支持解压缩（DecompressionStream）');
            }
            // 'deflate-raw', not 'deflate': a ZIP payload is a bare DEFLATE
            // stream with no zlib header or trailer around it.
            var stream = zipEntryStoreSlice(file, entry, dataStart, '')
                .stream().pipeThrough(new DecompressionStream('deflate-raw'));
            // Read the stream CHUNK BY CHUNK against the declared size rather
            // than letting Response buffer it whole. The central directory is
            // the only thing that says how large the payload is, and a
            // container that lies about it — ten bytes declared, gigabytes
            // inflated — is a decompression bomb: buffering first and checking
            // afterwards means the heap is already gone by the time the check
            // could run. Overshooting by a single byte is enough to refuse.
            var reader = stream.getReader();
            var chunks = [], total = 0;
            while (true) {
                var step = await reader.read();
                if (step.done) break;
                chunks.push(step.value);
                total += step.value.length;
                if (total > entry.size) {
                    // Cancel rather than walk away: the source slice keeps
                    // feeding the decompressor otherwise.
                    try { await reader.cancel(); } catch (e) {}
                    throw new Error('解压后大小超出声明，文件可能已损坏：' + entry.name);
                }
            }
            // A stream that ends SHORT is the same kind of lie, and the caller
            // treats both the same way.
            if (total !== entry.size) {
                throw new Error('解压后大小与声明不符，文件可能已损坏：' + entry.name);
            }
            var out = new Uint8Array(total), at = 0;
            for (var c = 0; c < chunks.length; c++) {
                out.set(chunks[c], at);
                at += chunks[c].length;
            }
            return out;
        }
        throw new Error('不支持的压缩方式 ' + entry.method + '：' + entry.name);
    }

    // ─── Record helpers ─────────────────────────────────────────────────

    // The cover quad, always handled as ONE value. Splitting it is how a
    // record ends up claiming a size for bytes it does not hold, or a URL for
    // an image that was never stored.
    function importNullQuad() {
        return { url: null, blob: null, type: null, size: 0 };
    }

    // The quad for a record whose bytes the archive cannot supply. The URL
    // still travels — it costs nothing, items.json carried it perfectly well,
    // and it is what lets the next backup run notice the image is missing and
    // download it. Blob, type and size stay empty, since claiming a size for
    // bytes we do not hold is what the panel's totals would report as
    // archived covers.
    function importUrlOnlyQuad(rec) {
        var quad = importNullQuad();
        quad.url = rec.cover_url || null;
        return quad;
    }

    function importQuadOf(rec) {
        return {
            url:  rec.cover_url || null,
            blob: rec.cover_blob || null,
            type: rec.cover_type || null,
            size: rec.cover_size || 0
        };
    }

    function importApplyQuad(rec, quad) {
        rec.cover_url  = quad.url;
        rec.cover_blob = quad.blob;
        rec.cover_type = quad.type;
        rec.cover_size = quad.size;
    }

    // Value comparison, not identity: it answers "would writing this quad
    // change the stored record?", and that has to stay false when a re-import
    // of the same file rebuilds an equal-but-not-identical quad. The Blob is
    // compared by reference on purpose — two handles over the same bytes are
    // still a different clone at put() time.
    function importSameQuad(quad, rec) {
        return quad.blob === (rec.cover_blob || null)
            && quad.url  === (rec.cover_url  || null)
            && quad.type === (rec.cover_type || null)
            && quad.size === (rec.cover_size || 0);
    }

    // media_ids is the folder membership set and the panel's whole filter
    // dimension, so an import UNIONS it: a container exported from one folder
    // must never shrink a record that also belongs to three others. Existing
    // first, then whatever the file adds, so the stored order is stable across
    // re-imports. Values are coerced to Number, matching what the walker
    // writes (mgrApplyFilter compares with indexOf(Number(fid))); 0 and NaN
    // are dropped because neither is a media_id.
    function importUnionMediaIds(existingIds, incomingIds) {
        var list = [], seen = new Set(), added = 0;
        var take = function (src, isNew) {
            if (!Array.isArray(src)) return;
            for (var i = 0; i < src.length; i++) {
                var n = Number(src[i]);
                if (!n || seen.has(n)) continue;
                seen.add(n);
                list.push(n);
                if (isNew) added++;
            }
        };
        take(existingIds, false);
        take(incomingIds, true);
        return { list: list, added: added };
    }

    // One field-by-field copy used for BOTH sides of the merge: the stored
    // record and the record rebuilt from items.json carry the same field
    // names by construction (exportItemMeta in 15c is the other half of this
    // contract). Spelled out rather than cloned so a future field added to the
    // store cannot start travelling through the importer unnoticed.
    function importCopyRecord(src) {
        return {
            av:          src.av,
            bvid:        src.bvid || null,
            title:       src.title || '',
            intro:       src.intro || '',
            upper:       src.upper || null,
            cnt_info:    src.cnt_info || null,
            tid:         src.tid,
            duration:    src.duration,
            pubtime:     src.pubtime,
            ctime:       src.ctime,
            fav_time:    src.fav_time,
            pages:       src.pages,
            page:        src.page,
            link:        src.link || '',
            cover_url:   src.cover_url || null,
            cover_blob:  src.cover_blob || null,
            cover_type:  src.cover_type || null,
            cover_size:  src.cover_size || 0,
            media_ids:   Array.isArray(src.media_ids) ? src.media_ids.slice() : [],
            backed_at:   src.backed_at || 0,
            data_source: src.data_source || ''
        };
    }

    // One items.json record as a store record. The cover quad is left empty
    // here and applied separately, because resolving it means reading the
    // archive and may fail independently of the metadata.
    //
    // JSON cannot carry `undefined`, so the optional fields the writer
    // normalised to null come back as null. That is harmless: the merge layer
    // judges every field through the same QUALITY predicates, which reject
    // null exactly as they reject undefined.
    function importItemRecord(rec, av) {
        var out = importCopyRecord(rec);
        out.av = av;
        out.media_ids = importUnionMediaIds([], rec.media_ids).list;
        out.backed_at = Number(rec.backed_at) || 0;
        importApplyQuad(out, importNullQuad());
        return out;
    }

    // Resolves the cover quad an items.json record brings with it. Whenever the
    // archive cannot supply usable bytes the answer is the URL-ONLY quad —
    // never a half-filled one, and never one that ALSO throws away the URL.
    // Failing to read an image is no reason to forget where it came from: the
    // metadata is intact in items.json either way, and dropping the URL is
    // what would make the loss permanent.
    async function importCoverQuad(file, dir, rec, stats) {
        // No cover_file means the record was exported without an image (the
        // writer only fills it once the bytes are actually in the archive), so
        // nothing was lost here and nothing is counted.
        if (!rec.cover_file) return importUrlOnlyQuad(rec);
        var entry = dir.byName.get(String(rec.cover_file));
        if (!entry) {
            // The record advertises bytes the container does not have — a
            // hand-edited or partially extracted archive. The metadata and the
            // URL still import; only the image is lost, and the count says so.
            stats.coverMissing++;
            return importUrlOnlyQuad(rec);
        }
        try {
            if (entry.flags & ZIP_FLAG_ENCRYPTED) throw new Error('encrypted cover entry');
            var dataStart = await zipEntryDataStart(file, entry);
            var bytes, blob;
            if (entry.method === 0) {
                // The ONE point where cover bytes enter the heap, and only
                // because CRC-32 cannot be computed without reading them. The
                // slice is created FIRST and kept: the record kept below is
                // the HANDLE, so the buffer read here is dropped the moment
                // the checksum is in and the bytes are never held twice.
                blob = zipEntryStoreSlice(file, entry, dataStart, rec.cover_type || '');
                bytes = new Uint8Array(await blob.arrayBuffer());
            } else {
                // Compressed: the payload has to be inflated to exist at all,
                // so there is no handle to keep and the inflated bytes become
                // the Blob directly.
                bytes = await zipEntryBytes(file, entry);
                blob = new Blob([bytes], { type: rec.cover_type || '' });
            }
            // Length AND checksum. A truncated payload can still checksum to
            // something, and a length that disagrees with the directory means
            // the container is not what it says it is either way.
            if (bytes.length !== entry.size || crc32Bytes(bytes) !== entry.crc) {
                stats.coverCrcFailed++;
                return importUrlOnlyQuad(rec);
            }
            var quad = importUrlOnlyQuad(rec);
            quad.blob = blob;
            quad.type = rec.cover_type || blob.type || null;
            quad.size = bytes.length;
            return quad;
        } catch (e) {
            // An unreadable member is indistinguishable from a corrupt one as
            // far as the user is concerned: either way this item arrives
            // without its image, keeps the URL it arrived with, and the count
            // says so.
            warn('import: cover read failed for', rec.cover_file, e && e.message);
            stats.coverCrcFailed++;
            return importUrlOnlyQuad(rec);
        }
    }

    // ─── Orchestration ──────────────────────────────────────────────────
    //
    // Import-vs-import exclusion, at module scope for the same reason
    // _exportRunning (15c) and _backupRunning (15a) are: the panel's
    // s.importBusy dies with the panel, yet closing the panel does NOT cancel
    // a run, and __biliFavFix.backup.importFile bypasses the panel entirely.
    // 15a and 15c read this flag too — var hoisting across the concatenated
    // IIFE makes it visible there.
    var _importRunning = false;

    // Guard wrapper only; everything else is in importBackupFileInner. The
    // release lives in a finally because the inner function has a dozen
    // refusal paths and may throw: a flag left set would kill every later
    // import for the lifetime of the page.
    async function importBackupFile(file, opts) {
        if (_importRunning) { toast('导入进行中，请稍后再试', 'warn'); return null; }
        _importRunning = true;
        try {
            return await importBackupFileInner(file, opts);
        } finally {
            _importRunning = false;
            // A panel opened mid-run derives its import button from this flag
            // and has nothing else that would repaint it once the run ends.
            mgrImportReleased();
            // Promotion tasks defer while an import runs (15e); resume them.
            drainPromoteQueue();
        }
    }

    // opts:
    //   onProgress function (done, total) — called per item, and once more
    //              with (total, total) when the item loop finishes
    //
    // Resolves to a stats object, or null when the import was refused before
    // touching the store.
    async function importBackupFileInner(file, opts) {
        opts = opts || {};
        if (!file) { toast('没有选择备份文件', 'warn'); return null; }
        if (typeof indexedDB === 'undefined') {
            toast('当前环境不支持 IndexedDB，无法导入', 'err');
            return null;
        }
        // A walk rewrites the very records this merge reads and replaces, and
        // an export reads records this merge is rewriting — either overlap
        // produces a mixed-generation result nobody can reason about. Both
        // flags are refused symmetrically from the other two modules.
        if (_backupRunning) { toast('备份进行中，请稍后导入', 'warn'); return null; }
        if (_exportRunning) { toast('导出进行中，请稍后导入', 'warn'); return null; }

        var dir;
        try { dir = await zipReadDirectory(file); }
        catch (e) { toast('备份文件解析失败：' + (e && e.message), 'err'); return null; }

        var manifestEntry = dir.byName.get('manifest.json');
        var itemsEntry    = dir.byName.get('items.json');
        if (!manifestEntry || !itemsEntry) {
            toast('缺少 manifest.json 或 items.json，不是本脚本导出的备份文件', 'err');
            return null;
        }

        var manifestBytes, itemsBytes;
        try {
            manifestBytes = await zipEntryBytes(file, manifestEntry);
            itemsBytes    = await zipEntryBytes(file, itemsEntry);
        } catch (e) {
            toast('备份文件读取失败：' + (e && e.message), 'err');
            return null;
        }
        // Both JSON members are verified BEFORE anything is parsed. They
        // describe the whole import; a corrupt byte in either one turns the
        // merge into a guess, so a mismatch refuses the file outright — unlike
        // a corrupt cover, which costs one image and is counted.
        if (crc32Bytes(manifestBytes) !== manifestEntry.crc
            || crc32Bytes(itemsBytes) !== itemsEntry.crc) {
            toast('备份文件已损坏（校验失败）', 'err');
            return null;
        }

        var manifest, items;
        try {
            manifest = JSON.parse(zipDecoder().decode(manifestBytes));
            items    = JSON.parse(zipDecoder().decode(itemsBytes));
        } catch (e) {
            toast('备份文件内容无法解析：' + (e && e.message), 'err');
            return null;
        }
        if (!manifest || manifest.format !== 'bili-fav-fix-backup') {
            toast('不是本脚本导出的备份文件', 'err');
            return null;
        }
        if (Number(manifest.format_version) > EXPORT_FORMAT_VERSION) {
            toast('备份文件版本过新，请先更新脚本', 'err');
            return null;
        }
        if (!Array.isArray(items)) {
            toast('备份文件内容格式错误（items.json 不是数组）', 'err');
            return null;
        }
        // manifest.origin deliberately does NOT have to match location.origin.
        // The backup database is origin-scoped, so a folder archived on
        // space.bilibili.com does not exist on www.bilibili.com — and carrying
        // a container across that boundary is the SUPPORTED migration path
        // between the two databases, not a mistake to guard against.

        var stats = {
            items: 0, added: 0, updated: 0, kept: 0, covers: 0,
            invalid: 0, coverMissing: 0, coverCrcFailed: 0,
            readFailed: 0, writeFailed: 0, folders: 0
        };
        var total = items.length;
        for (var i = 0; i < total; i++) {
            if (opts.onProgress) opts.onProgress(i, total);
            var rec = items[i];
            var av = (rec && rec.av != null) ? String(rec.av).trim() : '';
            // `av` is the store's keyPath and the key every other layer joins
            // on (the GM cache, pageItems, the resolver). A record without a
            // usable one has nowhere to go, and coercing a non-numeric key
            // would poison those joins — count it and move on.
            if (!/^\d+$/.test(av)) { stats.invalid++; continue; }

            var existing = null;
            try { existing = await idbGet(BACKUP_STORE_ITEMS, av); }
            catch (e) {
                // Same reasoning as the backup walker (15a): idbPut replaces
                // the record wholesale, so writing without knowing what is
                // already stored could truncate media_ids or destroy the only
                // copy of a cover. Skip the av — the file can be re-imported
                // once the database is healthy again.
                warn('import: idbGet failed for av', av, e && e.message);
                stats.readFailed++;
                continue;
            }

            var incoming = importItemRecord(rec, av);
            var incomingQuad = null;

            if (!existing) {
                // Nothing is stored, so the archive holds the only copy of the
                // image there is and the read always has to happen.
                incomingQuad = await importCoverQuad(file, dir, rec, stats);
                importApplyQuad(incoming, incomingQuad);
                if (!(await importPut(incoming, stats))) continue;
                stats.added++;
                if (incomingQuad.blob) stats.covers++;
                continue;
            }

            // Newer-wins at RECORD level, by backed_at. Field-level merging was
            // rejected on purpose: the fields of one record describe ONE
            // observation of the video, and picking title from one generation
            // and cnt_info from another invents a snapshot that never existed.
            var incomingWins = incoming.backed_at > (existing.backed_at || 0);
            var ids = importUnionMediaIds(existing.media_ids, incoming.media_ids);
            var existingQuad = importQuadOf(existing);

            // The DECISION comes before the READ, deliberately. Both inputs to
            // newer-wins (backed_at) and to the union (media_ids) are already
            // in the parsed items.json and cost nothing; resolving the cover
            // costs a slice, a heap copy and a CRC-32 over every archived
            // image. When the stored record wins, already holds bytes, and the
            // union adds no folder, the archive's copy cannot change the
            // outcome — so a re-import of an unchanged container now reads no
            // cover at all instead of checksumming every one of them to write
            // nothing.
            //
            // The consequence for the two cover failure counters is that they
            // describe the covers this merge actually NEEDED, not every cover
            // in the container: a corrupt image behind a record that loses
            // anyway is never opened and never counted. That is the honest
            // reading — nothing was lost, because nothing was wanted.
            if (!incomingWins && existingQuad.blob && !ids.added) {
                stats.kept++;
                continue;
            }

            incomingQuad = await importCoverQuad(file, dir, rec, stats);
            var winnerQuad = incomingWins ? incomingQuad : existingQuad;
            var loserQuad  = incomingWins ? existingQuad : incomingQuad;
            // Two overrides on top of newer-wins, both because the losing
            // record still holds things the winner cannot re-derive:
            //   media_ids — folder membership is cumulative, never replaced;
            //   the cover quad — bytes have no upstream, so a winner without
            //   an image keeps the loser's quad WHOLESALE rather than nulling
            //   a picture that took a download to obtain.
            // The loser's quad is only ever interesting for its BYTES: a
            // blobless loser holds nothing the winner lacks, and taking it
            // anyway would drag the winner's cover_url back to the losing
            // generation's for no gain at all.
            var quad = winnerQuad.blob ? winnerQuad : (loserQuad.blob ? loserQuad : winnerQuad);

            var merged = importCopyRecord(incomingWins ? incoming : existing);
            merged.av = av;
            merged.media_ids = ids.list;
            // The winner's stamp, not Date.now(): an import RESTORES an
            // observation, it does not make one. Stamping now would tell the
            // next backup run that this record is fresher than it is.
            merged.backed_at = (incomingWins ? incoming.backed_at : existing.backed_at) || 0;
            importApplyQuad(merged, quad);

            // Nothing the file brought would change the stored record, so the
            // write is skipped entirely: it makes re-importing the same
            // container idempotent, and it avoids a structured clone of a
            // cover that is already in the database. The cheap half of this
            // test already ran above; what reaches here is the case where the
            // archive turned out to hold no usable bytes either, leaving the
            // stored quad the winner after all.
            if (!incomingWins && !ids.added && importSameQuad(quad, existing)) {
                stats.kept++;
                continue;
            }
            if (!(await importPut(merged, stats))) continue;
            stats.updated++;
            if (quad === incomingQuad && quad.blob) stats.covers++;
        }
        if (opts.onProgress) opts.onProgress(total, total);
        stats.items = stats.added + stats.updated + stats.kept;

        await importFolders(manifest, stats);

        if (stats.added || stats.updated) {
            // The store just turned "no local data for this av" into "there is
            // now", so the credential-less restore path must re-check
            // (14-orchestrate.js) — the same invalidation a backup run does in
            // its finally. Nothing else clears that memo without a page load.
            _localOnlyMiss.clear();
        }

        // Appended only when non-zero, and the whole toast drops to warn: each
        // of these means the merge is thinner than the container the user
        // handed over, which a plain success line would hide.
        var msg = '已导入 ' + stats.items + ' 项（新增 ' + stats.added
                + ' · 更新 ' + stats.updated + ' · 保留 ' + stats.kept + '）'
                + ' · 封面 ' + stats.covers + ' 张';
        if (stats.invalid)        msg += ' · 记录无效 ' + stats.invalid;
        if (stats.coverMissing)   msg += ' · 封面缺失 ' + stats.coverMissing;
        if (stats.coverCrcFailed) msg += ' · 封面校验失败 ' + stats.coverCrcFailed;
        if (stats.readFailed)     msg += ' · 读取失败 ' + stats.readFailed;
        if (stats.writeFailed)    msg += ' · 写入失败 ' + stats.writeFailed;
        var degraded = stats.invalid || stats.coverMissing || stats.coverCrcFailed
                    || stats.readFailed || stats.writeFailed;
        toast(msg, degraded ? 'warn' : 'ok');

        return stats;
    }

    // One record into the items store. Returns whether it landed, so a failed
    // write is never counted as 新增 / 更新 — a summary that claims records the
    // database does not hold is worse than no summary at all.
    async function importPut(rec, stats) {
        try {
            await idbPut(BACKUP_STORE_ITEMS, rec);
            return true;
        } catch (e) {
            warn('import: idbPut failed for av', rec.av, e && e.message);
            stats.writeFailed++;
            return false;
        }
    }

    // The meta store, from manifest.folders[]. It is the ONLY per-folder answer
    // to "when was this folder last backed up in full", so an import must not
    // overwrite a LOCAL complete run with an older one carried in the file:
    // only a strictly newer last_run wins, and a folder the database has never
    // seen is written outright (its title alone already earns the panel's
    // dropdown a real name instead of a raw id).
    //
    // The per-run counters (backed / updated / …) are not in the container —
    // they describe a walk, and this is not one — so they are written as zero
    // rather than invented. last_attempt follows last_run for the same reason:
    // stamping Date.now() would claim an attempt happened just now.
    async function importFolders(manifest, stats) {
        var list = Array.isArray(manifest.folders) ? manifest.folders : [];
        for (var i = 0; i < list.length; i++) {
            var f = list[i];
            if (!f || f.media_id == null) continue;
            var key = String(f.media_id);
            var lastRun = Number(f.last_run) || 0;
            var prev = null;
            try { prev = await idbGet(BACKUP_STORE_META, key); }
            catch (e) {
                warn('import: meta read failed for', key, e && e.message);
                continue;
            }
            if (prev && lastRun <= (prev.last_run || 0)) continue;
            var rec = {
                media_id:            key,
                last_run:            lastRun,
                total_seen:          Number(f.total_seen) || 0,
                backed:              0,
                updated:             0,
                skipped_invalid:     0,
                blob_failed:         0,
                cover_kept:          0,
                read_failed:         0,
                title:               f.title || (prev && prev.title) || null,
                last_attempt:        lastRun,
                last_attempt_partial: !!f.last_attempt_partial,
                // Carried through when the container has it. Containers
                // written before the field was added to the manifest have
                // none, and 0 then means "unknown" rather than "page zero" —
                // the footer in 15b reads it that way and omits the clause.
                last_attempt_page:   Number(f.last_attempt_page) || 0
            };
            try {
                await idbPut(BACKUP_STORE_META, rec);
                stats.folders++;
            } catch (e) {
                warn('import: meta write failed for', key, e && e.message);
            }
        }
    }

    // ─── File picker ────────────────────────────────────────────────────
    //
    // A menu or FAB click is a user gesture, so input.click() opens the
    // picker. The input is DETACHED for the same reason the export anchor is
    // (15c): bilibili delegates click handlers at document level, and a node
    // outside the document tree has no propagation path into them.
    //
    // opts:
    //   onStart    function (file) — the picker produced a file and the run is
    //              about to begin. Callers lock their UI HERE rather than at
    //              click time: a dismissed dialog fires no event at all, and a
    //              lock taken before the dialog would never be released.
    //   onProgress forwarded to importBackupFile
    //   onSettled  function (stats) — after the run resolves OR rejects; stats
    //              is null when it was refused or threw. It is the only
    //              completion signal a picker-driven caller gets.
    function importPickBackupFile(opts) {
        opts = opts || {};
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.zip,application/zip';
        input.addEventListener('change', function () {
            var file = input.files && input.files[0];
            // Dialog dismissed. Nothing was promised and nothing was locked,
            // so this path is deliberately silent — a toast here would report
            // the user's own cancellation back at them as a failure.
            if (!file) return;
            if (opts.onStart) opts.onStart(file);
            importBackupFile(file, { onProgress: opts.onProgress }).then(function (stats) {
                if (opts.onSettled) opts.onSettled(stats);
            }, function (e) {
                warn('import: run threw', e);
                toast('导入失败：' + (e && e.message), 'err');
                if (opts.onSettled) opts.onSettled(null);
            });
        });
        input.click();
    }
