    // ─── Floating action button + two-level menu ────────────────────────
    //
    // A draggable circular button pinned to the viewport, opening a two-level
    // menu over every command this script has. It exists because the
    // Tampermonkey menu (16-menu-commands.js) is a flat list of twelve
    // same-looking rows buried behind the extension's toolbar popup: three
    // clicks away, no grouping, no live state, and invisible to anyone who
    // does not already know the script is installed.
    //
    // Both surfaces call the SAME cmd* functions — see 16-menu-commands.js.
    // This module owns presentation only; it must never implement a command.
    //
    // ── Interaction contract ──
    //   press + move  → drag the button (position persisted, GM 'fab:pos')
    //   press + release without moving → toggle the menu
    //   menu level 0  → categories; level 1 → that category's commands,
    //                   with 返回 as the first row (the user's stated shape)
    //
    // ── Geometry constraint (learned the hard way elsewhere) ──
    // The menu MUST be position:absolute, anchored on the button. If it sat
    // in flow, the host's box would be menu-sized (~238×400) and the drag
    // clamp — which keeps the HOST inside the viewport — would strand the
    // 48px button somewhere mid-screen, unable to reach any edge. With the
    // menu absolute the host box IS the button, so the clamp is exact.

    var FAB_POS_KEY     = 'fab:pos';   // GM key → { left, top } viewport px
    var FAB_SIZE        = 48;          // keep in sync with .fav-fix-fab-btn
    var FAB_EDGE_GAP    = 8;           // min distance from any viewport edge
    var FAB_DRAG_TAP_PX = 4;           // below this a press is a click, not a drag

    var _fabHost = null, _fabBtn = null, _fabMenu = null, _fabBody = null;
    var _fabOpen = false;
    var _fabCat  = null;    // null = level 0, else the open category's id
    var _fabDragging = false;
    // Set when a drag ends, consumed by the click handler. Without it every
    // release fires the click that follows a mouseup and the menu pops open
    // at the end of each drag.
    var _fabSuppressClick = false;
    var _fabStylesInjected = false;

    // Live right-hand hints. Computed at render time, never cached: the whole
    // point is that the menu reports the state as it is when it opens.
    function fabDebugHint()   { return DEBUG ? '已开启' : '已关闭'; }
    function fabAuthHint()    { var a = getAuth(); return a.access_key ? (a.mode || '已登录') : '未登录'; }
    function fabNoRetryHint() { var c = noRetryCounts(); var n = c.user + c.auto; return n ? n + ' 项' : '无'; }
    function fabPageHint()    { var n = pendingAvsOnPage().length; return n ? n + ' 项' : '无'; }

    // The menu tree. Data, not code: one place to read what the script can do.
    // `danger: true` paints the row red — reserved for the two commands that
    // destroy state the user cannot get back by clicking again.
    var FAB_MENU = [
        { id: 'account', label: '账号与登录', hint: fabAuthHint, items: [
            { label: '登录（TV 端二维码）',   run: function () { tvLogin(); } },
            { label: '登录（手动输入凭据）',  run: function () { manualLogin(); } },
            { label: '查看登录状态',          run: cmdAuthStatus, hint: fabAuthHint },
            { label: '注销（清除登录凭据）',  run: cmdLogout, danger: true }
        ] },
        { id: 'scan', label: '扫描与修复', items: [
            { label: '立即重新扫描并修复',    run: cmdRescan },
            { label: '扫描静默丢弃的条目',    run: cmdScanMissing }
        ] },
        { id: 'retry', label: '重试控制', hint: fabPageHint, items: [
            { label: '本页全部停止重试',      run: cmdStopRetryThisPage, hint: fabPageHint },
            { label: '清除所有「停止重试」标记', run: cmdClearAllNoRetry, hint: fabNoRetryHint }
        ] },
        { id: 'backup', label: '备份', items: [
            { label: '备份当前收藏夹',        run: cmdBackupFolder },
            { label: '管理备份',              run: cmdManageBackup }
        ] },
        { id: 'maint', label: '维护与调试', items: [
            { label: '开关调试日志',          run: cmdToggleDebug, hint: fabDebugHint },
            { label: '清除所有缓存并刷新页面', run: cmdClearAllCache, danger: true }
        ] }
    ];

    var FAB_ICON_IDLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.49.49 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>';
    var FAB_ICON_OPEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

    function ensureFabStyles() {
        if (_fabStylesInjected) return;
        _fabStylesInjected = true;
        var st = document.createElement('style');
        st.id = '__fav_fix_fab_styles';
        st.textContent = [
            '@keyframes __fav_fix_fab_in { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }',
            // Host: the button's box and nothing more (see the geometry note
            // at the top of this file). Default anchor is bottom-right, clear
            // of bilibili's own back-to-top control.
            '.fav-fix-fab {',
            '  position:fixed; right:24px; bottom:172px; z-index:2147483645;',
            '  width:' + FAB_SIZE + 'px; height:' + FAB_SIZE + 'px;',
            '  font:13px/1.5 -apple-system,"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei",sans-serif;',
            '}',
            '.fav-fix-fab-btn {',
            '  width:100%; height:100%; border-radius:50%;',
            '  display:flex; align-items:center; justify-content:center;',
            '  background:#fb7299; color:#fff; cursor:pointer; user-select:none;',
            '  box-shadow:0 4px 14px rgba(251,114,153,.45);',
            '  transition:background .15s, box-shadow .15s, transform .12s;',
            '}',
            '.fav-fix-fab-btn:hover { background:#e8618a; box-shadow:0 6px 18px rgba(251,114,153,.55); }',
            '.fav-fix-fab-btn:active { transform:scale(.94); }',
            '.fav-fix-fab-btn svg { width:24px; height:24px; display:block; fill:currentColor; }',
            // Children never receive pointer events: the drag handler needs
            // mousedown on the button itself, and an inner <svg> target would
            // make the geometry read from the wrong element.
            '.fav-fix-fab-btn * { pointer-events:none; }',
            '.fav-fix-fab.open .fav-fix-fab-btn { background:#18191c; box-shadow:0 4px 14px rgba(0,0,0,.35); }',
            '.fav-fix-fab.open .fav-fix-fab-btn:hover { background:#2f3238; }',
            '.fav-fix-fab.dragging .fav-fix-fab-btn {',
            '  cursor:grabbing; transform:scale(1.06);',
            '  box-shadow:0 0 0 4px rgba(251,114,153,.28), 0 8px 20px rgba(0,0,0,.28);',
            '}',

            '.fav-fix-fab-menu {',
            '  position:absolute; width:244px; display:none;',
            '  background:#fff; border:1px solid #e3e5e7; border-radius:10px;',
            '  box-shadow:0 10px 30px rgba(0,0,0,.16); overflow:hidden;',
            '}',
            '.fav-fix-fab.open .fav-fix-fab-menu { display:block; animation:__fav_fix_fab_in .14s ease-out; }',
            // Four anchor combinations, chosen per open() from where the
            // button currently sits, so the menu never opens off-screen.
            '.fav-fix-fab.up   .fav-fix-fab-menu { bottom:' + (FAB_SIZE + 12) + 'px; top:auto; }',
            '.fav-fix-fab.down .fav-fix-fab-menu { top:' + (FAB_SIZE + 12) + 'px; bottom:auto; }',
            '.fav-fix-fab.ra   .fav-fix-fab-menu { right:0; left:auto; }',
            '.fav-fix-fab.la   .fav-fix-fab-menu { left:0; right:auto; }',

            '.fav-fix-fab-head {',
            '  display:flex; align-items:baseline; gap:6px;',
            '  padding:10px 12px; border-bottom:1px solid #f1f2f3; background:#fafbfc;',
            '}',
            '.fav-fix-fab-head .t { font-size:13px; font-weight:600; color:#18191c; }',
            '.fav-fix-fab-head .v { font-size:11px; color:#9499a0; }',
            '.fav-fix-fab-list { max-height:min(62vh,440px); overflow-y:auto; padding:4px 0; }',
            '.fav-fix-fab-row {',
            '  display:flex; align-items:center; gap:8px;',
            '  padding:9px 12px; cursor:pointer; color:#18191c;',
            '  font-size:13px; transition:background .12s;',
            '}',
            '.fav-fix-fab-row:hover { background:#f6f7f8; }',
            '.fav-fix-fab-row .lb { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
            '.fav-fix-fab-row .hint { flex:none; font-size:11px; color:#9499a0; }',
            '.fav-fix-fab-row .chev { flex:none; font-size:15px; line-height:1; color:#c9ccd0; }',
            '.fav-fix-fab-row.danger { color:#e13c53; }',
            '.fav-fix-fab-row.danger:hover { background:rgba(225,60,83,.06); }',
            '.fav-fix-fab-row.danger .hint { color:rgba(225,60,83,.7); }',
            // The back row is the first thing in a level-1 list, per the
            // stated design: one fixed place to go up, always at the top.
            '.fav-fix-fab-back {',
            '  display:flex; align-items:center; gap:6px;',
            '  padding:9px 12px; cursor:pointer; background:#fafbfc;',
            '  border-bottom:1px solid #f1f2f3; transition:background .12s;',
            '}',
            '.fav-fix-fab-back:hover { background:#f1f2f3; }',
            '.fav-fix-fab-back .arw { font-size:15px; line-height:1; color:#61666d; }',
            '.fav-fix-fab-back .bk  { font-size:12px; color:#61666d; }',
            '.fav-fix-fab-back .cat { margin-left:auto; font-size:12px; font-weight:600; color:#18191c; }',
            '.fav-fix-fab-tip { padding:8px 12px 10px; font-size:11px; color:#9499a0; border-top:1px solid #f1f2f3; }'
        ].join('\n');
        (document.head || document.documentElement).appendChild(st);
    }

    // ── Position ────────────────────────────────────────────────────────

    function fabClamp(left, top) {
        var w = _fabHost.offsetWidth  || FAB_SIZE;
        var h = _fabHost.offsetHeight || FAB_SIZE;
        var maxL = Math.max(FAB_EDGE_GAP, window.innerWidth  - w - FAB_EDGE_GAP);
        var maxT = Math.max(FAB_EDGE_GAP, window.innerHeight - h - FAB_EDGE_GAP);
        return {
            left: Math.min(Math.max(FAB_EDGE_GAP, left), maxL),
            top:  Math.min(Math.max(FAB_EDGE_GAP, top),  maxT)
        };
    }

    // Applying an inline left/top MUST clear the CSS default anchor, or the
    // surviving `right`/`bottom` fights the new coordinates and the button
    // drifts a little further every reload.
    function fabApplyPos(left, top) {
        var p = fabClamp(left, top);
        _fabHost.style.left   = p.left + 'px';
        _fabHost.style.top    = p.top  + 'px';
        _fabHost.style.right  = 'auto';
        _fabHost.style.bottom = 'auto';
        return p;
    }

    function fabLoadPos() {
        var raw = GM_getValue(FAB_POS_KEY, null);
        if (!raw) return;
        try {
            var p = (typeof raw === 'string') ? JSON.parse(raw) : raw;
            if (p && isFinite(p.left) && isFinite(p.top)) fabApplyPos(p.left, p.top);
        } catch (e) { warn('fab: bad saved position', e); }
    }

    function fabSavePos(p) {
        try { GM_setValue(FAB_POS_KEY, { left: p.left, top: p.top }); }
        catch (e) { warn('fab: cannot persist position', e); }
    }

    // Clear the persisted position and fall back to the CSS anchor. A button
    // dragged somewhere awkward otherwise has no way home: the coordinates
    // live in GM storage, which the page console cannot reach.
    function fabResetPosition() {
        try { GM_deleteValue(FAB_POS_KEY); } catch (e) { warn('fab: cannot clear position', e); }
        if (_fabHost) {
            _fabHost.style.left = '';
            _fabHost.style.top = '';
            _fabHost.style.right = '';
            _fabHost.style.bottom = '';
        }
        return 'fab position reset';
    }

    // ── Menu rendering ──────────────────────────────────────────────────

    function fabRow(cls, label, hint, chev) {
        var row = document.createElement('div');
        row.className = cls;
        var lb = document.createElement('span');
        lb.className = 'lb';
        lb.textContent = label;
        row.appendChild(lb);
        if (hint) {
            var h = document.createElement('span');
            h.className = 'hint';
            h.textContent = hint;
            row.appendChild(h);
        }
        if (chev) {
            var c = document.createElement('span');
            c.className = 'chev';
            c.textContent = chev;
            row.appendChild(c);
        }
        return row;
    }

    // Read a hint callback without letting a broken one blank the whole menu.
    function fabHint(fn) {
        if (typeof fn !== 'function') return '';
        try { return fn() || ''; } catch (e) { warn('fab: hint threw', e); return ''; }
    }

    function fabRenderMenu() {
        _fabBody.textContent = '';
        var i;
        if (!_fabCat) {
            var head = document.createElement('div');
            head.className = 'fav-fix-fab-head';
            var t = document.createElement('span'); t.className = 't'; t.textContent = 'fav-fix';
            var v = document.createElement('span'); v.className = 'v'; v.textContent = CORE_VERSION;
            head.appendChild(t); head.appendChild(v);
            _fabBody.appendChild(head);

            var list = document.createElement('div');
            list.className = 'fav-fix-fab-list';
            for (i = 0; i < FAB_MENU.length; i++) {
                (function (cat) {
                    var row = fabRow('fav-fix-fab-row', cat.label, fabHint(cat.hint), '›');
                    row.addEventListener('click', function (e) {
                        e.preventDefault(); e.stopPropagation();
                        _fabCat = cat.id;
                        fabRenderMenu();
                    });
                    list.appendChild(row);
                })(FAB_MENU[i]);
            }
            _fabBody.appendChild(list);

            var tip = document.createElement('div');
            tip.className = 'fav-fix-fab-tip';
            tip.textContent = '按住此按钮可拖动位置';
            _fabBody.appendChild(tip);
            return;
        }

        var cat = null;
        for (i = 0; i < FAB_MENU.length; i++) if (FAB_MENU[i].id === _fabCat) cat = FAB_MENU[i];
        // The open category vanished (only reachable if FAB_MENU changed under
        // us). Fall back to the top level rather than rendering an empty menu.
        if (!cat) { _fabCat = null; fabRenderMenu(); return; }

        var back = document.createElement('div');
        back.className = 'fav-fix-fab-back';
        var arw = document.createElement('span'); arw.className = 'arw'; arw.textContent = '‹';
        var bk  = document.createElement('span'); bk.className  = 'bk';  bk.textContent  = '返回';
        var nm  = document.createElement('span'); nm.className  = 'cat'; nm.textContent  = cat.label;
        back.appendChild(arw); back.appendChild(bk); back.appendChild(nm);
        back.addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation();
            _fabCat = null;
            fabRenderMenu();
        });
        _fabBody.appendChild(back);

        var ilist = document.createElement('div');
        ilist.className = 'fav-fix-fab-list';
        for (i = 0; i < cat.items.length; i++) {
            (function (item) {
                var cls = 'fav-fix-fab-row' + (item.danger ? ' danger' : '');
                var row = fabRow(cls, item.label, fabHint(item.hint), '');
                row.addEventListener('click', function (e) {
                    e.preventDefault(); e.stopPropagation();
                    // Close FIRST: several commands open a modal of their own
                    // (login, backup manager) and the menu would sit on top of
                    // it. A throwing command must not leave the menu open
                    // either, hence the try/catch around the call only.
                    fabClose();
                    try { item.run(); }
                    catch (err) { warn('fab: command threw', err); toast('操作失败：' + (err && err.message), 'err'); }
                });
                ilist.appendChild(row);
            })(cat.items[i]);
        }
        _fabBody.appendChild(ilist);
    }

    // ── Open / close ────────────────────────────────────────────────────

    // Anchor the menu on the side with room for it. Decided per open, from the
    // button's live rect, because the button can be anywhere by then.
    function fabPlaceMenu() {
        var r = _fabHost.getBoundingClientRect();
        var openUp = (r.top + r.height / 2) > window.innerHeight / 2;
        var alignRight = (r.left + r.width / 2) > window.innerWidth / 2;
        _fabHost.classList.toggle('up',   openUp);
        _fabHost.classList.toggle('down', !openUp);
        _fabHost.classList.toggle('ra',   alignRight);
        _fabHost.classList.toggle('la',   !alignRight);
    }

    function fabOpen() {
        if (_fabOpen) return;
        _fabOpen = true;
        _fabCat = null;              // always land on the categories
        fabRenderMenu();
        fabPlaceMenu();
        _fabHost.classList.add('open');
        _fabBtn.innerHTML = FAB_ICON_OPEN;
        _fabBtn.title = '关闭菜单';
    }

    function fabClose() {
        if (!_fabOpen) return;
        _fabOpen = false;
        _fabCat = null;
        _fabHost.classList.remove('open');
        _fabBtn.innerHTML = FAB_ICON_IDLE;
        _fabBtn.title = 'fav-fix 菜单（按住可拖动）';
    }

    // ── Drag ────────────────────────────────────────────────────────────

    function fabBindDrag() {
        _fabBtn.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            var r = _fabHost.getBoundingClientRect();
            var dx = e.clientX - r.left, dy = e.clientY - r.top;
            var startX = e.clientX, startY = e.clientY;
            var moved = false;
            var last = { left: r.left, top: r.top };

            function onMove(ev) {
                if (!moved) {
                    if (Math.abs(ev.clientX - startX) < FAB_DRAG_TAP_PX &&
                        Math.abs(ev.clientY - startY) < FAB_DRAG_TAP_PX) return;
                    moved = true;
                    _fabDragging = true;
                    _fabHost.classList.add('dragging');
                    // A menu left open would travel with the button and fight
                    // the anchor classes recomputed on the next open.
                    fabClose();
                }
                last = fabApplyPos(ev.clientX - dx, ev.clientY - dy);
            }
            function onUp() {
                document.removeEventListener('mousemove', onMove, true);
                document.removeEventListener('mouseup', onUp, true);
                if (!moved) return;
                _fabDragging = false;
                _fabHost.classList.remove('dragging');
                // Swallow the click that follows this mouseup, or every drag
                // ends by popping the menu open.
                _fabSuppressClick = true;
                fabSavePos(last);
            }
            document.addEventListener('mousemove', onMove, true);
            document.addEventListener('mouseup', onUp, true);
        });
    }

    // ── Install ─────────────────────────────────────────────────────────

    function installFab() {
        if (_fabHost) return;
        ensureFabStyles();

        _fabHost = document.createElement('div');
        _fabHost.className = 'fav-fix-fab';
        _fabHost.setAttribute('data-fav-fix-fab', '1');

        _fabBtn = document.createElement('div');
        _fabBtn.className = 'fav-fix-fab-btn';
        _fabBtn.setAttribute('role', 'button');
        _fabBtn.setAttribute('tabindex', '0');
        _fabBtn.title = 'fav-fix 菜单（按住可拖动）';
        _fabBtn.innerHTML = FAB_ICON_IDLE;

        _fabMenu = document.createElement('div');
        _fabMenu.className = 'fav-fix-fab-menu';
        _fabBody = _fabMenu;

        _fabHost.appendChild(_fabBtn);
        _fabHost.appendChild(_fabMenu);
        document.body.appendChild(_fabHost);

        // Position is applied only after the host is in the document: a
        // detached (or display:none) node measures 0×0 and the clamp would
        // compute its bounds against the whole viewport.
        fabLoadPos();
        fabBindDrag();

        _fabBtn.addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation();
            if (_fabSuppressClick) { _fabSuppressClick = false; return; }
            if (_fabOpen) fabClose(); else fabOpen();
        });
        _fabMenu.addEventListener('click', function (e) { e.stopPropagation(); });

        document.addEventListener('click', function (e) {
            if (!_fabOpen) return;
            if (_fabHost.contains(e.target)) return;
            fabClose();
        }, true);
        document.addEventListener('keydown', function (e) {
            if (!_fabOpen) return;
            // Esc backs out one level, matching the on-screen 返回 row, and
            // closes only from the top level.
            if (e.key !== 'Escape') return;
            if (_fabCat) { _fabCat = null; fabRenderMenu(); } else { fabClose(); }
        });
        window.addEventListener('resize', function () {
            var r = _fabHost.getBoundingClientRect();
            // Only re-clamp a dragged button. One left at the CSS default has
            // no inline left/top, and writing one here would freeze it away
            // from its anchor.
            if (_fabHost.style.left) fabApplyPos(r.left, r.top);
            if (_fabOpen) fabPlaceMenu();
        });
    }

