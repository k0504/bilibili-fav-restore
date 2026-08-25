    // ─── Backup export (ZIP) ────────────────────────────────────────────
    //
    // The IndexedDB backup is origin-scoped, invisible outside DevTools and
    // evictable under storage pressure (navigator.storage.persist() is a
    // request, not a guarantee). This module is the way out of the browser: it
    // packs a panel selection into ONE .zip the user can keep anywhere —
    // items.json for the metadata, covers/<av>.<ext> for the image bytes,
    // manifest.json so the container describes itself.
    //
    // Constraints that shaped the implementation:
    //   - The core is a self-contained IIFE loaded by eval, so NO third-party
    //     library may be pulled in and the ZIP writer below is hand-written.
    //     STORE (method 0, no compression) is deliberate: covers are already
    //     JPEG/WebP and would not shrink, and a DEFLATE implementation would
    //     cost more core bytes on every page load than it ever saves.
    //   - The bootstrap's @grant list is frozen (adding one re-prompts every
    //     user), so GM_download is unavailable — the file leaves through an
    //     objectURL on a synthetic <a download>.
    //   - MEMORY IS THE HARD PART. Chromium keeps IDB Blobs as file-backed
    //     lazy handles, so a 228 MB backup only stays out of the heap if the
    //     bytes are never materialised. The output Blob is therefore assembled
    //     from PARTS — headers as Uint8Array, cover payloads as the Blob
    //     HANDLES themselves — never by concatenating arrayBuffers. The one
    //     place bytes must be read is the CRC-32, and that reads one cover at
    //     a time and drops the buffer immediately.
    //   - Read-only by definition: this module writes no store and drops no
    //     cache, so none of the three-layer delete / carry-forward invariants
    //     in 15a/15b apply to it.

    // Bumped only when the on-disk layout changes in a way an importer would
    // have to branch on. Written into manifest.json so a future import path
    // can refuse a container it does not understand instead of guessing.
    var EXPORT_FORMAT_VERSION = 1;

    // The writer below emits no ZIP64 records, so the 32-bit header fields cap
    // an archive at 4 GiB and 65535 entries. Refuse well short of both: an
    // over-cap archive is not an error at write time, it is a file that only
    // some extractors can open.
    var EXPORT_MAX_BYTES   = 3.5 * 1024 * 1024 * 1024;
    var EXPORT_MAX_ENTRIES = 65000;
    // Per-item cost of the two JSON members, used ONLY by the pre-flight size
    // check. Their real size is known far too late to refuse politely.
    var EXPORT_JSON_BYTES_PER_ITEM = 800;

    // ─── CRC-32 ─────────────────────────────────────────────────────────
    // Table-driven, polynomial 0xEDB88320 (the reflected form ZIP uses).
    // Streaming (init / update / final) rather than one-shot so a payload can
    // be fed in pieces without ever holding it twice, and so every entry gets
    // its own independent accumulator.
    // Every step ends with `>>> 0`: JS bitwise operators produce SIGNED 32-bit
    // integers, and a negative CRC written into a header is a corrupt archive
    // that only shows up when the user tries to extract it.

    var _crcTable = null;

    function crc32Table() {
        if (_crcTable) return _crcTable;
        var t = new Uint32Array(256);
        for (var i = 0; i < 256; i++) {
            var c = i;
            for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[i] = c >>> 0;
        }
        _crcTable = t;
        return t;
    }

    function crc32Init() { return 0xFFFFFFFF; }

    function crc32Update(crc, bytes) {
        var t = crc32Table();
        for (var i = 0; i < bytes.length; i++) {
            crc = (t[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
        }
        return crc >>> 0;
    }

    function crc32Final(crc) { return (crc ^ 0xFFFFFFFF) >>> 0; }

    function crc32Bytes(bytes) { return crc32Final(crc32Update(crc32Init(), bytes)); }

    // ─── ZIP container (STORE) ──────────────────────────────────────────
    // Every multi-byte field is little-endian, hence DataView with the
    // explicit `true`: a hand-rolled byte-assignment loop would have to spell
    // out the order at each of the two dozen fields below.

    var _zipEncoder = null;
    function zipEncoder() {
        if (!_zipEncoder) _zipEncoder = new TextEncoder();
        return _zipEncoder;
    }

    // Bit 11. Entry names are pure ASCII by construction (manifest.json,
    // items.json, covers/<av>.<ext>) — the flag is set anyway because it costs
    // nothing and states outright that the name bytes are UTF-8, which is what
    // every modern extractor wants to be told.
    var ZIP_FLAG_UTF8 = 0x0800;

    // The DOS time field has two-second resolution (seconds >> 1) and the date
    // field counts years from 1980; both are inherited from the original PKZIP
    // format and cannot be widened without a ZIP64/extended-timestamp field.
    function zipDosTime(d) {
        return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
    }
    function zipDosDate(d) {
        return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
    }

    // `data` is either a Uint8Array (the JSON members) or an IDB Blob handle
    // (a cover). Both are valid Blob parts, which is exactly why the payload
    // never has to be read to be written.
    function zipEntry(name, crc, size, data) {
        return { name: zipEncoder().encode(name), crc: crc, size: size, data: data };
    }

    function zipLocalHeader(entry, dosTime, dosDate) {
        var out = new Uint8Array(30 + entry.name.length);
        var dv = new DataView(out.buffer);
        dv.setUint32(0, 0x04034b50, true);
        dv.setUint16(4, 20, true);                  // version needed to extract
        dv.setUint16(6, ZIP_FLAG_UTF8, true);
        dv.setUint16(8, 0, true);                   // method 0 = STORE
        dv.setUint16(10, dosTime, true);
        dv.setUint16(12, dosDate, true);
        dv.setUint32(14, entry.crc, true);
        dv.setUint32(18, entry.size, true);         // compressed size ...
        dv.setUint32(22, entry.size, true);         // ... equals uncompressed under STORE
        dv.setUint16(26, entry.name.length, true);
        dv.setUint16(28, 0, true);                  // no extra field
        out.set(entry.name, 30);
        return out;
    }

    function zipCentralEntry(entry, dosTime, dosDate, offset) {
        var out = new Uint8Array(46 + entry.name.length);
        var dv = new DataView(out.buffer);
        dv.setUint32(0, 0x02014b50, true);
        dv.setUint16(4, 20, true);                  // version made by
        dv.setUint16(6, 20, true);                  // version needed to extract
        dv.setUint16(8, ZIP_FLAG_UTF8, true);
        dv.setUint16(10, 0, true);                  // method 0 = STORE
        dv.setUint16(12, dosTime, true);
        dv.setUint16(14, dosDate, true);
        dv.setUint32(16, entry.crc, true);
        dv.setUint32(20, entry.size, true);
        dv.setUint32(24, entry.size, true);
        dv.setUint16(28, entry.name.length, true);
        dv.setUint16(30, 0, true);                  // extra field length
        dv.setUint16(32, 0, true);                  // file comment length
        dv.setUint16(34, 0, true);                  // disk number start
        dv.setUint16(36, 0, true);                  // internal attributes
        dv.setUint32(38, 0, true);                  // external attributes
        dv.setUint32(42, offset, true);             // offset of the local header
        out.set(entry.name, 46);
        return out;
    }

    function zipEocd(count, cdSize, cdOffset) {
        var out = new Uint8Array(22);
        var dv = new DataView(out.buffer);
        dv.setUint32(0, 0x06054b50, true);
        dv.setUint16(4, 0, true);                   // this disk
        dv.setUint16(6, 0, true);                   // disk holding the central directory
        dv.setUint16(8, count, true);
        dv.setUint16(10, count, true);
        dv.setUint32(12, cdSize, true);
        dv.setUint32(16, cdOffset, true);
        dv.setUint16(20, 0, true);                  // no archive comment
        return out;
    }

    // Offsets are accumulated here rather than tracked during the walk: a
    // central-directory record must point at its local header, and that offset
    // is only knowable once the entry ORDER is final (manifest.json and
    // items.json are prepended after every cover is known).
    function zipAssemble(entries, when) {
        var dosTime = zipDosTime(when);
        var dosDate = zipDosDate(when);
        var parts = [], central = [], offset = 0, cdSize = 0;
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var local = zipLocalHeader(e, dosTime, dosDate);
            parts.push(local);
            if (e.size) parts.push(e.data);
            var ce = zipCentralEntry(e, dosTime, dosDate, offset);
            central.push(ce);
            cdSize += ce.length;
            offset += local.length + e.size;
        }
        for (var j = 0; j < central.length; j++) parts.push(central[j]);
        parts.push(zipEocd(entries.length, cdSize, offset));
        // Parts, not a byte concatenation: a cover part is the IDB Blob handle
        // itself, so the whole archive is described without a single cover
        // being pulled into the heap.
        return new Blob(parts, { type: 'application/zip' });
    }

    // ─── Export helpers ─────────────────────────────────────────────────

    var EXPORT_COVER_EXT = {
        'image/jpeg': 'jpg',
        'image/jpg':  'jpg',
        'image/png':  'png',
        'image/webp': 'webp',
        'image/gif':  'gif'
    };

    // An unknown or absent MIME keeps the bytes under `.bin` rather than
    // guessing an extension: the stored cover_type travels in items.json
    // regardless, so nothing is lost and nothing is misrepresented.
    function exportCoverExt(type) {
        var t = String(type || '').toLowerCase().split(';')[0].trim();
        return EXPORT_COVER_EXT[t] || 'bin';
    }

    function exportStamp(d) {
        var p = function (x) { return x < 10 ? '0' + x : String(x); };
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
             + '-' + p(d.getHours()) + p(d.getMinutes());
    }

    // Names the archive after what is inside it, so a folder-at-a-time export
    // does not produce a directory of indistinguishable files. Folder titles
    // come from bilibili and are free-form, hence the sanitising pass over the
    // characters Windows and macOS reject in a filename.
    function exportScopeLabel(scope) {
        var label = '全部';
        if (scope.folder && scope.folder !== '*') {
            label = scope.folderTitle || ('收藏夹' + scope.folder);
        }
        label = String(label).replace(/[\\/:*?"<>|]/g, '_');
        if (scope.query && scope.query.trim()) label += '_筛选';
        return label;
    }

    // undefined is not representable in JSON — the key would simply vanish
    // from the output — so every optional field is normalised to null and the
    // record shape in items.json stays fixed across all entries.
    function exportOrNull(v) { return v === undefined ? null : v; }

    // The metadata half of a stored record, i.e. everything EXCEPT cover_blob.
    // Spelled out field by field instead of cloning-and-deleting: the export
    // file is a contract with whatever reads it later, so a future schema
    // change in the store must not silently alter it — and an accidental Blob
    // reference here would be held for the entire run, pinning bytes the whole
    // parts-based design exists to avoid.
    function exportItemMeta(rec) {
        return {
            av:          String(rec.av),
            bvid:        rec.bvid || null,
            title:       rec.title || '',
            intro:       rec.intro || '',
            upper:       rec.upper || null,
            cnt_info:    rec.cnt_info || null,
            tid:         exportOrNull(rec.tid),
            duration:    exportOrNull(rec.duration),
            pubtime:     exportOrNull(rec.pubtime),
            ctime:       exportOrNull(rec.ctime),
            fav_time:    exportOrNull(rec.fav_time),
            pages:       exportOrNull(rec.pages),
            page:        exportOrNull(rec.page),
            link:        rec.link || '',
            media_ids:   Array.isArray(rec.media_ids) ? rec.media_ids.slice() : [],
            backed_at:   rec.backed_at || 0,
            data_source: rec.data_source || '',
            cover_url:   rec.cover_url || null,
            cover_type:  rec.cover_type || null,
            cover_size:  rec.cover_size || 0,
            // Filled in only once the bytes are actually in the archive; an
            // unreadable or absent cover leaves it null so a reader never
            // follows a path that is not there.
            cover_file:  null
        };
    }

    // Summary of every folder the exported items belong to, taken from the
    // meta store. It is what tells a reader when each folder was last walked
    // in full — a detail items.json cannot carry, since it lives per folder
    // rather than per item.
    function exportFolders(ids, metas) {
        var keys = Array.from(ids);
        keys.sort(function (a, b) { return Number(a) - Number(b); });
        var out = [];
        for (var i = 0; i < keys.length; i++) {
            var m = metas.get(keys[i]) || null;
            out.push({
                media_id:             keys[i],
                title:                (m && m.title) || null,
                last_run:             (m && m.last_run) || null,
                total_seen:           (m && m.total_seen) || 0,
                last_attempt_partial: !!(m && m.last_attempt_partial),
                // An ADDED field, and format_version deliberately stays 1: a
                // reader ignores keys it does not know, so an older script
                // reads this manifest exactly as it read every previous one,
                // while a current one recovers the page an aborted walk
                // stopped at instead of rendering an imported folder as 第 0
                // 页. Only a field whose ABSENCE a reader cannot survive would
                // justify the bump, and this is not one.
                last_attempt_page:    (m && m.last_attempt_page) || 0
            });
        }
        return out;
    }

    function exportTriggerDownload(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        // DETACHED on purpose — never append this anchor to the document.
        // bilibili delegates a click handler at the document level that
        // hijacks anchor navigation (rewrites the href, strips the blob:
        // scheme, appends spm tracking and NAVIGATES the tab — observed live:
        // the page left for space.bilibili.comhttps//… instead of
        // downloading). A click dispatched on a detached node has no
        // propagation path into the document tree, so their handler never
        // sees it, while Chromium starts the download regardless of
        // attachment.
        a.click();
        // NEVER revoked. Chromium captures the blob when the download STARTS,
        // not when the click returns — and with Chrome's "ask where to save
        // each file" setting the start is deferred until the user answers the
        // Save As dialog, which can sit open indefinitely. An anchor download
        // gives the page ZERO feedback (no start/complete/cancel event), so
        // there is no safe moment to revoke and any timer is a guess that
        // corrupts the download when it guesses wrong. The URL dies with the
        // document instead; what it pins until then is only the zip's part
        // LIST (IDB blob handles, not bytes) — a few entries per session.
    }

    // ─── Orchestration ──────────────────────────────────────────────────
    //
    // Owns the whole operation: the refusal paths, the walk, the assembly, the
    // download and the closing toast. Callers supply the rows and (optionally)
    // progress feedback, so the panel button and the console entry point
    // (__biliFavFix.backup.exportAll) behave identically.
    //
    // `rows` are index entries (buildBackupIndex shape — primitives only); the
    // caller passes a SNAPSHOT, so whatever the panel filter does afterwards
    // cannot change what this run writes. Resolves to a stats object, or null
    // when the export was refused before touching the store.
    //
    // opts:
    //   scope      { folder, folderTitle, query, sort } — recorded in the
    //              manifest and used to name the file
    //   metas      Map<media_id, meta record>; read from the store when absent
    //   onProgress function (done, total) — called per row, never after the
    //              last one

    // Export-vs-export exclusion, at module scope for the same reason
    // _backupRunning (15a-backup.js) is: the panel's s.exportBusy dies with the
    // panel state, yet closing the panel does NOT cancel a run — a read-only
    // job the user asked for walks to the end and still downloads. A panel
    // reopened during that run would otherwise be built with exportBusy false
    // and hand back an enabled export button, and __biliFavFix.backup.exportAll
    // bypasses the panel entirely. One flag covers all three combinations.
    var _exportRunning = false;

    // Guard wrapper only; everything else is in exportBackupRowsInner. The
    // release lives in a finally because the inner function has several refusal
    // paths and may throw: a flag left set would kill every later export for
    // the lifetime of the page.
    async function exportBackupRows(rows, opts) {
        if (_exportRunning) { toast('导出进行中，请稍后再试', 'warn'); return null; }
        _exportRunning = true;
        try {
            return await exportBackupRowsInner(rows, opts);
        } finally {
            _exportRunning = false;
            // A panel opened mid-run derives its export button from this flag
            // and has nothing else that would repaint it once the run ends.
            mgrExportReleased();
        }
    }

    async function exportBackupRowsInner(rows, opts) {
        opts = opts || {};
        var scope = opts.scope || { folder: '*', folderTitle: null, query: '', sort: 'none' };
        if (!rows || !rows.length) { toast('没有可导出的备份条目', 'warn'); return null; }
        // A backup walk rewrites the very records about to be read, so an
        // export overlapping one would ship a mixed-generation snapshot: some
        // rows from before the walk, some from after. Refuse instead of
        // explaining. The reverse order — a walk started after this export
        // began — is left alone as a known benign race; guarding it would mean
        // a global lock for no practical gain.
        if (_backupRunning) { toast('备份进行中，请稍后导出', 'warn'); return null; }
        // Same argument for the merge direction: an import rewrites records
        // this walk is in the middle of reading. The flag lives in
        // 15d-backup-import.js and is visible here through var hoisting across
        // the concatenated IIFE.
        if (_importRunning) { toast('导入进行中，请稍后导出', 'warn'); return null; }

        // Pre-flight, before a single record is read: with no ZIP64 records an
        // over-cap archive is not a write error but a file that silently fails
        // to open elsewhere. The instruction is actionable — the panel's folder
        // filter is exactly the tool for splitting the job.
        if (rows.length + 2 >= EXPORT_MAX_ENTRIES) {
            toast('条目过多（' + rows.length + ' 项），请按收藏夹分批导出', 'warn');
            return null;
        }
        var estimate = rows.length * EXPORT_JSON_BYTES_PER_ITEM;
        for (var p = 0; p < rows.length; p++) estimate += rows[p].cover_size || 0;
        if (estimate > EXPORT_MAX_BYTES) {
            toast('预计体积约 ' + fmtBytes(estimate) + '，超出单个 ZIP 上限，请按收藏夹分批导出', 'warn');
            return null;
        }

        var metas = opts.metas;
        if (!metas) {
            // No panel to borrow the map from (console entry point). A failure
            // here only costs the folders section its titles, so it degrades
            // rather than aborting the export.
            metas = new Map();
            try {
                await idbCursorEach(BACKUP_STORE_META, function (rec) {
                    if (rec && rec.media_id != null) metas.set(String(rec.media_id), rec);
                });
            } catch (e) { warn('export: meta read failed', e && e.message); }
        }

        var items = [], coverEntries = [], folderIds = new Set();
        var missing = 0, coverFailed = 0, coverBytes = 0;
        var total = rows.length;
        for (var i = 0; i < total; i++) {
            if (opts.onProgress) opts.onProgress(i, total);
            var av = String(rows[i].av);
            var rec = null;
            try { rec = await idbGet(BACKUP_STORE_ITEMS, av); }
            catch (e) { warn('export: record read failed for av', av, e && e.message); }
            // The index was built by an earlier cursor walk, so a record
            // deleted (or unreadable) since then is counted and skipped. A
            // partial archive with an honest count beats no archive at all.
            if (!rec) { missing++; continue; }

            var meta = exportItemMeta(rec);
            for (var m = 0; m < meta.media_ids.length; m++) folderIds.add(String(meta.media_ids[m]));
            if (rec.cover_blob) {
                var name = 'covers/' + av + '.' + exportCoverExt(rec.cover_type);
                try {
                    // The ONE point where cover bytes enter the heap, and only
                    // because CRC-32 cannot be computed without reading them.
                    // One cover at a time (~300 KB), released as soon as the
                    // checksum is in; the entry keeps the Blob HANDLE, which
                    // the assembly step consumes without reading it again.
                    var bytes = new Uint8Array(await rec.cover_blob.arrayBuffer());
                    coverEntries.push(zipEntry(name, crc32Bytes(bytes), bytes.length, rec.cover_blob));
                    coverBytes += bytes.length;
                    meta.cover_file = name;
                } catch (e) {
                    // A file-backed handle whose underlying file the browser
                    // reclaimed. The metadata is still perfectly good, so the
                    // item ships with cover_file null instead of failing the
                    // whole export over one image.
                    coverFailed++;
                    warn('export: cover read failed for av', av, e && e.message);
                }
            }
            items.push(meta);
        }
        if (opts.onProgress) opts.onProgress(total, total);

        var when = new Date();
        var enc = zipEncoder();
        // Indented on purpose: both members are meant to be opened and read by
        // a human, and at 1–3 MB the whole string is cheap to hold once.
        var itemsJson = enc.encode(JSON.stringify(items, null, 2));
        var manifest = {
            format:         'bili-fav-fix-backup',
            format_version: EXPORT_FORMAT_VERSION,
            exported_at:    when.toISOString(),
            // Recorded because the backup DB is origin-scoped: a container
            // exported on space.bilibili.com describes a different database
            // than one exported on www.bilibili.com.
            origin:         location.origin,
            core_version:   CORE_VERSION,
            scope: {
                folder:       scope.folder || '*',
                folder_title: scope.folderTitle || null,
                query:        scope.query || '',
                sort:         scope.sort || 'none'
            },
            counts: {
                items:        items.length,
                covers:       coverEntries.length,
                cover_bytes:  coverBytes,
                missing:      missing,
                cover_failed: coverFailed
            },
            folders: exportFolders(folderIds, metas)
        };
        var manifestJson = enc.encode(JSON.stringify(manifest, null, 2));

        // manifest.json and items.json lead the archive: a reader opening the
        // container streamwise meets the self-description before the payload.
        var entries = [
            zipEntry('manifest.json', crc32Bytes(manifestJson), manifestJson.length, manifestJson),
            zipEntry('items.json', crc32Bytes(itemsJson), itemsJson.length, itemsJson)
        ].concat(coverEntries);

        var blob = zipAssemble(entries, when);
        var filename = 'bili-fav-backup_' + exportScopeLabel(scope)
                     + '_' + exportStamp(when) + '.zip';
        exportTriggerDownload(blob, filename);

        // Appended only when non-zero, and the whole toast drops to warn: both
        // counts mean the archive is thinner than the list the user selected,
        // which a plain success line would hide.
        var msg = '已导出 ' + items.length + ' 项（' + fmtBytes(blob.size) + '）';
        if (missing) msg += ' · 记录缺失 ' + missing;
        if (coverFailed) msg += ' · 封面读取失败 ' + coverFailed;
        toast(msg, (missing || coverFailed) ? 'warn' : 'ok');

        return {
            items: items.length, covers: coverEntries.length, coverBytes: coverBytes,
            missing: missing, coverFailed: coverFailed,
            bytes: blob.size, filename: filename
        };
    }
