    // ─── Promotion pipeline (recovery → backup store) ───────────────────
    //
    // The GM item cache is the wrong resting place for a confident recovery:
    // it expires (cfg('cacheTtlDays')), it is invisible to the manager panel,
    // and it is not covered by export/import — while the third-party source
    // that produced the recovery may already be dead by the time the cache
    // entry lapses. This module copies recoveries into the IndexedDB backup
    // store at recovery time, so the store becomes the durable single source
    // of truth. Two record shapes come out of it:
    //   data_source 'restored'      — full recovery (cover bytes REQUIRED;
    //                                 a record whose cover fetch failed is
    //                                 not stored, never demoted to meta).
    //   data_source 'restored_meta' — title-only recovery (_src_title, no
    //                                 _src_cover): an empty cover quad on
    //                                 purpose. Post-D3 SOURCES.backup serves
    //                                 no cover for it, so it merges back as
    //                                 _cover_pending and the flap loop keeps
    //                                 chasing the image; when one lands, the
    //                                 FULL path upgrades the same record.
    //
    // Hooks: both resolver saveCache sites (08-resolver.js — the merge block
    // and the flap loop's promotion pass) call maybePromoteRecovered(). The
    // classifier decides FULL / META / no-op internally; the call sites stay
    // condition-free. The credential-less restoreLocalOnly path never reaches
    // either hook (it neither resolves nor runs the loop), so promotion can
    // never fire without a login — by construction, not by a flag.
    //
    // Every 15a store invariant applies unchanged and is REUSED, not copied:
    // idbGet before put (read failure = skip, never a blind overwrite), the
    // cover quad as one unit via backupCoverCarryForward, media_ids union via
    // backupUnionMediaIds, byte-less writes refused via commitBackupRecord's
    // requireBytes, and the meta store NEVER touched (its records mean "last
    // complete walk"; a promotion is not a walk).
    //
    // Concurrency: promotion neither takes nor blocks the three bulk-op
    // mutexes — it DEFERS while any of _backupRunning / _importRunning /
    // _exportRunning is held (their finallys call drainPromoteQueue() to
    // resume promptly), and bounds its own cover downloads at
    // cfg('backupBlobConcurrency'). A deferred task is not lost: it sits in
    // the queue, and even a dropped queue self-heals on the next resolve.

    var _promoteQueue    = [];         // pending tasks {av, merged, mediaId, kind, mig}
    var _promoteInFlight = new Set();  // avs queued or running — dedup
    var _promoteActive   = 0;          // promoteOne bodies currently running
    // Avs whose promotion was cancelled by a panel delete while the task was
    // already RUNNING (a queued task is simply removed instead). The running
    // task checks this right before its idbPut — the cover-fetch await is a
    // seconds-wide window in which the user can delete the very record being
    // promoted, and the delete must win (see promoteCancelAv).
    var _promoteCancelled = new Set();

    // Task-kind precedence for the queued-task upgrade in enqueuePromotion:
    // a FULL promotion supersedes a queued META, and either supersedes a
    // queued folder-accrual (the reverse never downgrades — a FULL/META
    // write already unions the folder, so nothing is lost in the upgrade).
    var PROMOTE_KIND_RANK = { full: 3, meta: 2, accrue: 1 };

    // Folder-accrual memo, keyed `mediaId|av`, session-scoped. A cache-hit
    // resolve (or a backup-served merge that cheap-skips promotion) fires on
    // every folder visit; without the memo each debounced tick would re-queue
    // the same no-op accrual.
    var _accrued = new Set();

    var PROMOTE_MIGRATED_FLAG = 'promote:migrated:v7';

    // Live migration bookkeeping: null except between runPromotionMigration()
    // and the settling of its last task, when ONE summary toast fires.
    // Runtime promotions are silent (log only) — the card is already visibly
    // recovered; a per-card toast would spam.
    var _migStats = null;

    // FULL / META / null classifier, shared by the runtime hooks and the
    // migration. `bypassSkips` (migration only) disables the two runtime
    // cheap-skips: under CACHE_VERSION 7 semantics a backup-sourced cover
    // implies bytes in the store and a backup-sourced title implies the store
    // already owns it, so re-promoting is pointless — but v6 entries carry no
    // such guarantee, so the migration classifies them all and lets
    // promoteOne's idbGet + value-compare do the real idempotence work.
    function promoteClassify(rec, bypassSkips) {
        if (!rec) return null;
        if (promotionGate(rec)) {
            if (!bypassSkips && rec._src_cover === 'backup' && rec._src_title === 'backup') return null;
            return 'full';
        }
        if (rec._src_title && !rec._src_cover) {
            if (!bypassSkips && rec._src_title === 'backup') return null;
            return 'meta';
        }
        return null;
    }

    // The single runtime entry point, called after each resolver saveCache.
    // Fire-and-forget and cheap on the no-op path (two flag reads + the
    // classifier) — it must never block first paint or the flap loop.
    function maybePromoteRecovered(av, rec, mediaId) {
        if (!cfg('autoPromoteRestored')) return;
        if (typeof indexedDB === 'undefined') return;
        var kind = promoteClassify(rec, false);
        if (!kind) {
            // Not promotable — most commonly a merge served entirely from the
            // backup store (the cheap-skips above). The record's FOLDER
            // MEMBERSHIP must still accrete, or an av backed up in folder A
            // and later viewed in folder B would never gain B in media_ids
            // (panel filter and export grouping would omit it there). Only on
            // this null path, so an accrual can never displace a FULL/META.
            maybeAccrueFolder(av, mediaId);
            return;
        }
        enqueuePromotion({ av: String(av), merged: rec, mediaId: mediaId, kind: kind, mig: false });
    }

    // Enqueue a media_ids-only union of the current folder into an EXISTING
    // record. Routed through the same queue as the real promotions so the
    // bulk-op deferral, the per-av cancel and the quiesce wait all apply to
    // it. Hooked from the maybePromoteRecovered null path (above) and from
    // patchOnceInner's cache-hit fast path (14-orchestrate.js) — the two
    // paths a confident av takes on every visit AFTER the one that promoted
    // it. Deliberately NOT hooked from restoreLocalOnly: the credential-less
    // path stays write-free.
    function maybeAccrueFolder(av, mediaId) {
        if (mediaId == null) return;
        if (!cfg('autoPromoteRestored')) return;
        if (typeof indexedDB === 'undefined') return;
        var key = String(mediaId) + '|' + String(av);
        if (_accrued.has(key)) return;
        _accrued.add(key);
        enqueuePromotion({ av: String(av), merged: null, mediaId: mediaId, kind: 'accrue', mig: false });
    }

    function enqueuePromotion(task) {
        if (_promoteInFlight.has(task.av)) {
            // Dedup hit. If the earlier task is still QUEUED, upgrade it in
            // place when the newcomer outranks it — a FULL arriving while a
            // META waits out a bulk op (the flap loop keeps running during
            // walks/imports) must not be dropped, or the recovered cover
            // would land in the store as a byteless restored_meta and not be
            // chased again until the GM cache lapses. `mig` is kept from the
            // queued task so the migration settle counting stays correct.
            for (var i = 0; i < _promoteQueue.length; i++) {
                var q = _promoteQueue[i];
                if (q.av !== task.av) continue;
                if ((PROMOTE_KIND_RANK[task.kind] || 0) > (PROMOTE_KIND_RANK[q.kind] || 0)) {
                    q.kind    = task.kind;
                    q.merged  = task.merged;
                    q.mediaId = task.mediaId;
                }
                return;
            }
            // Already RUNNING (in flight, not queued): drop the newcomer.
            // Self-heals on the next cache-miss resolve — a byteless
            // restored_meta serves no cover, the merge re-lands
            // _cover_pending, and the loop re-chases with no competing task.
            return;
        }
        _promoteInFlight.add(task.av);
        _promoteQueue.push(task);
        drainPromoteQueue();
    }

    // Per-av cancellation, the fourth layer of the manager panel's delete
    // (15b deleteBackupAv): without it an in-flight or queued promotion for
    // the just-deleted av would idbPut the record right back — the delete
    // silently undone, the record reappearing in the panel and the export.
    // A queued task is removed outright; a running one is flagged so its
    // commitBackupRecord refuses the put (stillValid, checked after the
    // cover fetch — that await IS the race window).
    function promoteCancelAv(av) {
        av = String(av);
        for (var i = _promoteQueue.length - 1; i >= 0; i--) {
            if (_promoteQueue[i].av !== av) continue;
            var t = _promoteQueue.splice(i, 1)[0];
            _promoteInFlight.delete(av);
            // A removed migration task still has to settle the counter, or
            // the migration summary toast would wait forever.
            if (t.mig) promoteMigrationSettled();
        }
        if (_promoteInFlight.has(av)) _promoteCancelled.add(av);
    }

    // Resolves once no promoteOne body is running. Bulk store writers
    // (backup walk, import) await this right after raising their flag: the
    // flag stops the drain from dispatching anything NEW, so this is bounded
    // by at most cfg('backupBlobConcurrency') in-flight cover fetches
    // finishing — without it, a promotion parked on a cover download could
    // resume after the bulk op wrote the same av and clobber that newer
    // record with its pre-op snapshot.
    function promoteQuiesce() {
        return new Promise(function (resolve) {
            (function check() {
                if (_promoteActive === 0) { resolve(); return; }
                setTimeout(check, 100);
            })();
        });
    }

    // Start queued tasks up to the concurrency cap. Deliberately a no-op
    // while a bulk store operation holds the DB — matching the existing
    // mutual-refusal pattern between backup / import / export rather than
    // adding a fourth lock they would all have to learn about.
    function drainPromoteQueue() {
        if (_backupRunning || _importRunning || _exportRunning) return;
        while (_promoteActive < cfg('backupBlobConcurrency') && _promoteQueue.length) {
            promoteRunTask(_promoteQueue.shift());
        }
    }

    // Named helper rather than an inline closure in the while loop above so
    // each task's completion callbacks capture THEIR task, not the loop var.
    function promoteRunTask(task) {
        _promoteActive++;
        promoteOne(task)
            .catch(function (e) { warn('promote: task threw for av', task.av, e && e.message); })
            .then(function () {
                _promoteActive--;
                _promoteInFlight.delete(task.av);
                // A cancel flag is only meaningful for the task it aborted;
                // a LATER promotion of the same av starts with a clean slate.
                _promoteCancelled.delete(task.av);
                if (task.mig) promoteMigrationSettled();
                drainPromoteQueue();
            });
    }

    async function promoteOne(task) {
        var av = task.av;
        // Cancelled while queued-then-dispatched in the same tick, or just
        // before dispatch: honour the delete before touching the store.
        if (_promoteCancelled.has(av)) return;
        // The store may have changed while the task sat in the queue (a walk,
        // an import, a panel delete). Read fresh; a failed read means we do
        // not know what is archived, and any write would be a blind overwrite
        // — skip, exactly like the walker's read_failed rule.
        var existing = null;
        try { existing = await idbGet(BACKUP_STORE_ITEMS, av); }
        catch (e) {
            warn('promote: idbGet failed for av', av, '— skipped:', e && e.message);
            return;
        }
        if (task.kind === 'accrue') {
            // Folder-membership bookkeeping ONLY: union the folder into an
            // existing record's media_ids and put it back. backed_at and
            // data_source are deliberately untouched — an accrual is
            // bookkeeping, not an observation, and stamping it would tell
            // the next backup run the record is fresher than it is.
            if (!existing) return;
            if (existing.media_ids && existing.media_ids.indexOf(Number(task.mediaId)) >= 0) return;
            existing.media_ids = backupUnionMediaIds(existing, task.mediaId);
            // Same delete-wins rule as the real promotions.
            if (_promoteCancelled.has(av)) return;
            try { await idbPut(BACKUP_STORE_ITEMS, existing); }
            catch (e2) { warn('promote: accrue idbPut failed for av', av, e2 && e2.message); }
            return;
        }
        // META write rule: never downgrade a byte-bearing record to a
        // coverless marker. (In normal flow this cannot even classify META —
        // a byte-backed record makes phase 0 serve the cover — so this guard
        // is for races and stale merges, and it is mandatory: the stored blob
        // has no upstream to re-fetch from.)
        if (task.kind === 'meta' && existing && existing.cover_blob) return;
        var built = buildRestoredRecord(av, task.merged, task.mediaId, existing, task.kind);
        if (!built) return;
        // No-op guard: an unchanged, already-stored record is not rewritten
        // (this is what makes re-promotion — and a re-run migration — free).
        // Only valid when no fresh cover download is due: with a fetchUrl the
        // pre-fetch candidate still carries the OLD quad and would compare
        // equal right before the fetch replaced it.
        if (!built.fetchUrl && promoteSameRecord(built.rec, existing)) return;
        // Re-checked by commitBackupRecord right before its idbPut: a panel
        // delete landing during the cover-fetch await must win over this
        // write (walker tasks carry no stillValid — deletes are panel-only
        // and the panel is locked while a walk runs).
        built.stillValid = function () { return !_promoteCancelled.has(av); };
        var st = { backed: 0, updated: 0, blob_failed: 0, cover_kept: 0, merged_nocover: 0 };
        var wrote = await commitBackupRecord(built, st);
        if (wrote) {
            // Same invalidation the walker and the importer do: the store just
            // turned "no local data for this av" into "there is now" — and the
            // logged-out hit memo may hold a merge this write supersedes.
            _localOnlyMiss.clear();
            _localOnlyHits.clear();
            log('promote:', task.kind, 'av', av, existing ? '(updated)' : '(new)');
        }
        if (task.mig && _migStats) {
            if (wrote) {
                _migStats.written++;
                if (task.kind === 'meta') _migStats.metaOnly++;
            } else if (st.merged_nocover) {
                _migStats.nocover++;
            }
        }
    }

    // Build the record a promotion would store — the 15e counterpart of the
    // walker's buildBackupRecord, sharing every invariant helper with it.
    // Field fallback chain is [merged, existing]: a promotion must never
    // downgrade a field the store already holds just because this recovery
    // carries fewer of them.
    function buildRestoredRecord(av, merged, mediaId, existing, kind) {
        var title = backupPick([merged], 'title');
        var coverUrl = kind === 'full' ? stripCoverSuffix(backupPick([merged], 'cover') || '') : '';
        // Same forever-store placeholder gate as the walker: one placeholder
        // written here would be served back as gospel by SOURCES.backup.
        if (coverUrl && COVER_PLACEHOLDER_RE.test(coverUrl)) coverUrl = '';
        if (!title || String(title).trim() === INVALID_TITLE) return null;   // defensive; classifier ensured a title
        var cf = backupCoverCarryForward(existing, coverUrl);
        var chain = [merged, existing];
        var upper = backupPick(chain, 'upper');
        // Provenance. FULL: 'restored' — except when the store already holds
        // bytes and no new download is due, where the existing record's own
        // label stands (a resolve re-confirming a walker capture must not
        // relabel it; without this the migration would sweep every backed-up
        // invalid item and stamp 'restored' over honest 'live' records).
        // META: 'restored_meta' — except a coverless 'live' record keeps its
        // label (alive at backup time, cover pending its own self-heal); a
        // legacy coverless 'merged' record upgrading to 'restored_meta' is
        // fine and more accurate.
        var ds;
        if (kind === 'full') {
            ds = (existing && existing.cover_blob && !cf.fetchUrl)
               ? (existing.data_source || 'live')
               : 'restored';
        } else {
            ds = (existing && (!existing.data_source || existing.data_source === 'live'))
               ? (existing.data_source || 'live')
               : 'restored_meta';
        }
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
            cover_url:  cf.storedUrl,
            cover_blob: cf.keptBlob,
            cover_type: cf.keptBlob ? (existing.cover_type || null) : null,
            cover_size: cf.keptBlob ? (existing.cover_size || 0) : 0,
            media_ids:  backupUnionMediaIds(existing, mediaId),
            backed_at:  Date.now(),
            data_source: ds
        };
        return { rec: rec, fetchUrl: cf.fetchUrl, keptBlob: !!cf.keptBlob,
                 metaOnly: !!existing, requireBytes: kind === 'full' };
    }

    // Material equality: everything except cover_blob identity (compared by
    // reference — carry-forward hands back the same handle, mirroring
    // importSameQuad in 15d), backed_at (a write stamp, not data) and
    // data_source (provenance labeling alone does not justify a write).
    // Explicit field list, not JSON of the whole record: records built by
    // different code paths do not guarantee a stable key order.
    function promoteSameRecord(cand, existing) {
        if (!existing) return false;
        if ((cand.cover_blob || null) !== (existing.cover_blob || null)) return false;
        var SCALARS = ['bvid', 'title', 'intro', 'tid', 'duration', 'pubtime',
                       'ctime', 'fav_time', 'page', 'link',
                       'cover_url', 'cover_type', 'cover_size'];
        for (var i = 0; i < SCALARS.length; i++) {
            var k = SCALARS[i];
            var a = cand[k] != null ? cand[k] : null;
            var b = existing[k] != null ? existing[k] : null;
            if (a !== b) return false;
        }
        // Small same-shape structures — JSON is stable enough here ('pages'
        // included because some endpoints return it as an array of parts).
        if (JSON.stringify(cand.upper    || null) !== JSON.stringify(existing.upper    || null)) return false;
        if (JSON.stringify(cand.cnt_info || null) !== JSON.stringify(existing.cnt_info || null)) return false;
        if (JSON.stringify(cand.pages != null ? cand.pages : null)
            !== JSON.stringify(existing.pages != null ? existing.pages : null)) return false;
        if (String(cand.media_ids || []) !== String(existing.media_ids || [])) return false;
        return true;
    }

    // ─── One-shot migration (the CACHE_VERSION 6→7 rescue) ──────────────
    //
    // The v7 bump makes loadCache/loadCacheStale reject every v6 entry —
    // evaporating exactly the recovered merges this pipeline exists to save.
    // This sweep reads the v6 generation RAW (GM_getValue, version-agnostic;
    // neither loader can see the entries any more) and feeds the confident /
    // title-only subset through the same queue. It is SYNCHRONOUS up to the
    // enqueue and runs from boot() BEFORE schedule(), so no resolve can
    // overwrite a v6 key with a v7 stub before the snapshot is taken; the
    // cover downloads then drain asynchronously at the usual cap.
    //
    // One-shot via the GM flag, set right after the synchronous snapshot:
    // the rescue is safe once snapshotted, and the async writes are
    // idempotent — a tab closed mid-drain loses nothing, because any av a
    // later session re-resolves is re-enqueued by the runtime hooks (and an
    // interrupted session's overwritten-to-v7 avs were promoted by those
    // hooks already). Individual cover-fetch failures deliberately do NOT
    // hold the flag open — a permanently dead cover would otherwise re-sweep
    // hundreds of entries on every boot forever.
    //
    // `force` (debug surface only) re-runs regardless of the flag; the
    // cfg('autoPromoteRestored') gate always applies — an opted-out user's
    // console should not mass-write the store by accident.
    function runPromotionMigration(force) {
        if (!cfg('autoPromoteRestored')) { log('promote: migration skipped (autoPromoteRestored off)'); return 0; }
        if (!force && GM_getValue(PROMOTE_MIGRATED_FLAG, false)) return 0;
        if (typeof indexedDB === 'undefined') return 0;
        if (typeof GM_listValues !== 'function') {
            warn('promote: GM_listValues unavailable — migration skipped');
            return 0;
        }
        var keys = GM_listValues();
        var stats = { pending: 0, written: 0, metaOnly: 0, nocover: 0 };
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (k.indexOf(CACHE_PREFIX) !== 0) continue;
            var v = null;
            try { v = GM_getValue(k, null); } catch (e) { continue; }
            // Explicitly === 6, not !== CACHE_VERSION: this sweep targets the
            // pre-bump generation and nothing else, ever.
            if (!v || v._cache_version !== 6) continue;
            var kind = promoteClassify(v, true);
            if (!kind) continue;   // non-confident v6 entries die on the bump
            var av = k.slice(CACHE_PREFIX.length);
            if (_promoteInFlight.has(av)) continue;
            // mediaId null: the GM cache is folder-agnostic. The record lands
            // with its existing (or empty) media_ids and shows under the
            // panel's 全部收藏夹 filter; folder membership accretes when the
            // av is next resolved inside a folder.
            enqueuePromotion({ av: av, merged: v, mediaId: null, kind: kind, mig: true });
            stats.pending++;
        }
        GM_setValue(PROMOTE_MIGRATED_FLAG, true);
        if (!stats.pending) return 0;
        _migStats = stats;
        log('promote: migration enqueued', stats.pending, 'v6 cache entr(y/ies)');
        return stats.pending;
    }

    // Called as each migration task settles; fires the single summary toast
    // when the last one does. Wording per the release notes: N = records
    // actually written, M = the coverless (restored_meta) subset of N, K =
    // confident entries not stored because their cover download failed.
    // Silent when N and K are both zero — nothing happened worth a banner.
    function promoteMigrationSettled() {
        if (!_migStats) return;
        _migStats.pending--;
        if (_migStats.pending > 0) return;
        var s = _migStats;
        _migStats = null;
        if (s.written + s.nocover === 0) return;
        var msg = '已将 ' + s.written + ' 项还原记录转存至本地备份';
        if (s.metaOnly > 0) msg += '，其中 ' + s.metaOnly + ' 项暂无封面';
        if (s.nocover > 0)  msg += '，' + s.nocover + ' 项因封面下载失败未收录';
        toast(msg, 'ok');
    }
