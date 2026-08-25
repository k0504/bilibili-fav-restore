    // ─── Backup manager panel ───────────────────────────────────────────
    //
    // The IndexedDB backup (15a-backup.js) is the only USER-AUTHORED data this
    // script keeps, and until this panel existed the only way to inspect or
    // prune it was DevTools. This module is that missing surface: a single
    // in-page overlay that lists every archived item with its cover thumbnail,
    // provides the delete paths (one item, or the whole current filter), hands
    // the current filter to the ZIP export (15c-backup-export.js) and drives
    // the ZIP import that merges one back (15d-backup-import.js).
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

    // → cfg('mgrPageSize'), default 20.
    // → cfg('mgrSearchDebounceMs'), default 300.

    var _mgrHost    = null;   // overlay root; non-null means the panel is open
    var _mgrState   = null;   // see openBackupManager() for the shape
    var _mgrOpening = false;  // guards the await between click and first paint
    var _mgrStylesInjected = false;

    function ensureBackupManagerStyles() {
        if (_mgrStylesInjected) return;
        _mgrStylesInjected = true;
        // Design language mirrors the host page (bilibili web): white panel,
        // #fb7299 as THE accent for the single primary action, neutral grays
        // for everything else, 6px control radii. Hierarchy over decoration:
        //   header  = identity + global stats + primary action (备份) + close
        //   toolbar = filters only (search, labeled 收藏夹/排序 selects)
        //   footer  = bulk actions bottom-left (the neutral export and import
        //             pair first, then the destructive bulk delete quarantined
        //             beside them), page info center, pager bottom-right
        var st = document.createElement('style');
        st.id = '__fav_fix_mgr_styles';
        st.textContent = [
            // Font stack deliberately matches bilibili's own so the panel
            // reads as part of the host page, not an extension bolt-on.
            '.fav-fix-mgr-overlay {',
            '  position: fixed; inset: 0; z-index: 2147483646;',
            '  display: flex; align-items: center; justify-content: center;',
            '  background: rgba(24,25,28,.5);',
            '  font: 13px/1.5 -apple-system,"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei",sans-serif;',
            '  color: #18191c;',
            '}',
            '.fav-fix-mgr-panel {',
            '  width: 720px; max-width: 92vw; max-height: 80vh;',
            '  display: flex; flex-direction: column;',
            '  background: #fff; border-radius: 12px; overflow: hidden;',
            '  box-shadow: 0 12px 40px rgba(0,0,0,.28);',
            '}',
            '.fav-fix-mgr-head {',
            '  display: flex; align-items: center; gap: 10px;',
            '  padding: 14px 18px 12px; border-bottom: 1px solid #e3e5e7;',
            '}',
            '.fav-fix-mgr-headmain { flex: 1; min-width: 0; }',
            '.fav-fix-mgr-title { font-size: 15px; font-weight: 600; line-height: 20px; }',
            '.fav-fix-mgr-stat {',
            '  margin-top: 2px; font-size: 12px; color: #9499a0;',
            '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
            '}',
            '.fav-fix-mgr-tools {',
            '  display: flex; align-items: center; gap: 10px;',
            '  padding: 10px 18px; border-bottom: 1px solid #f1f2f3;',
            '}',
            '.fav-fix-mgr-input {',
            '  flex: 1; min-width: 140px; height: 32px; padding: 0 10px;',
            '  border: 1px solid #e3e5e7; border-radius: 6px;',
            '  font-size: 12px; outline: none; background: #fff;',
            '  transition: border-color .15s;',
            '}',
            '.fav-fix-mgr-input:focus { border-color: #fb7299; }',
            // Labeled select = prefix chip + borderless native select in one
            // bordered capsule, so 收藏夹/排序 read as named controls instead
            // of two anonymous button-looking boxes. Caret is drawn by the
            // wrapper (::after) since appearance:none strips the native one.
            '.fav-fix-mgr-field {',
            '  position: relative; display: inline-flex; align-items: stretch;',
            '  height: 32px; border: 1px solid #e3e5e7; border-radius: 6px;',
            '  background: #fff; overflow: hidden; transition: border-color .15s;',
            '}',
            '.fav-fix-mgr-field:focus-within { border-color: #fb7299; }',
            '.fav-fix-mgr-field > span {',
            '  display: flex; align-items: center; padding: 0 8px;',
            '  background: #f6f7f8; border-right: 1px solid #e3e5e7;',
            '  font-size: 12px; color: #61666d; white-space: nowrap;',
            '}',
            '.fav-fix-mgr-field > select {',
            '  appearance: none; -webkit-appearance: none;',
            '  border: 0; outline: none; background: transparent;',
            '  max-width: 190px; padding: 0 24px 0 8px;',
            '  font-size: 12px; color: #18191c; cursor: pointer;',
            '}',
            '.fav-fix-mgr-field::after {',
            '  content: ""; position: absolute; right: 9px; top: 50%;',
            '  transform: translateY(-50%); pointer-events: none;',
            '  border-left: 4px solid transparent; border-right: 4px solid transparent;',
            '  border-top: 5px solid #9499a0;',
            '}',
            '.fav-fix-mgr-btn {',
            '  height: 32px; border: 1px solid #e3e5e7; background: #fff;',
            '  color: #18191c; padding: 0 14px; border-radius: 6px;',
            '  cursor: pointer; font-size: 12px; white-space: nowrap;',
            '  transition: background .15s, border-color .15s, color .15s;',
            '}',
            '.fav-fix-mgr-btn:hover { background: #f6f7f8; }',
            '.fav-fix-mgr-btn[disabled] { opacity: .45; cursor: default; }',
            // THE primary action — the only filled-pink element in the panel.
            '.fav-fix-mgr-btn-primary {',
            '  border-color: #fb7299; background: #fb7299; color: #fff; font-weight: 500;',
            '}',
            '.fav-fix-mgr-btn-primary:hover { background: #e8618a; border-color: #e8618a; }',
            '.fav-fix-mgr-btn-primary[disabled] { opacity: .55; }',
            // Destructive: quiet outline until hovered — never louder than
            // the primary action.
            '.fav-fix-mgr-btn-danger {',
            '  border-color: rgba(225,60,83,.4); background: #fff; color: #e13c53;',
            '}',
            '.fav-fix-mgr-btn-danger:hover { background: rgba(225,60,83,.06); border-color: #e13c53; }',
            '.fav-fix-mgr-body { flex: 1; min-height: 120px; overflow-y: auto; }',
            '.fav-fix-mgr-note {',
            '  padding: 48px 20px; text-align: center; color: #9499a0;',
            '}',
            '.fav-fix-mgr-row {',
            '  display: flex; align-items: center; gap: 12px;',
            '  padding: 8px 18px; border-bottom: 1px solid #f4f5f6;',
            '  transition: background .1s;',
            '}',
            '.fav-fix-mgr-row:hover { background: #f8f9fb; }',
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
            '.fav-fix-mgr-pageinfo {',
            '  flex: 1; text-align: right; font-size: 12px; color: #9499a0;',
            '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
            '}'
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
        // The page number is only there when a local walk recorded it, or when
        // the container an import came from was written by a script new enough
        // to carry it (15c exportFolders). Without one, 第 0 页 would name a
        // page the walk never reached — so the clause that mentions a page is
        // rendered only when there IS one, and the flag alone otherwise.
        if (m.last_attempt_partial) {
            txt += m.last_attempt_page
                 ? ' · 上次尝试中止于第 ' + m.last_attempt_page + ' 页'
                 : ' · 上次尝试未完整完成';
        }
        return txt;
    }

    // The panel's mutual-exclusion matrix in ONE place. Every long operation
    // (delete, in-panel backup, export, import) excludes every other one, and
    // the set is now large enough that spelling it out at each of its eight
    // call sites is how one of them ends up missing a term.
    //
    // The MODULE flags are part of the expression, not just the panel's own
    // s.*Busy: an export or an import SURVIVES the panel it was started from
    // (see mgrExportReleased), so a panel opened mid-run has the matching
    // s.*Busy false and must nonetheless present the matrix as locked.
    //
    // _backupRunning (declared in 15a-backup.js and visible here through var
    // hoisting across the concatenated IIFE) belongs in the same list for a
    // second reason on top of that one: a walk started from the Tampermonkey
    // menu or from __biliFavFix.backup.run() never sets s.backupBusy at all,
    // so without this term the footer would keep offering a delete, an export
    // and an import over records a walk is rewriting underneath them.
    function mgrLocked() {
        var s = _mgrState;
        if (!s) return true;
        return !!(s.busy || s.backupBusy || s.exportBusy || s.importBusy
                  || _backupRunning || _exportRunning || _importRunning);
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
        // The field's own prefix chip already says 收藏夹 — option labels
        // carry just the name and count.
        var html = '<option value="*">全部（' + s.index.length + '）</option>';
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
        var pageSize = cfg('mgrPageSize');
        var pages = Math.max(1, Math.ceil(total / pageSize));
        if (s.page > pages) s.page = pages;
        var start = (s.page - 1) * pageSize;
        var slice = s.filtered.slice(start, start + pageSize);

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
        // The four long operations mutually exclude each other (mgrLocked);
        // browsing stays free during all of them.
        var locked = mgrLocked();
        s.els.bulk.disabled = locked || !total;
        s.els.bulk.textContent = '删除当前筛选结果（' + total + ' 项）';
        // The export and import buttons live in the footer, so a re-render
        // never rebuilds them — but their disabled state is derived from the
        // same counters as the rows and has to be recomputed here all the
        // same. Their LABELS are left alone: they carry no count (unlike the
        // bulk delete), and during a run each holds the progress text its own
        // handler owns.
        s.els.exportBtn.disabled = locked || !total;
        // No `!total` term for import: an empty store is exactly the state an
        // import exists to fix, so this is the one footer action that must
        // stay reachable when the list has nothing in it.
        s.els.importBtn.disabled = locked;
        if (locked) {
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
        var pages = Math.max(1, Math.ceil(s.filtered.length / cfg('mgrPageSize')));
        // s.busy is already assigned above, so mgrLocked() sees this release.
        // Same computation as in mgrRenderList: a delete that ends without a
        // re-render must not hand the footer buttons back while another long
        // operation still owns the panel.
        var locked = mgrLocked();
        s.els.prev.disabled = on || s.page <= 1;
        s.els.next.disabled = on || s.page >= pages;
        s.els.bulk.disabled = locked || !s.filtered.length;
        s.els.exportBtn.disabled = locked || !s.filtered.length;
        s.els.importBtn.disabled = locked;
        var dels = s.els.body.querySelectorAll('.fav-fix-mgr-del');
        for (var i = 0; i < dels.length; i++) dels[i].disabled = locked;
    }

    // Called by exportBackupRows (15c-backup-export.js) once a run releases
    // _exportRunning. Only the panel that STARTED an export repaints itself
    // when it ends; a panel opened after that one was closed mid-run derives
    // its locked controls from the module flag and would otherwise stay locked
    // until some unrelated interaction happened to re-render it.
    function mgrExportReleased() {
        var s = _mgrState;
        if (!s || s.exportBusy) return;   // no panel, or the owner repaints itself
        mgrRenderList();
    }

    // The import counterpart, called by importBackupFile (15d-backup-import.js)
    // once a run releases _importRunning, for exactly the same reason: a panel
    // that did not start the run has importBusy false and derives its locked
    // controls from the module flag alone.
    function mgrImportReleased() {
        var s = _mgrState;
        if (!s || s.importBusy) return;   // no panel, or the owner repaints itself
        mgrRenderList();
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
        if (mgrLocked()) return;
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
        if (mgrLocked()) return;
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

    // Packs the current filter into a ZIP (15c-backup-export.js). Read-only,
    // so unlike the delete paths it asks for no confirmation.
    //
    // The row list is SNAPSHOT at click time: the export then owns its own
    // copy and the user may keep searching, paging and switching folders while
    // it runs. Closing the panel mid-run does not cancel it either — the file
    // was asked for and a read-only job has nothing to roll back — so every UI
    // touch below is gated on the panel still being the one this run started
    // with, while the completion toast (which does not belong to the panel)
    // fires from exportBackupRows regardless.
    //
    // renderToken is deliberately NOT involved: that mechanism exists for
    // thumbnail objectURL lifetime and means nothing here.
    function mgrExportFiltered() {
        var s = _mgrState;
        if (mgrLocked()) return;
        var rows = s.filtered.slice();
        if (!rows.length) return;

        s.exportBusy = true;
        s.els.exportBtn.disabled = true;
        s.els.exportBtn.textContent = '导出中 0%';
        mgrRenderList();

        // Percent, not "N / M": the row count is already in the page info line,
        // and repainting the label on every one of several hundred rows is
        // wasted layout work — only a whole-number change is written back.
        var lastPct = -1;
        exportBackupRows(rows, {
            scope: {
                folder:      s.folder,
                folderTitle: s.folder === '*' ? null : (s.names.get(String(s.folder)) || null),
                query:       s.query,
                sort:        s.sort
            },
            metas: s.metas,
            onProgress: function (done, total) {
                if (_mgrState !== s) return;
                var pct = total ? Math.floor(done * 100 / total) : 100;
                if (pct === lastPct) return;
                lastPct = pct;
                s.els.exportBtn.textContent = '导出中 ' + pct + '%';
            }
        }).catch(function (e) {
            warn('mgr: export threw', e);
            toast('导出失败：' + (e && e.message), 'err');
        }).then(function () {
            if (_mgrState !== s) return;   // panel closed mid-export
            s.exportBusy = false;
            s.els.exportBtn.disabled = false;
            s.els.exportBtn.textContent = '导出筛选结果';
            // Nothing in the store changed, so the index stands; the re-render
            // is purely to hand the rows and the bulk button back.
            mgrRenderList();
        });
    }

    // Merges a container written by the export back into the store
    // (15d-backup-import.js). The opposite of mgrExportFiltered in one way
    // that matters: this WRITES, so every surface derived from the index is
    // stale afterwards and the panel takes the same full refresh an in-panel
    // backup does.
    //
    // The current filter is deliberately NOT involved. An export packs what
    // the user is looking at; an import merges what the FILE contains, and
    // silently dropping records because a search box happened to be filled
    // would be a data-loss surprise wearing a filter's clothes.
    //
    // The lock is taken in onStart, not here: a dismissed file dialog fires no
    // event at all, so a lock taken at click time would never be released.
    function mgrImportBackup() {
        var s = _mgrState;
        if (mgrLocked()) return;
        // Percent for the same reason the export uses it — only a whole-number
        // change is written back, so a thousand-item merge repaints the label
        // a hundred times instead of a thousand.
        var lastPct = -1;
        importPickBackupFile({
            onStart: function () {
                if (_mgrState !== s) return;   // panel closed while the dialog was open
                s.importBusy = true;
                s.els.importBtn.disabled = true;
                s.els.importBtn.textContent = '导入中 0%';
                mgrRenderList();
            },
            onProgress: function (done, total) {
                if (_mgrState !== s) return;
                var pct = total ? Math.floor(done * 100 / total) : 100;
                if (pct === lastPct) return;
                lastPct = pct;
                s.els.importBtn.textContent = '导入中 ' + pct + '%';
            },
            onSettled: function (stats) {
                if (_mgrState !== s) return;   // panel closed mid-import
                s.importBusy = false;
                s.els.importBtn.disabled = false;
                s.els.importBtn.textContent = '导入备份文件';
                // A run that wrote nothing (refused, or every record already
                // present) leaves the index, the folder map and the header
                // totals valid, so the cursor walk is skipped and only the
                // controls are handed back.
                if (stats && (stats.added || stats.updated || stats.folders)) {
                    mgrRefreshIndex();
                    return;
                }
                mgrRenderList();
            }
        });
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
                +     '<div class="fav-fix-mgr-headmain">'
                +       '<div class="fav-fix-mgr-title">备份管理</div>'
                +       '<div class="fav-fix-mgr-stat">正在读取备份…</div>'
                +     '</div>'
                +     '<button class="fav-fix-mgr-btn fav-fix-mgr-btn-primary fav-fix-mgr-backup">备份当前收藏夹</button>'
                +     '<button class="fav-fix-mgr-btn fav-fix-mgr-close">关闭</button>'
                +   '</div>'
                +   '<div class="fav-fix-mgr-tools">'
                +     '<input class="fav-fix-mgr-input" type="text" placeholder="搜索标题 / BV 号 / UP 主">'
                +     '<label class="fav-fix-mgr-field"><span>收藏夹</span>'
                +       '<select class="fav-fix-mgr-select"><option value="*">全部</option></select>'
                +     '</label>'
                +     '<label class="fav-fix-mgr-field"><span>排序</span>'
                +       '<select class="fav-fix-mgr-select fav-fix-mgr-sort">'
                +         '<option value="fav_desc">最新收藏在前</option>'
                +         '<option value="fav_asc">最早收藏在前</option>'
                +         '<option value="backed_desc">最新备份在前</option>'
                +         '<option value="backed_asc">最早备份在前</option>'
                +       '</select>'
                +     '</label>'
                +   '</div>'
                +   '<div class="fav-fix-mgr-body">'
                +     '<div class="fav-fix-mgr-note">正在读取备份…</div>'
                +   '</div>'
                +   '<div class="fav-fix-mgr-foot">'
                // Neutral outline, no count: the red framing and the item
                // count on the bulk delete are a confirmation affordance for a
                // destructive act, and an export needs neither.
                +     '<button class="fav-fix-mgr-btn fav-fix-mgr-export" disabled>导出筛选结果</button>'
                // Beside the export and equally neutral: the two halves of the
                // same round trip belong next to each other, and both stay
                // quieter than the destructive action to their right.
                +     '<button class="fav-fix-mgr-btn fav-fix-mgr-import" disabled>导入备份文件</button>'
                +     '<button class="fav-fix-mgr-btn fav-fix-mgr-btn-danger fav-fix-mgr-bulk" disabled>删除当前筛选结果</button>'
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
                urls: [], renderToken: 0,
                // One flag per long operation rather than a single lock: they
                // exclude each other but disable different controls, and the
                // release paths are independent.
                busy: false, backupBusy: false, exportBusy: false, importBusy: false,
                searchTimer: null,
                onKeydown: null,
                els: {
                    stat:     host.querySelector('.fav-fix-mgr-stat'),
                    body:     host.querySelector('.fav-fix-mgr-body'),
                    search:   host.querySelector('.fav-fix-mgr-input'),
                    folder:   host.querySelector('.fav-fix-mgr-select'),
                    sort:     host.querySelector('.fav-fix-mgr-sort'),
                    backup:   host.querySelector('.fav-fix-mgr-backup'),
                    // Not `els.export`: a bare `export` identifier is reserved,
                    // and a property that cannot be destructured or aliased
                    // without care is not worth the two saved characters.
                    exportBtn: host.querySelector('.fav-fix-mgr-export'),
                    // Named importBtn for symmetry with exportBtn (and because
                    // `import` is a reserved word too).
                    importBtn: host.querySelector('.fav-fix-mgr-import'),
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
                }, cfg('mgrSearchDebounceMs'));
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
            s.els.exportBtn.addEventListener('click', mgrExportFiltered);
            s.els.importBtn.addEventListener('click', mgrImportBackup);
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
                if (mgrLocked()) return;
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
