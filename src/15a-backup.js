    // ─── Manual backup to IndexedDB (pre-emptive snapshot) ──────────────
    //
    // Everything else in this script is AFTER-THE-FACT rescue: an item is
    // already invalid and we go begging android / public / biliplus /
    // jijidown for whatever snapshot they kept. This module is the opposite —
    // the user triggers it while the videos are still ALIVE and we copy the
    // whole folder (metadata AND the cover image BYTES) into IndexedDB. When
    // an item later dies, SOURCES.backup answers from local disk: no network,
    // no third party, no flap.
    //
    // Why IndexedDB and not GM storage: GM_setValue serializes to JSON, which
    // cannot hold a Blob. Cover bytes are the whole point (a metadata-only
    // backup still dies when bilibili's CDN purges the image), so the store
    // has to be one that persists structured-cloneable values.
    //
    // Cross-file invariants (see AGENTS.md):
    //   - The backup DB is NEVER touched by any cache-clearing path
    //     (clearAllItemCache / dropItemCaches / the "清除所有缓存" menu). Those
    //     clear DERIVED data that can be re-fetched; a backup cannot.
    //   - IndexedDB is origin-scoped. space.bilibili.com and www.bilibili.com
    //     therefore keep SEPARATE backup databases; a folder backed up on one
    //     origin does not restore on the other. Documented, not worked around.
    //   - Adding SOURCES.backup changes merge semantics, so CACHE_VERSION was
    //     bumped (07-cache.js) — otherwise entries cached before this feature
    //     would never consult the backup.
    //   - Writing an item is an UPSERT WITH CARRY-FORWARD, never a blind
    //     full-record replace. idbPut() replaces the whole record, so every
    //     field a re-run cannot re-derive (above all the cover Blob) must be
    //     read from the stored record and copied into the new one first. A
    //     backup is the user's only copy; a re-run that finds less than the
    //     last one must degrade to "kept what we had", never to data loss.

    var BACKUP_DB_NAME     = 'bili-fav-fix-backup';
    var BACKUP_DB_VERSION  = 1;
    var BACKUP_STORE_ITEMS = 'items';
    var BACKUP_STORE_META  = 'meta';

    // Walk limits. 500 pages x ps=20 = 10000 items: far above MAX_PAGE_WALK
    // (which bounds the *rescue* walks, where a long walk delays a DOM patch)
    // because a backup is an explicit, user-initiated, one-off operation and
    // truncating it silently loses data the user asked us to keep.
    var BACKUP_MAX_PAGES        = 500;
    var BACKUP_PAGE_DELAY_MS    = 300;   // politeness gap between folder pages
    var BACKUP_BLOB_CONCURRENCY = 3;     // parallel cover downloads
    var BACKUP_PROGRESS_EVERY   = 3;     // toast every N pages (page 1 always)

    // ─── IndexedDB plumbing ─────────────────────────────────────────────
    // Lazy single open, promise-wrapped. No third-party wrapper library: the
    // four operations below are all this feature needs, and the core ships as
    // one inlined IIFE where every extra KB is downloaded on each page load.

    var _backupDbPromise = null;

    function backupDb() {
        if (_backupDbPromise) return _backupDbPromise;
        _backupDbPromise = new Promise(function (resolve, reject) {
            if (typeof indexedDB === 'undefined') {
                reject(new Error('IndexedDB unavailable in this context'));
                return;
            }
            var req = indexedDB.open(BACKUP_DB_NAME, BACKUP_DB_VERSION);
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains(BACKUP_STORE_ITEMS)) {
                    // keyPath 'av' is a STRING everywhere (String(oid)), matching
                    // the GM cache key type so the two layers can be compared
                    // without coercion surprises.
                    var items = db.createObjectStore(BACKUP_STORE_ITEMS, { keyPath: 'av' });
                    items.createIndex('bvid', 'bvid', { unique: false });
                }
                if (!db.objectStoreNames.contains(BACKUP_STORE_META)) {
                    db.createObjectStore(BACKUP_STORE_META, { keyPath: 'media_id' });
                }
            };
            req.onsuccess  = function () { resolve(req.result); };
            req.onerror    = function () { reject(req.error || new Error('indexedDB.open failed')); };
            req.onblocked  = function () { reject(new Error('indexedDB.open blocked by another tab')); };
        });
        // Never cache a REJECTED open: a transient failure (private-mode quota,
        // a blocked upgrade from another tab) would otherwise disable the
        // backup for the rest of the page's life.
        _backupDbPromise.catch(function () { _backupDbPromise = null; });
        return _backupDbPromise;
    }

    function idbReq(req) {
        return new Promise(function (resolve, reject) {
            req.onsuccess = function () { resolve(req.result); };
            req.onerror   = function () { reject(req.error || new Error('IndexedDB request failed')); };
        });
    }

    function idbGet(store, key) {
        return backupDb().then(function (db) {
            return idbReq(db.transaction(store, 'readonly').objectStore(store).get(key));
        });
    }

    function idbPut(store, value) {
        return backupDb().then(function (db) {
            return idbReq(db.transaction(store, 'readwrite').objectStore(store).put(value));
        });
    }

    // Deletion lives in the storage layer next to get/put, but it is NEVER
    // called by any cache-clearing path (see the invariants at the top of this
    // file). Its only caller is the backup manager panel (15b), where the user
    // explicitly asks for a record to go away — and that caller must also drop
    // the two derived layers keyed off the same av, or the deleted snapshot
    // keeps restoring cards. See AGENTS.md gotcha 20.
    function idbDelete(store, key) {
        return backupDb().then(function (db) {
            return idbReq(db.transaction(store, 'readwrite').objectStore(store).delete(key));
        });
    }

    function idbCount(store) {
        return backupDb().then(function (db) {
            return idbReq(db.transaction(store, 'readonly').objectStore(store).count());
        });
    }

    // Cursor walk — the only way to aggregate over the store without loading
    // every Blob-bearing record into memory at once.
    function idbCursorEach(store, fn) {
        return backupDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var req = db.transaction(store, 'readonly').objectStore(store).openCursor();
                req.onsuccess = function () {
                    var cur = req.result;
                    if (!cur) { resolve(); return; }
                    try { fn(cur.value); } catch (e) { reject(e); return; }
                    cur.continue();
                };
                req.onerror = function () { reject(req.error || new Error('cursor failed')); };
            });
        });
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function backupSleep(ms) {
        return new Promise(function (r) { setTimeout(r, ms); });
    }

    // bilibili cover URLs carry an "@<w>w_<h>h.webp"-style transform suffix.
    // Strip it so the stored bytes are the ORIGINAL image (and so the
    // cover_url equality check that skips a re-download is stable across
    // layouts that request different thumbnail sizes).
    function stripCoverSuffix(url) {
        if (!url) return '';
        var m = String(url).match(/^([^@]*)@/);
        return (m ? m[1] : String(url)).replace(/^http:\/\//, 'https://');
    }

    function fmtBytes(n) {
        if (!n) return '0 B';
        var u = ['B', 'KB', 'MB', 'GB'], i = 0;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
    }

    // First candidate whose value passes the SAME QUALITY predicate the merge
    // layer uses — so a placeholder cover or an "已失效视频" title never wins
    // just because its source came first. Candidates may be null (skipped).
    function backupPick(candidates, key) {
        var q = QUALITY[key] || QUALITY['default'];
        for (var i = 0; i < candidates.length; i++) {
            var c = candidates[i];
            if (!c) continue;
            var v = c[key];
            if (q(v) > 0) return v;
        }
        return undefined;
    }

    var _persistAsked = false;
    function requestPersistentStorageOnce() {
        if (_persistAsked) return;
        _persistAsked = true;
        try {
            if (!navigator.storage || !navigator.storage.persist) return;
            // Fire-and-forget: without a persistence grant the browser may evict
            // the DB under storage pressure. Nothing to do if it is denied —
            // an evicted backup degrades to "no backup", not to a broken script.
            navigator.storage.persist().then(function (granted) {
                console.info('[fav-fix/backup] navigator.storage.persist() →', granted);
            }).catch(function (e) { warn('backup persist() rejected:', e && e.message); });
        } catch (e) { warn('backup persist() threw:', e && e.message); }
    }

    // ─── Backup walker ──────────────────────────────────────────────────

    var _backupRunning = false;

    // Build the record we would store for one live list item, or null if the
    // item must be skipped. Reads the existing record so an unchanged cover is
    // NOT re-downloaded (a re-run over a large folder is then metadata-only).
    async function buildBackupRecord(item, mediaId, stats) {
        var av = String(item.oid);
        var liveOk = QUALITY.title(item.title) > 0 && QUALITY.cover(item.cover) > 0;
        var primary = item, fallback = null, dataSource = 'live';
        if (!liveOk) {
            // Already invalid at backup time. Not necessarily a loss: if the
            // rescue path previously recovered this av, the merged snapshot in
            // GM storage is real data worth persisting (GM entries expire;
            // the backup does not). Anything else is a genuine blank.
            var cached = loadCache(av);
            if (!cached || !(cached._src_cover || cached._src_title)) {
                stats.skipped_invalid++;
                return null;
            }
            primary = cached; fallback = item; dataSource = 'merged';
        }

        // Title / cover URLs come from THIS run only. The stored record is
        // deliberately NOT a candidate here: re-picking the archived URL as if
        // it were fresh evidence would defeat the "has the cover changed?"
        // check below. It is still never DISCARDED — the bytes it already
        // holds are carried forward a few lines down.
        var title = backupPick([primary, fallback], 'title');
        var coverUrl = stripCoverSuffix(backupPick([primary, fallback], 'cover'));
        // Final placeholder gate. Everything above already applies QUALITY, but
        // this store is meant to be trustworthy FOREVER — one placeholder cover
        // or "已失效视频" title written here would be served back as gospel by
        // SOURCES.backup at the top of FIELD_PRIORITY, permanently outranking
        // the live sources. Cheap belt-and-braces.
        if (coverUrl && COVER_PLACEHOLDER_RE.test(coverUrl)) coverUrl = '';
        if (!title || String(title).trim() === INVALID_TITLE) {
            stats.skipped_invalid++;
            return null;
        }

        // The stored record has to be READ before it can be safely rewritten:
        // idbPut replaces the record wholesale, and the cover bytes in it have
        // no upstream to re-fetch from. If the read fails we do not know what
        // is already archived, so any write would be a blind overwrite — skip
        // the av entirely and let the next run try again (this also stops
        // media_ids from being truncated to the current folder).
        var existing = null;
        try { existing = await idbGet(BACKUP_STORE_ITEMS, av); }
        catch (e) {
            warn('backup: idbGet failed for av', av, e && e.message);
            stats.read_failed++;
            return null;
        }

        // Secondary fields fall back to the STORED record last: re-running a
        // backup after an item went invalid must never downgrade a field we
        // already captured while it was alive (the merged rescue snapshot
        // carries fewer fields than the live listing).
        var chain = [primary, fallback, existing];
        var upper = backupPick(chain, 'upper');
        var mediaIds = (existing && Array.isArray(existing.media_ids)) ? existing.media_ids.slice() : [];
        if (mediaIds.indexOf(Number(mediaId)) < 0) mediaIds.push(Number(mediaId));

        // Cover bytes are the one thing in this store with NO upstream to
        // re-fetch from, and idbPut replaces the whole record — so the new
        // record STARTS from whatever is already archived and is overwritten
        // only when this run actually holds replacement bytes (see
        // commitBackupRecord). Seeding these four fields with nulls instead
        // would delete a good image every time the item has since died (no
        // cover left to re-derive) or the CDN refuses today's download.
        // cover_url always travels WITH the bytes it describes: while an old
        // blob is being kept the stored URL stays the old one, so the next run
        // still sees url != coverUrl and re-queues the new image — the
        // self-healing retry survives.
        var keptBlob  = (existing && existing.cover_blob) || null;
        var storedUrl = keptBlob ? existing.cover_url
                                 : (coverUrl || (existing && existing.cover_url) || null);

        var rec = {
            av:        av,
            bvid:      backupPick(chain, 'bvid') || null,
            title:     title,
            intro:     backupPick(chain, 'intro') || '',
            upper:     upper ? { mid: upper.mid, name: upper.name, face: upper.face } : null,
            cnt_info:  backupPick(chain, 'cnt_info') || null,
            tid:       backupPick(chain, 'tid'),
            duration:  backupPick(chain, 'duration'),
            pubtime:   backupPick(chain, 'pubtime'),
            ctime:     backupPick(chain, 'ctime'),
            fav_time:  backupPick(chain, 'fav_time'),
            pages:     backupPick(chain, 'pages'),
            page:      backupPick(chain, 'page'),
            link:      backupPick(chain, 'link') || '',
            cover_url:  storedUrl,
            cover_blob: keptBlob,
            cover_type: keptBlob ? (existing.cover_type || null) : null,
            cover_size: keptBlob ? (existing.cover_size || 0) : 0,
            media_ids:  mediaIds,
            backed_at:  Date.now(),
            data_source: dataSource
        };

        // Re-download only when the bytes we hold no longer match the URL we
        // just saw (or we never got them). A missing blob is retried on every
        // subsequent run for free — that is the intended self-healing path for
        // a cover the CDN refused today.
        var reuse = !!(keptBlob && existing.cover_url === coverUrl);
        var fetchUrl = (!reuse && coverUrl) ? coverUrl : null;
        // Archived image kept without even attempting a replacement, i.e. this
        // run produced no usable cover URL at all (the item died since the last
        // backup). Counted separately so a run that quietly stopped refreshing
        // covers is not reported as a plain 更新.
        if (keptBlob && !reuse && !fetchUrl) stats.cover_kept++;
        // metaOnly = an entry that already existed and needs no download, i.e.
        // the "更新" bucket. A brand-new entry counts as "新增" even when it
        // carries no cover at all (title-only merged records).
        return { rec: rec, fetchUrl: fetchUrl, keptBlob: !!keptBlob,
                 metaOnly: !fetchUrl && !!existing };
    }

    async function commitBackupRecord(task, stats) {
        if (task.fetchUrl) {
            try {
                var blob = await gmGetBlob(task.fetchUrl);
                // URL and bytes are replaced as ONE unit — cover_url must always
                // describe the image actually stored, otherwise the reuse check
                // in buildBackupRecord would skip re-downloading a cover we
                // never obtained.
                task.rec.cover_url  = task.fetchUrl;
                task.rec.cover_blob = blob;
                task.rec.cover_type = blob.type || null;
                task.rec.cover_size = blob.size || 0;
            } catch (e) {
                // Leave the carried-forward fields alone. Deleting the only
                // copy of an already-archived cover because today's download
                // failed is unrecoverable; the record keeps the OLD url+bytes,
                // so the next run again sees url != coverUrl and re-queues the
                // new image. When nothing was archived yet, cover_blob simply
                // stays null and the URL is retried on the next run.
                stats.blob_failed++;
                if (task.keptBlob) stats.cover_kept++;
                warn('backup: cover fetch failed for av', task.rec.av, e && e.message);
            }
        }
        if (task.metaOnly) stats.updated++;
        else stats.backed++;
        try { await idbPut(BACKUP_STORE_ITEMS, task.rec); }
        catch (e) { warn('backup: idbPut failed for av', task.rec.av, e && e.message); }
    }

    async function backupPageItems(list, mediaId, stats) {
        var tasks = [];
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            if (!item || item.oid == null) continue;
            stats.total_seen++;
            var t = await buildBackupRecord(item, mediaId, stats);
            if (t) tasks.push(t);
        }
        // Bounded parallelism for the cover downloads: serial is needlessly
        // slow on a 200-item folder, unbounded hammers the CDN.
        for (var j = 0; j < tasks.length; j += BACKUP_BLOB_CONCURRENCY) {
            var chunk = tasks.slice(j, j + BACKUP_BLOB_CONCURRENCY);
            await Promise.all(chunk.map(function (t) { return commitBackupRecord(t, stats); }));
        }
    }

    // Entry point for both the Tampermonkey menu command and
    // __biliFavFix.backup.run().
    async function backupCurrentFolder() {
        if (_backupRunning) { toast('备份正在进行中', 'warn'); return null; }
        if (typeof indexedDB === 'undefined') {
            toast('当前环境不支持 IndexedDB，无法备份', 'err');
            return null;
        }
        var mediaId = detectMediaId();
        if (!mediaId) { toast('无法识别当前收藏夹 ID', 'err'); return null; }

        _backupRunning = true;
        requestPersistentStorageOnce();
        var stats = {
            total_seen: 0, backed: 0, updated: 0, skipped_invalid: 0,
            blob_failed: 0, cover_kept: 0, read_failed: 0
        };
        var aborted = false;
        var folderTitle = null;
        try {
            toast('开始备份当前收藏夹');
            var pn = 1;
            while (pn <= BACKUP_MAX_PAGES) {
                // Walk `public` DIRECTLY, bypassing ensurePage/pageCache. Same
                // reasoning as the flap loop (AGENTS.md gotcha 16b): we want a
                // fresh server sample, and a long backup walk must not poison
                // the foreground resolver's page cache. `public` (not android)
                // because a backup runs while the items are still valid, and
                // public carries the fuller field set (pubtime / fav_time /
                // tid / pages) that the android endpoint omits.
                var page = null;
                for (var attempt = 0; attempt < 2 && !page; attempt++) {
                    try { page = await SOURCES['public'].fetchPage({ mediaId: mediaId, pn: pn }); }
                    catch (e) {
                        warn('backup: page ' + pn + ' attempt ' + (attempt + 1) + ' failed:', e.message);
                        if (attempt === 0) await backupSleep(1000);
                    }
                }
                if (!page) {
                    aborted = true;
                    toast('备份中止：第 ' + pn + ' 页抓取失败，已写入的数据保留', 'err');
                    break;
                }
                if (!folderTitle && page.folderTitle) folderTitle = page.folderTitle;
                await backupPageItems(page.list || [], mediaId, stats);
                // Every page would out-run the toast's own 4.5s lifetime and
                // stack overlapping banners; every 3rd page keeps the feedback
                // continuous without piling up.
                if (pn % BACKUP_PROGRESS_EVERY === 0) {
                    toast('备份中：第 ' + pn + ' 页，已处理 ' + stats.total_seen + ' 项');
                }
                if (!page.has_more) break;
                pn++;
                await backupSleep(BACKUP_PAGE_DELAY_MS);
            }
            if (!aborted) {
                var summary = '备份完成：新增 ' + stats.backed + ' · 更新 ' + stats.updated
                            + ' · 跳过失效 ' + stats.skipped_invalid
                            + ' · 封面失败 ' + stats.blob_failed;
                // Appended only when non-zero: both mean "this run did not
                // refresh everything it looked at", which the plain 更新 count
                // would otherwise hide.
                if (stats.cover_kept)  summary += ' · 沿用旧封面 ' + stats.cover_kept;
                if (stats.read_failed) summary += ' · 读取失败 ' + stats.read_failed;
                toast(summary, 'ok');
            }
            return stats;
        } finally {
            _backupRunning = false;
            // A run just turned "no local data for this av" into "there is
            // now", so the credential-less restore path must re-check
            // (14-orchestrate.js); nothing else invalidates that memo without
            // a page load.
            _localOnlyMiss.clear();
            await writeBackupMeta(mediaId, stats, aborted, pn, folderTitle);
        }
    }

    // The meta record is the ONLY per-folder answer to "when was this folder
    // last backed up in full"; the manager panel's footer reads it. An aborted walk must
    // therefore not overwrite a previous COMPLETE run's figures with its own
    // truncated ones — that would report a 40-of-300 failure as a fresh 40-item
    // backup and hide the fact that the folder still needs a full pass. Keep
    // the last complete run intact and record the failed attempt beside it.
    async function writeBackupMeta(mediaId, stats, aborted, lastPage, folderTitle) {
        var key = String(mediaId);
        var prev = null;
        try { prev = await idbGet(BACKUP_STORE_META, key); }
        catch (e) { warn('backup: meta read failed', e && e.message); }
        var rec;
        if (aborted && prev) {
            rec = {};
            for (var k in prev) rec[k] = prev[k];
        } else {
            // A completed walk, or an abort with no earlier run to preserve
            // (recording the partial figures beats recording nothing — the
            // partial flag below keeps the readout honest either way).
            rec = {
                media_id:        key,
                last_run:        Date.now(),
                total_seen:      stats.total_seen,
                backed:          stats.backed,
                updated:         stats.updated,
                skipped_invalid: stats.skipped_invalid,
                blob_failed:     stats.blob_failed,
                cover_kept:      stats.cover_kept,
                read_failed:     stats.read_failed
            };
        }
        rec.media_id             = key;
        // Folder display name for the manager panel's dropdown. Any run that
        // learned it (even an aborted one — page 1 usually succeeded) records
        // it; otherwise whatever a previous run stored is kept via the prev
        // copy above.
        rec.title                = folderTitle || rec.title || null;
        rec.last_attempt         = Date.now();
        rec.last_attempt_partial = !!aborted;
        rec.last_attempt_page    = aborted ? (lastPage || 0) : 0;
        try { await idbPut(BACKUP_STORE_META, rec); }
        catch (e) { warn('backup: meta write failed', e && e.message); }
    }

    // ─── Status ─────────────────────────────────────────────────────────

    async function backupStatus() {
        var out = {
            items: 0, coverBytes: 0, withCover: 0,
            quotaUsed: null, quota: null, folder: null
        };
        out.items = await idbCount(BACKUP_STORE_ITEMS);
        await idbCursorEach(BACKUP_STORE_ITEMS, function (rec) {
            if (rec && rec.cover_size) { out.coverBytes += rec.cover_size; out.withCover++; }
        });
        try {
            if (navigator.storage && navigator.storage.estimate) {
                var est = await navigator.storage.estimate();
                out.quotaUsed = est.usage;
                out.quota = est.quota;
            }
        } catch (e) { warn('backup: storage.estimate failed', e && e.message); }
        var mid = detectMediaId();
        if (mid) {
            try { out.folder = (await idbGet(BACKUP_STORE_META, String(mid))) || null; }
            catch (e) { warn('backup: meta read failed', e && e.message); }
        }
        return out;
    }

    // (The old 查看备份状态 menu toast was folded into the manager panel:
    // global totals + browser quota live in the panel header, per-folder
    // last-run info in its footer. backupStatus() stays for the debug
    // surface — __biliFavFix.backup.status().)

    // ─── Cover fallback for the DOM layer ───────────────────────────────
    // Used by patchCover (09-dom.js) when the recovered cover URL 404s: the
    // metadata outlived the image on bilibili's CDN, but our own copy of the
    // bytes did not. Resolves to null when we have nothing.
    function backupCoverObjectUrl(av) {
        if (typeof indexedDB === 'undefined') return Promise.resolve(null);
        return idbGet(BACKUP_STORE_ITEMS, String(av)).then(function (rec) {
            if (!rec || !rec.cover_blob) return null;
            // Not revoked: the number of live objectURLs is bounded by the
            // number of dead-cover cards on one page, and revoking early would
            // blank the <img> the moment bilibili's virtual scroller re-renders.
            return URL.createObjectURL(rec.cover_blob);
        });
    }

    // ─── Source registration ────────────────────────────────────────────
    // Registered at load time (this module runs after 05-sources.js, so
    // `SOURCES` is already initialized — see AGENTS.md on MANIFEST ordering).
    // Queried by the resolver in PHASE 0, before any network source, and
    // ranked first in FIELD_PRIORITY for every field it supplies: a backup was
    // captured while the video was alive, so it is strictly better evidence
    // than any post-mortem snapshot.
    SOURCES.backup = {
        name: 'backup',
        paginated: false,
        enabled: function () { return typeof indexedDB !== 'undefined'; },
        fetchAvs: async function (avs) {
            var out = new Map();
            if (!avs || !avs.length) return out;
            for (var i = 0; i < avs.length; i++) {
                var av = String(avs[i]);
                var rec;
                try { rec = await idbGet(BACKUP_STORE_ITEMS, av); }
                catch (e) {
                    // A dead DB fails identically for every remaining av —
                    // stop rather than repeat the same error N times.
                    warn('backup: lookup aborted at av', av, e && e.message);
                    break;
                }
                if (!rec) continue;
                // Deliberately NOT returned: `attr` and `link`. Those describe
                // the item's CURRENT state / navigation target, which the live
                // sources own; a stale backed-up `attr` would tell the UI a
                // dead video is still valid.
                out.set(av, {
                    oid:      Number(av),
                    bvid:     rec.bvid || undefined,
                    title:    rec.title,
                    cover:    rec.cover_url || undefined,
                    intro:    rec.intro || undefined,
                    duration: rec.duration,
                    upper:    rec.upper || undefined,
                    cnt_info: rec.cnt_info || undefined,
                    tid:      rec.tid,
                    pubtime:  rec.pubtime,
                    ctime:    rec.ctime,
                    fav_time: rec.fav_time,
                    pages:    rec.pages,
                    page:     rec.page
                });
            }
            if (out.size) console.info('[fav-fix/backup] restored', out.size, 'of', avs.length, 'av(s) from local backup');
            return out;
        }
    };
