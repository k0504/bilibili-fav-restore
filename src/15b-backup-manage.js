    // ─── Backup manager panel ───────────────────────────────────────────
    //
    // The IndexedDB backup (15a-backup.js) is the only USER-AUTHORED data this
    // script keeps, and until this panel existed the only way to inspect or
    // prune it was DevTools. This module is that missing surface: a single
    // in-page overlay that lists every archived item with its cover thumbnail
    // and provides the delete paths (one item, or the whole current filter).
    //
    // Cross-file invariants (see AGENTS.md gotcha 20):
    //   - Deleting one av is a THREE-LAYER operation, not just an IDB delete.
    //     The GM merge cache (07-cache.js) may hold a merge whose fields came
    //     FROM the backup and would keep restoring that card for up to 30
    //     days, and the in-memory row `backup|<av>` (pageItems, 08-resolver.js)
    //     would do the same for the rest of this page's life. deleteBackupAv()
    //     drops all three; the caller drops pageCache once per batch.
    //   - The `meta` store is deliberately left alone. It records "when was
    //     this folder last walked in full", which stays true after individual
    //     items are pruned — and the panel header / backupStatus() read live
    //     counts from the items store anyway, so nothing here is a stale counter.
    //   - Cover Blobs in Chromium are file-backed lazy handles: a cursor walk
    //     does NOT pull the bytes into memory, but a reference held in a JS
    //     index would pin them. The in-memory index below therefore copies
    //     PRIMITIVES ONLY. Thumbnails are read per visible page and their
    //     objectURLs revoked on every re-render and on close.
    //   - Panel nodes are prefixed `fav-fix-mgr-` and match none of
    //     CARD_SELECTOR, so the MutationObserver's card scan (14-orchestrate.js)
    //     never mistakes a row for a bilibili video card.

    var MGR_PAGE_SIZE          = 20;
    var MGR_SEARCH_DEBOUNCE_MS = 300;

    var _mgrHost    = null;   // overlay root; non-null means the panel is open
    var _mgrState   = null;   // see openBackupManager() for the shape
    var _mgrOpening = false;  // guards the await between click and first paint
    var _mgrStylesInjected = false;

    function ensureBackupManagerStyles() {
        if (_mgrStylesInjected) return;
        _mgrStylesInjected = true;
        var st = document.createElement('style');
        st.id = '__fav_fix_mgr_styles';
        st.textContent = [
            '.fav-fix-mgr-overlay {',
            '  position: fixed; inset: 0; z-index: 2147483646;',
            '  display: flex; align-items: center; justify-content: center;',
            '  background: rgba(0,0,0,.45);',
            '  font: 13px/1.5 -apple-system,Segoe UI,sans-serif; color: #18191c;',
            '}',
            '.fav-fix-mgr-panel {',
            '  width: 720px; max-width: 92vw; max-height: 80vh;',
            '  display: flex; flex-direction: column;',
            '  background: #fff; border-radius: 12px; overflow: hidden;',
            '  box-shadow: 0 8px 32px rgba(0,0,0,.3);',
            '}',
            '.fav-fix-mgr-head {',
            '  display: flex; align-items: center; gap: 12px;',
            '  padding: 14px 18px; border-bottom: 1px solid #e3e5e7;',
            '}',
            '.fav-fix-mgr-title { font-size: 16px; font-weight: 600; }',
            '.fav-fix-mgr-stat { flex: 1; font-size: 12px; color: #9499a0; }',
            '.fav-fix-mgr-tools {',
            '  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;',
            '  padding: 10px 18px; border-bottom: 1px solid #f1f2f3;',
            '}',
            '.fav-fix-mgr-input {',
            '  flex: 1; min-width: 150px; padding: 5px 10px;',
            '  border: 1px solid #e3e5e7; border-radius: 6px;',
            '  font-size: 12px; outline: none;',
            '}',
            '.fav-fix-mgr-input:focus { border-color: #fb7299; }',
            '.fav-fix-mgr-select {',
            '  max-width: 240px; padding: 5px 8px;',
            '  border: 1px solid #e3e5e7; border-radius: 6px; font-size: 12px;',
            '}',
            '.fav-fix-mgr-btn {',
            '  border: 1px solid #e3e5e7; background: #f6f7f8; color: #18191c;',
            '  padding: 5px 12px; border-radius: 6px; cursor: pointer;',
            '  font: 12px/18px -apple-system,Segoe UI,sans-serif;',
            '}',
            '.fav-fix-mgr-btn:hover { background: #ececee; }',
            '.fav-fix-mgr-btn[disabled] { opacity: .45; cursor: default; }',
            '.fav-fix-mgr-btn-danger {',
            '  border-color: #fb7299; background: #fb7299; color: #fff;',
            '}',
            '.fav-fix-mgr-btn-danger:hover { background: #e8618a; }',
            '.fav-fix-mgr-body { flex: 1; min-height: 120px; overflow-y: auto; }',
            '.fav-fix-mgr-note {',
            '  padding: 48px 20px; text-align: center; color: #9499a0;',
            '}',
            '.fav-fix-mgr-row {',
            '  display: flex; align-items: center; gap: 12px;',
            '  padding: 8px 18px; border-bottom: 1px solid #f4f5f6;',
            '}',
            // Fixed 96x60 box for both the real thumbnail and the placeholder,
            // so rows keep the same height whether or not a cover was archived.
            '.fav-fix-mgr-thumb, .fav-fix-mgr-noimg {',
            '  width: 96px; height: 60px; flex: 0 0 96px;',
            '  border-radius: 4px; background: #f1f2f3;',
            '}',
            '.fav-fix-mgr-thumb { object-fit: cover; }',
            '.fav-fix-mgr-noimg {',
            '  display: flex; align-items: center; justify-content: center;',
            '  color: #c9ccd0; font-size: 11px;',
            '}',
            '.fav-fix-mgr-info { flex: 1; min-width: 0; }',
            '.fav-fix-mgr-name, .fav-fix-mgr-sub {',
            '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
            '}',
            '.fav-fix-mgr-name { font-size: 13px; font-weight: 500; }',
            '.fav-fix-mgr-sub { margin-top: 3px; font-size: 11px; color: #9499a0; }',
            '.fav-fix-mgr-tag {',
            '  display: inline-block; margin-left: 6px; padding: 0 5px;',
            '  border-radius: 3px; background: #8e44ad; color: #fff;',
            '  font-size: 10px; line-height: 15px; vertical-align: 1px;',
            '}',
            '.fav-fix-mgr-tag-merged { background: #909399; }',
            '.fav-fix-mgr-foot {',
            '  display: flex; align-items: center; gap: 10px;',
            '  padding: 10px 18px; border-top: 1px solid #e3e5e7;',
            '}',
            '.fav-fix-mgr-pageinfo { flex: 1; font-size: 12px; color: #9499a0; }'
        ].join('\n');
        (document.head || document.documentElement).appendChild(st);
    }

    // backed_at is a millisecond timestamp, unlike fmtTime (10-tooltip.js)
    // which takes unix SECONDS — hence a separate formatter rather than a
    // conversion at every call site.
    function mgrDate(ms) {
        if (!ms) return '未知';
        var d = new Date(Number(ms));
        if (isNaN(d.getTime())) return '未知';
        var pad = function (x) { return x < 10 ? '0' + x : String(x); };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    // Light index of the whole items store. PRIMITIVES ONLY — see the header
    // note on Blob handles. One cursor walk over ~1000 records is well under a
    // second, and it is what every count, filter and page slice reads from
    // afterwards, so nothing below re-opens a transaction just to count.
    function buildBackupIndex() {
        var out = [];
        return idbCursorEach(BACKUP_STORE_ITEMS, function (rec) {
            if (!rec || rec.av == null) return;
            out.push({
                av:          String(rec.av),
                bvid:        rec.bvid || '',
                title:       rec.title || '',
                upperName:   (rec.upper && rec.upper.name) || '',
                media_ids:   Array.isArray(rec.media_ids) ? rec.media_ids.slice() : [],
                backed_at:   rec.backed_at || 0,
                fav_time:    rec.fav_time || 0,   // unix SECONDS (backed_at is ms)
                cover_size:  rec.cover_size || 0,
                data_source: rec.data_source || '',
                hasCover:    !!rec.cover_blob
            });
        }).then(function () {
            // No sort here: ordering is a VIEW concern (mgrApplyFilter), driven
            // by the sort dropdown. Note backed_at is NOT the folder's natural
            // order — a first full walk writes page 1 (newest favorites) first,
            // so "newest backed_at" lists the OLDEST favorites on top.
            return out;
        });
    }

    // Folder display names for the dropdown, merged from two layers: the meta
    // store (persisted by the backup walker via normalizePublicResp's
    // folderTitle since 0.11.1) wins; the sidebar DOM fills in folders backed
    // up before names were stored (its items carry the fid as the element id
    // and "<name> <count>" as text — the default folder's item has NO id, so
    // it stays covered only by the meta layer). Anything in neither layer
    // falls back to '收藏夹 <id>' at render time.
    function mgrBuildFolderNames() {
        var names = new Map();
        var metas = new Map();   // media_id → full meta record, for the footer's last-run readout
        try {
            var items = document.querySelectorAll('div.fav-sidebar-item[id]');
            for (var i = 0; i < items.length; i++) {
                var id = items[i].getAttribute('id');
                if (!/^\d+$/.test(id)) continue;
                var t = items[i].textContent.replace(/\s+/g, ' ').trim().replace(/\s*\d+$/, '');
                if (t) names.set(id, t);
            }
        } catch (e) { /* sidebar layout changed — raw ids still render */ }
        return idbCursorEach(BACKUP_STORE_META, function (rec) {
            if (!rec || !rec.media_id) return;
            metas.set(String(rec.media_id), rec);
            if (rec.title) names.set(String(rec.media_id), rec.title);
        }).then(function () { return { names: names, metas: metas }; },
                function () { return { names: names, metas: metas }; });
    }

    // Per-folder last-run readout, shown in the footer while that folder is
    // selected (absorbed from the old 查看备份状态 menu toast). last_run is the
    // last COMPLETE pass; an aborted attempt is flagged beside it so a
    // 40-of-300 failure never reads as an up-to-date folder.
    function mgrFolderMetaText() {
        var s = _mgrState;
        if (s.folder === '*') return '';
        var m = s.metas.get(String(s.folder));
        if (!m || !m.last_run) return ' · 未完整备份过';
        var days = Math.floor((Date.now() - m.last_run) / 86400000);
        var txt = ' · 上次备份：' + (days <= 0 ? '今天' : days + ' 天前')
                + '（' + (m.total_seen || 0) + ' 项）';
        if (m.last_attempt_partial) txt += ' · 上次尝试中止于第 ' + (m.last_attempt_page || 0) + ' 页';
        return txt;
    }

    // Three-layer delete (see the header invariants). pageCache is NOT cleared
    // here: it is keyed by page, not by av, so the caller drops it once after a
    // whole batch instead of once per item.
    function deleteBackupAv(av) {
        av = String(av);
        return idbDelete(BACKUP_STORE_ITEMS, av).then(function () {
            try { clearItemCache(av); }
            catch (e) { warn('mgr: clearItemCache failed for av', av, e && e.message); }
            pageItems.delete('backup|' + av);
        });
    }

    // ─── Panel internals ────────────────────────────────────────────────

    function mgrRevokeThumbs() {
        if (!_mgrState) return;
        for (var i = 0; i < _mgrState.urls.length; i++) {
            try { URL.revokeObjectURL(_mgrState.urls[i]); } catch (e) {}
        }
        _mgrState.urls = [];
    }

    function mgrTotals(rows) {
        var t = { items: rows.length, covers: 0, bytes: 0 };
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].cover_size) { t.covers++; t.bytes += rows[i].cover_size; }
        }
        return t;
    }

    function mgrApplyFilter() {
        var s = _mgrState;
        var q = s.query.trim().toLowerCase();
        var fid = s.folder;
        s.filtered = s.index.filter(function (r) {
            if (fid !== '*' && r.media_ids.indexOf(Number(fid)) < 0) return false;
            if (!q) return true;
            return r.title.toLowerCase().indexOf(q) >= 0
                || r.bvid.toLowerCase().indexOf(q) >= 0
                || r.upperName.toLowerCase().indexOf(q) >= 0;
        });
        // Sort the view. Default fav_desc mirrors the favlist page's own
        // 最近收藏 order; records missing the key (0) sink to the end in desc.
        var byBacked = s.sort.indexOf('backed') === 0;
        var asc = s.sort.slice(-3) === 'asc';
        s.filtered.sort(function (a, b) {
            var av2 = byBacked ? a.backed_at : a.fav_time;
            var bv2 = byBacked ? b.backed_at : b.fav_time;
            return asc ? av2 - bv2 : bv2 - av2;
        });
        s.page = 1;
    }

    function mgrRenderHead() {
        var s = _mgrState;
        var t = mgrTotals(s.index);
        s.els.stat.textContent = '共 ' + t.items + ' 项 · 封面 ' + t.covers
                               + ' 张 / ' + fmtBytes(t.bytes)
                               + (s.quotaText ? ' · 浏览器存储 ' + s.quotaText : '');
    }

    // Browser-quota readout for the header (absorbed from the old status
    // toast). Refreshed on open and after an in-panel backup; a delete's
    // effect on usage is small and picked up on the next open.
    function mgrLoadQuota() {
        var s = _mgrState;
        if (!s || !navigator.storage || !navigator.storage.estimate) return Promise.resolve();
        return navigator.storage.estimate().then(function (est) {
            if (_mgrState !== s || !est) return;
            s.quotaText = fmtBytes(est.usage || 0) + ' / ' + fmtBytes(est.quota || 0);
            mgrRenderHead();
        }).catch(function () { /* header simply omits the quota */ });
    }

    // Options are the UNION of media_ids across the index, each with its own
    // count. Rebuilt on open and after any delete, because both the labels and
    // the per-folder counts are derived from the index. It still does NOT
    // follow SPA folder switches: that snapshot keeps the filter stable while
    // the user works through the list.
    function mgrRenderFolders() {
        var s = _mgrState;
        var counts = new Map();
        for (var i = 0; i < s.index.length; i++) {
            var ids = s.index[i].media_ids;
            for (var j = 0; j < ids.length; j++) {
                var k = String(ids[j]);
                counts.set(k, (counts.get(k) || 0) + 1);
            }
        }
        var keys = Array.from(counts.keys());
        keys.sort(function (a, b) { return counts.get(b) - counts.get(a) || Number(a) - Number(b); });
        // A folder whose last item was just deleted has no option left, so the
        // assignment at the end of this function would silently leave the
        // select blank while s.folder kept filtering on the vanished id. Fall
        // back to 全部收藏夹 so the control and the filter still agree.
        if (s.folder !== '*' && !counts.has(s.folder)) s.folder = '*';
        var html = '<option value="*">全部收藏夹（' + s.index.length + '）</option>';
        for (var m = 0; m < keys.length; m++) {
            var label = (s.names.get(keys[m]) || ('收藏夹 ' + keys[m]))
                      + (s.currentMid && keys[m] === String(s.currentMid) ? ' · 当前收藏夹' : '')
                      + '（' + counts.get(keys[m]) + '）';
            html += '<option value="' + esc(keys[m]) + '">' + esc(label) + '</option>';
        }
        s.els.folder.innerHTML = html;
        s.els.folder.value = s.folder;
    }

    // Thumbnails for the CURRENT page only. Each read is guarded by the render
    // token so a slow idbGet from a page the user already left neither paints
    // into a recycled row nor leaks an objectURL past the revoke.
    function mgrLoadThumbs(entries) {
        var s = _mgrState;
        var token = s.renderToken;
        entries.forEach(function (entry) {
            idbGet(BACKUP_STORE_ITEMS, entry.av).then(function (rec) {
                if (_mgrState !== s || s.renderToken !== token) return;
                if (!rec || !rec.cover_blob) return;
                var url = URL.createObjectURL(rec.cover_blob);
                s.urls.push(url);
                entry.img.src = url;
            }).catch(function (e) {
                warn('mgr: thumbnail read failed for av', entry.av, e && e.message);
            });
        });
    }

    function mgrRenderList() {
        var s = _mgrState;
        // Every re-render invalidates the previous page's thumbnails: bump the
        // token BEFORE revoking so in-flight reads bail out instead of pushing
        // a fresh objectURL into the list we just emptied.
        s.renderToken++;
        mgrRevokeThumbs();
        var body = s.els.body;
        body.innerHTML = '';

        var total = s.filtered.length;
        var pages = Math.max(1, Math.ceil(total / MGR_PAGE_SIZE));
        if (s.page > pages) s.page = pages;
        var start = (s.page - 1) * MGR_PAGE_SIZE;
        var slice = s.filtered.slice(start, start + MGR_PAGE_SIZE);

        if (!s.index.length) {
            body.innerHTML = '<div class="fav-fix-mgr-note">暂无备份数据<br>'
                           + '可在 Tampermonkey 菜单中选择「fav-fix：备份当前收藏夹」开始备份</div>';
        } else if (!total) {
            body.innerHTML = '<div class="fav-fix-mgr-note">没有符合条件的备份条目</div>';
        }

        var pending = [];
        for (var i = 0; i < slice.length; i++) {
            var r = slice[i];
            var row = document.createElement('div');
            row.className = 'fav-fix-mgr-row';
            var tagCls = r.data_source === 'merged' ? ' fav-fix-mgr-tag-merged' : '';
            var tagTxt = r.data_source === 'merged' ? '取自还原缓存' : '备份时有效';
            // The visible date follows the active sort key, labeled so a list
            // sorted by 收藏时间 does not show seemingly shuffled backup dates.
            var dateStr = s.sort.indexOf('backed') === 0
                ? '备份于 ' + mgrDate(r.backed_at)
                : '收藏于 ' + (r.fav_time ? mgrDate(r.fav_time * 1000) : '未知');
            var sub = [
                r.upperName || '未知 UP 主',
                dateStr,
                r.cover_size ? fmtBytes(r.cover_size) : '无封面',
                r.bvid || ('av' + r.av)
            ].join(' · ');
            row.innerHTML =
                (r.hasCover
                    ? '<img class="fav-fix-mgr-thumb" alt="">'
                    : '<div class="fav-fix-mgr-noimg">无封面</div>')
                + '<div class="fav-fix-mgr-info">'
                +   '<div class="fav-fix-mgr-name" title="' + esc(r.title) + '">' + esc(r.title) + '</div>'
                +   '<div class="fav-fix-mgr-sub">' + esc(sub)
                +     '<span class="fav-fix-mgr-tag' + tagCls + '">' + esc(tagTxt) + '</span>'
                +   '</div>'
                + '</div>'
                + '<button class="fav-fix-mgr-btn fav-fix-mgr-del">删除</button>';
            body.appendChild(row);

            var img = row.querySelector('.fav-fix-mgr-thumb');
            if (img) pending.push({ av: r.av, img: img });
            /* jshint loopfunc:true */
            (function (rec) {
                row.querySelector('.fav-fix-mgr-del')
                   .addEventListener('click', function () { mgrDeleteOne(rec); });
            })(r);
        }
        if (pending.length) mgrLoadThumbs(pending);

        s.els.pageInfo.textContent = '第 ' + (total ? s.page : 0) + ' / ' + (total ? pages : 0)
                                   + ' 页 · 共 ' + total + ' 项' + mgrFolderMetaText();
        s.els.prev.disabled = s.busy || s.page <= 1;
        s.els.next.disabled = s.busy || s.page >= pages;
        // Both write paths (delete, in-panel backup) mutually exclude each
        // other; browsing stays free during either.
        s.els.bulk.disabled = s.busy || s.backupBusy || !total;
        s.els.bulk.textContent = '删除当前筛选结果（' + total + ' 项）';
        if (s.backupBusy) {
            var dels = s.els.body.querySelectorAll('.fav-fix-mgr-del');
            for (var d = 0; d < dels.length; d++) dels[d].disabled = true;
        }
    }

    // Re-entrancy guard for both delete paths: an in-flight delete must not be
    // raced by a second click, a page flip or a filter change mid-batch.
    function mgrSetBusy(on) {
        var s = _mgrState;
        // Defence in depth: every caller already checks the panel is still the
        // one it started with, but a release arriving after close must never
        // throw out of a promise callback.
        if (!s) return;
        s.busy = on;
        // Recompute rather than blanket-enable on release: a delete that ends
        // without a re-render (the failure path) must not leave 下一页 clickable
        // on the last page.
        var pages = Math.max(1, Math.ceil(s.filtered.length / MGR_PAGE_SIZE));
        s.els.prev.disabled = on || s.page <= 1;
        s.els.next.disabled = on || s.page >= pages;
        s.els.bulk.disabled = on || !s.filtered.length;
        var dels = s.els.body.querySelectorAll('.fav-fix-mgr-del');
        for (var i = 0; i < dels.length; i++) dels[i].disabled = on;
    }

    // The search box stays editable during a delete on purpose: disabling an
    // input mid IME composition (Chinese input is the expected case) drops the
    // composition and steals focus. The debounced handler therefore discards
    // whatever was typed while busy, and no further input event is guaranteed
    // to arrive — so the box is re-read once the batch releases, otherwise the
    // panel keeps showing typed text over a list filtered by the old query.
    // Returns true when the query moved, so callers can restart at page 1.
    function mgrResyncSearch() {
        var s = _mgrState;
        if (!s || s.els.search.value === s.query) return false;
        s.query = s.els.search.value;
        return true;
    }

    // Settles the panel after a delete attempt. Also runs on the failure path,
    // where `removed` is empty but the search box may still have moved.
    function mgrAfterDelete(removed) {
        var s = _mgrState;
        if (!s) return;
        var requery = mgrResyncSearch();
        if (!removed.size && !requery) return;
        s.index = s.index.filter(function (r) { return !removed.has(r.av); });
        var page = s.page;
        var folder = s.folder;
        // Every surface derived from the index goes stale on a delete, the
        // folder dropdown included: its option labels carry per-folder counts,
        // and the rebuild is also what drops a folder that just lost its last
        // item (resetting s.folder to '*' when that folder was selected).
        mgrRenderFolders();
        mgrApplyFilter();
        // Keep the reader where they were — unless the filter itself changed,
        // in which case the old page number means nothing and page 1 (set by
        // mgrApplyFilter) is the honest landing spot.
        if (!requery && s.folder === folder) s.page = page;
        mgrRenderHead();
        mgrRenderList();
    }

    // Full refresh after an in-panel backup: the index, the folder-name map
    // and every surface derived from them are stale. Search text typed during
    // the run is honoured (mgrResyncSearch), the folder selection survives
    // unless its folder vanished (mgrRenderFolders resets it), and deletes are
    // blocked for the whole backup, so this can never repaint rows out from
    // under an in-flight delete batch.
    function mgrRefreshIndex() {
        var s = _mgrState;
        if (!s) return Promise.resolve();
        return Promise.all([buildBackupIndex(), mgrBuildFolderNames()]).then(function (res) {
            if (_mgrState !== s) return;
            s.index = res[0];
            s.names = res[1].names;
            s.metas = res[1].metas;
            mgrLoadQuota();
            mgrResyncSearch();
            mgrRenderHead();
            mgrRenderFolders();
            mgrApplyFilter();
            mgrRenderList();
        }).catch(function (e) {
            warn('mgr: refresh failed', e && e.message);
        });
    }

    function mgrDeleteOne(rec) {
        var s = _mgrState;
        if (s.busy || s.backupBusy) return;
        if (!confirm('确定删除该条目的备份？\n\n' + rec.title + '\n\n删除后无法恢复。')) return;
        mgrSetBusy(true);
        deleteBackupAv(rec.av).then(function () {
            // The record left IDB whether or not the panel survived the await,
            // so the page-keyed promise cache — which would otherwise replay
            // pre-delete rows for the rest of this page's life — is dropped
            // unconditionally; only the UI work below belongs to a live panel.
            pageCache.clear();
            if (_mgrState !== s) return;   // panel closed mid-delete
            mgrSetBusy(false);
            mgrAfterDelete(new Set([rec.av]));
            toast('已删除 1 项备份', 'ok');
        }).catch(function (e) {
            if (_mgrState !== s) {         // panel closed mid-delete
                warn('mgr: delete failed after close', e && e.message);
                return;
            }
            mgrSetBusy(false);
            mgrAfterDelete(new Set());
            toast('删除失败：' + (e && e.message), 'err');
        });
    }

    async function mgrDeleteFiltered() {
        var s = _mgrState;
        if (s.busy || s.backupBusy) return;
        var targets = s.filtered.slice();
        if (!targets.length) return;
        var whole = (s.folder === '*' && !s.query.trim());
        var msg = whole
            ? '将清空全部备份，共 ' + targets.length + ' 项。\n\n删除后无法恢复，确定继续？'
            : '将删除当前筛选结果，共 ' + targets.length + ' 项。\n\n删除后无法恢复，确定继续？';
        if (!confirm(msg)) return;

        mgrSetBusy(true);
        var removed = new Set();
        var failed = 0;
        // Serial, not Promise.all: each delete is its own transaction and the
        // whole set is a few hundred records at worst (measured in seconds),
        // while a few hundred parallel transactions is how the connection gets
        // starved. A mid-way failure keeps everything already removed.
        for (var i = 0; i < targets.length; i++) {
            try {
                await deleteBackupAv(targets[i].av);
                removed.add(targets[i].av);
            } catch (e) {
                failed++;
                warn('mgr: delete failed for av', targets[i].av, e && e.message);
            }
        }
        // Dropped once per batch, and before the state guard: the records left
        // IDB regardless of whether the panel is still open.
        if (removed.size) pageCache.clear();
        if (_mgrState !== s) return;   // panel closed mid-batch
        mgrSetBusy(false);
        mgrAfterDelete(removed);
        toast('已删除 ' + removed.size + ' 项备份'
              + (failed ? ' · 失败 ' + failed + ' 项' : ''), failed ? 'warn' : 'ok');
    }

    function closeBackupManager() {
        if (!_mgrHost) return;
        if (_mgrState) {
            // Invalidate before revoking so a thumbnail read still in flight
            // cannot resurrect an objectURL after the panel is gone.
            _mgrState.renderToken++;
            mgrRevokeThumbs();
        }
        if (_mgrState && _mgrState.onKeydown) {
            document.removeEventListener('keydown', _mgrState.onKeydown, true);
        }
        try { _mgrHost.remove(); } catch (e) {}
        _mgrHost = null;
        _mgrState = null;
    }

    // ─── Entry point ────────────────────────────────────────────────────
    // Driven by the Tampermonkey menu command and __biliFavFix.backup.manage().
    async function openBackupManager() {
        if (_mgrHost) {
            // Single instance: a second invocation focuses the open panel
            // rather than stacking a second overlay on top of it.
            var open = _mgrHost.querySelector('.fav-fix-mgr-input');
            if (open) open.focus();
            return;
        }
        if (_mgrOpening) return;
        if (typeof indexedDB === 'undefined') {
            toast('当前环境不支持 IndexedDB，无法管理备份', 'err');
            return;
        }
        _mgrOpening = true;
        try {
            // Probe the DB BEFORE painting anything: a panel that renders and
            // then has to apologise is worse than never opening. idbCount also
            // performs the lazy open, so a failure here is the open failing.
            try { await idbCount(BACKUP_STORE_ITEMS); }
            catch (e) {
                toast('无法打开备份数据库：' + (e && e.message), 'err');
                return;
            }

            ensureBackupManagerStyles();
            var host = document.createElement('div');
            host.className = 'fav-fix-mgr-overlay';
            host.innerHTML = ''
                + '<div class="fav-fix-mgr-panel">'
                +   '<div class="fav-fix-mgr-head">'
                +     '<div class="fav-fix-mgr-title">备份管理</div>'
                +     '<div class="fav-fix-mgr-stat">正在读取备份…</div>'
                +     '<button class="fav-fix-mgr-btn fav-fix-mgr-close">关闭</button>'
                +   '</div>'
                +   '<div class="fav-fix-mgr-tools">'
                +     '<input class="fav-fix-mgr-input" type="text" placeholder="搜索标题 / BV 号 / UP 主">'
                +     '<select class="fav-fix-mgr-select"><option value="*">全部收藏夹</option></select>'
                +     '<select class="fav-fix-mgr-select fav-fix-mgr-sort">'
                +       '<option value="fav_desc">最新收藏在前</option>'
                +       '<option value="fav_asc">最早收藏在前</option>'
                +       '<option value="backed_desc">最新备份在前</option>'
                +       '<option value="backed_asc">最早备份在前</option>'
                +     '</select>'
                +     '<button class="fav-fix-mgr-btn fav-fix-mgr-backup">备份当前收藏夹</button>'
                +     '<button class="fav-fix-mgr-btn fav-fix-mgr-btn-danger fav-fix-mgr-bulk" disabled>删除当前筛选结果</button>'
                +   '</div>'
                +   '<div class="fav-fix-mgr-body">'
                +     '<div class="fav-fix-mgr-note">正在读取备份…</div>'
                +   '</div>'
                +   '<div class="fav-fix-mgr-foot">'
                +     '<div class="fav-fix-mgr-pageinfo"></div>'
                +     '<button class="fav-fix-mgr-btn fav-fix-mgr-prev" disabled>上一页</button>'
                +     '<button class="fav-fix-mgr-btn fav-fix-mgr-next" disabled>下一页</button>'
                +   '</div>'
                + '</div>';
            document.body.appendChild(host);
            _mgrHost = host;

            _mgrState = {
                index: [], filtered: [], page: 1, query: '', folder: '*',
                sort: 'fav_desc',
                names: new Map(), metas: new Map(), quotaText: null,
                currentMid: detectMediaId(),
                urls: [], renderToken: 0, busy: false, backupBusy: false,
                searchTimer: null,
                onKeydown: null,
                els: {
                    stat:     host.querySelector('.fav-fix-mgr-stat'),
                    body:     host.querySelector('.fav-fix-mgr-body'),
                    search:   host.querySelector('.fav-fix-mgr-input'),
                    folder:   host.querySelector('.fav-fix-mgr-select'),
                    sort:     host.querySelector('.fav-fix-mgr-sort'),
                    backup:   host.querySelector('.fav-fix-mgr-backup'),
                    bulk:     host.querySelector('.fav-fix-mgr-bulk'),
                    prev:     host.querySelector('.fav-fix-mgr-prev'),
                    next:     host.querySelector('.fav-fix-mgr-next'),
                    pageInfo: host.querySelector('.fav-fix-mgr-pageinfo')
                }
            };
            var s = _mgrState;

            host.querySelector('.fav-fix-mgr-close')
                .addEventListener('click', closeBackupManager);
            // Backdrop click only — a click that started inside the panel and
            // ended on the overlay must not close it.
            host.addEventListener('click', function (e) {
                if (e.target === host) closeBackupManager();
            });
            // Capture phase: bilibili's own key handlers sit on document too,
            // and Esc should reach us regardless of what has focus.
            s.onKeydown = function (e) {
                if (e.key === 'Escape') { e.stopPropagation(); closeBackupManager(); }
            };
            document.addEventListener('keydown', s.onKeydown, true);

            s.els.search.addEventListener('input', function () {
                if (s.searchTimer) clearTimeout(s.searchTimer);
                s.searchTimer = setTimeout(function () {
                    // A re-render mid-batch would repaint the rows with their
                    // delete buttons enabled again, so filtering/paging stays
                    // frozen for the duration of a delete. What was typed is
                    // not lost: mgrResyncSearch re-reads the box on release.
                    if (_mgrState !== s || s.busy) return;
                    s.query = s.els.search.value;
                    mgrApplyFilter();
                    mgrRenderList();
                }, MGR_SEARCH_DEBOUNCE_MS);
            });
            s.els.folder.addEventListener('change', function () {
                if (s.busy) { s.els.folder.value = s.folder; return; }
                s.folder = s.els.folder.value;
                mgrApplyFilter();
                mgrRenderList();
            });
            s.els.sort.addEventListener('change', function () {
                if (s.busy) { s.els.sort.value = s.sort; return; }
                s.sort = s.els.sort.value;
                mgrApplyFilter();
                mgrRenderList();
            });
            s.els.bulk.addEventListener('click', function () {
                mgrDeleteFiltered().catch(function (e) {
                    warn('mgr: bulk delete threw', e);
                    toast('批量删除失败：' + (e && e.message), 'err');
                });
            });
            // In-panel backup: backupCurrentFolder() re-detects the folder at
            // run time, so the flow for a folder the dropdown does not list
            // yet is: switch the page to it, click this, and the refresh below
            // adds it as a filter option. Deletes are blocked for the duration
            // (see mgrRenderList); browsing stays free.
            s.els.backup.addEventListener('click', function () {
                if (s.busy || s.backupBusy) return;
                s.backupBusy = true;
                s.els.backup.disabled = true;
                s.els.backup.textContent = '备份中…';
                mgrRenderList();
                backupCurrentFolder().catch(function (e) {
                    warn('mgr: in-panel backup threw', e);
                    toast('备份失败：' + (e && e.message), 'err');
                    return null;
                }).then(function () {
                    if (_mgrState !== s) return;
                    s.backupBusy = false;
                    s.els.backup.disabled = false;
                    s.els.backup.textContent = '备份当前收藏夹';
                    // The run may have been for a different folder than the
                    // one the panel opened on — re-detect so the 当前收藏夹
                    // marker follows what was actually just backed up.
                    s.currentMid = detectMediaId();
                    return mgrRefreshIndex();
                });
            });
            s.els.prev.addEventListener('click', function () {
                if (s.page > 1) { s.page--; mgrRenderList(); }
            });
            s.els.next.addEventListener('click', function () {
                s.page++; mgrRenderList();
            });

            var index, layers;
            try {
                index = await buildBackupIndex();
                layers = await mgrBuildFolderNames();
            }
            catch (e) {
                warn('mgr: index build failed', e);
                closeBackupManager();
                toast('读取备份列表失败：' + (e && e.message), 'err');
                return;
            }
            if (_mgrState !== s) return;   // closed while the cursor was walking
            s.index = index;
            s.names = layers.names;
            s.metas = layers.metas;
            mgrRenderHead();
            mgrRenderFolders();
            mgrApplyFilter();
            mgrRenderList();
            mgrLoadQuota();
            s.els.search.focus();
        } finally {
            _mgrOpening = false;
        }
    }
