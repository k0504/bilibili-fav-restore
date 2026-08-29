    // ─── Folder membership snapshots ────────────────────────────────────
    //
    // A backup record is never deleted automatically, and its media_ids is a
    // union that never shrinks (backupUnionMediaIds, 15a-backup.js). So when
    // the user un-favourites a video its backup stays behind: still listed
    // under that folder's filter, still counted in the dropdown, its cover
    // blob still occupying storage and still shipped in every export. Nothing
    // in the manager panel told it apart from a video still in the folder.
    //
    // This module supplies the one fact the panel was missing: for each
    // folder, the set of avs it CURRENTLY holds. 15b derives a per-row status
    // from it and offers it as a filter.
    //
    // Three invariants, each of which the rest of the file depends on:
    //
    //   - SNAPSHOTS LIVE IN GM STORAGE, NOT THE BACKUP DB. They are
    //     re-fetchable derived data holding no binary, so the project's
    //     existing split applies: IndexedDB exists here only because Blobs
    //     cannot go into GM storage (gotcha 20). Keeping them out of the DB
    //     means BACKUP_DB_VERSION is untouched and no items record is ever
    //     rewritten — existing backups need no migration and simply read as
    //     "not scanned yet", and there is no version-bump blocked-upgrade or
    //     downgrade trap for users running two tabs or rolling a version back.
    //
    //   - THE AV SET COMES FROM /x/v3/fav/resource/ids AND NOTHING ELSE
    //     (via fetchAllAvList, 13-missing.js). The paginated list endpoints
    //     silently drop items — that is the entire reason 13-missing.js
    //     exists — so a set harvested from a backup walk would report those
    //     dropped items as gone and invite the user to bulk-delete exactly
    //     the records this script exists to preserve.
    //
    //   - EVERY FAILURE PATH LEAVES THE FOLDER WITHOUT A SNAPSHOT, which the
    //     classifier reports as 'unknown'. The asymmetry is deliberate: a
    //     wrong "not in the folder" feeds a bulk delete and destroys user
    //     data, while a wrong 'unknown' costs one more scan.

    var MEMBERSHIP_PREFIX  = 'favids:';
    var MEMBERSHIP_VERSION = 1;

    function loadMembership(mediaId) {
        var v = GM_getValue(MEMBERSHIP_PREFIX + String(mediaId), null);
        if (!v || v._v !== MEMBERSHIP_VERSION || !Array.isArray(v.avs)) return null;
        return v;
    }

    function saveMembership(mediaId, avs, declared) {
        GM_setValue(MEMBERSHIP_PREFIX + String(mediaId), {
            _v:         MEMBERSHIP_VERSION,
            media_id:   String(mediaId),
            checked_at: Date.now(),
            declared:   declared,
            avs:        avs
        });
    }

    // Snapshots for the folders the panel actually shows, as Sets ready for
    // membership tests. Returned as two maps rather than one record map so the
    // hot path (one lookup per rendered row) touches nothing but a Set.
    function loadMembershipSnapshots(mediaIds) {
        var snaps = new Map(), stamps = new Map();
        for (var i = 0; i < mediaIds.length; i++) {
            var mid = String(mediaIds[i]);
            if (snaps.has(mid)) continue;
            var rec = loadMembership(mid);
            if (!rec) continue;
            snaps.set(mid, new Set(rec.avs));
            stamps.set(mid, rec.checked_at || 0);
        }
        return { snaps: snaps, stamps: stamps };
    }

    // Status of ONE record within the scope the panel is currently showing:
    // `scope` is the folder filter ('*' = all folders), `snaps` is the map
    // built above. Pure — no DOM, no IO, no module state.
    function membershipStatus(av, mediaIds, scope, snaps) {
        av = String(av);
        if (scope !== '*') {
            var one = snaps.get(String(scope));
            if (!one) return 'unknown';
            return one.has(av) ? 'in' : 'out';
        }
        // Global scope. A record with NO folder at all cannot be answered by
        // folder snapshots: 15e's one-shot promotion migration writes records
        // with an empty media_ids (it has no folder in scope), and letting
        // those fall through the loop below would return 'out' on an empty
        // array — a false positive feeding the bulk delete.
        if (!mediaIds || !mediaIds.length) return 'unknown';
        var sawAll = true;
        for (var i = 0; i < mediaIds.length; i++) {
            var set = snaps.get(String(mediaIds[i]));
            // Found in one folder ends it: the video is still favourited, and
            // that verdict does not need the folders we could not check.
            if (set && set.has(av)) return 'in';
            if (!set) sawAll = false;
        }
        // Absent from every snapshot we hold — a conclusion only if we hold
        // one for EVERY folder the record claims membership of.
        return sawAll ? 'out' : 'unknown';
    }

    // ─── Scanning ───────────────────────────────────────────────────────

    // One folder. Resolves — never rejects — so a single unreachable folder
    // cannot abort a multi-folder run: `ok` false simply leaves that folder
    // without a snapshot.
    //
    // The integrity gate is the reason this does two requests instead of one.
    // The whole feature rests on resource/ids listing invalid ("已失效视频")
    // entries, which stay in a folder and must never be reported as gone. So
    // rather than trusting that once, every scan re-checks it: the folder's
    // own declared media_count (d.info.media_count, surfaced as `total` by
    // normalizePublicResp) is the yardstick, and a shorter id list means the
    // endpoint filtered something out. The comparison is deliberately
    // one-sided — ids being a SUPERSET of the declared count can never
    // manufacture a false "not in the folder", so only a shortfall refuses.
    async function scanFolderMembership(mediaId) {
        var mid = String(mediaId);
        var total = null;
        try {
            var page = await SOURCES['public'].fetchPage({ mediaId: mid, pn: 1 });
            total = page && page.total;
        } catch (e) {
            warn('membership: folder info failed for', mid, e && e.message);
            return { ok: false, mediaId: mid, reason: 'info' };
        }
        if (typeof total !== 'number') {
            warn('membership: folder', mid, 'declared no media_count — cannot verify, skipping');
            return { ok: false, mediaId: mid, reason: 'info' };
        }

        var ids;
        // force: the panel's button means "tell me the situation NOW", and
        // _idsListCache would otherwise answer from a read taken earlier in
        // this page's life.
        try { ids = await fetchAllAvList(mid, true); }
        catch (e) {
            warn('membership: ids endpoint failed for', mid, e && e.message);
            return { ok: false, mediaId: mid, reason: 'ids' };
        }

        log('membership: folder', mid, 'declared=' + total, 'ids=' + ids.length);
        if (ids.length < total) {
            warn('membership: folder', mid, 'id list is short (' + ids.length + ' < ' + total
                 + ') — the endpoint filtered entries, refusing to record a snapshot');
            return { ok: false, mediaId: mid, reason: 'short' };
        }

        var avs = ids.map(function (x) { return String(x.id); });
        try { saveMembership(mid, avs, total); }
        catch (e) {
            warn('membership: snapshot write failed for', mid, e && e.message);
            return { ok: false, mediaId: mid, reason: 'write' };
        }
        return { ok: true, mediaId: mid, count: avs.length };
    }

    // Module-level mutex, same rank as _backupRunning / _exportRunning /
    // _importRunning and held for the same reason as the export's: the panel
    // that started a scan may be closed before it ends, and a panel opened in
    // the meantime derives its locked controls from this flag alone
    // (mgrLocked). Unlike those three it is NOT part of the promotion
    // pipeline's defer condition (15e) and its finally does not drain the
    // queue: a scan never touches IndexedDB, so there is nothing for a
    // promotion to race with.
    var _membershipRunning = false;

    async function scanMembership(mediaIds) {
        if (_membershipRunning) { toast('检查进行中，请稍后再试', 'warn'); return null; }
        _membershipRunning = true;
        try {
            return await scanMembershipInner(mediaIds);
        } finally {
            _membershipRunning = false;
            // A panel opened mid-run has membershipBusy false and nothing else
            // that would ever repaint its controls once the run ends.
            mgrMembershipReleased();
        }
    }

    async function scanMembershipInner(mediaIds) {
        var targets = [];
        for (var i = 0; i < mediaIds.length; i++) {
            var mid = String(mediaIds[i]);
            if (targets.indexOf(mid) < 0) targets.push(mid);
        }
        if (!targets.length) { toast('没有可检查的收藏夹', 'warn'); return null; }

        toast(targets.length === 1 ? '开始检查所选收藏夹'
                                   : '开始检查，共 ' + targets.length + ' 个收藏夹');
        var ok = 0, failed = 0;
        for (var j = 0; j < targets.length; j++) {
            // Same politeness gap the backup walker puts between pages; no
            // separate setting, the two are the same kind of traffic.
            if (j) await backupSleep(cfg('backupPageDelayMs'));
            var r = await scanFolderMembership(targets[j]);
            if (r.ok) ok++; else failed++;
        }

        var msg = '检查完成：' + ok + ' 个收藏夹已更新';
        // Named rather than silent: a folder without a snapshot reads as
        // 未检查 in the list, and the user is entitled to know that came from
        // a failure rather than from never having pressed the button.
        if (failed) msg += ' · ' + failed + ' 个无法检查（保持未检查）';
        toast(msg, failed ? 'warn' : 'ok');
        return { ok: ok, failed: failed };
    }
