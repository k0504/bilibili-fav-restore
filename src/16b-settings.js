    // ─── Settings modal ─────────────────────────────────────────────────
    //
    // Presentation for SETTINGS_SCHEMA (01a-settings.js) and nothing else. It
    // owns no defaults, no bounds and no validation: every row is generated
    // from a schema entry, every edit goes through cfgSet(), and every error
    // message shown here was produced by cfgCoerce(). Adding a tunable must
    // never require touching this file.
    //
    // ── Commit model ──
    // There is no 保存 button. Each field commits on `change` (blur or Enter)
    // and takes effect immediately, because every consumer reads cfg() at the
    // point of use. A rejected value is NOT written and NOT reverted: the
    // typed text stays put under an inline error so the user can correct it
    // rather than watch their input vanish.
    //
    // ── Layering ──
    // z-index sits one above the backup manager (15b), which is itself above
    // the FAB. The two panels are independent overlays and can legitimately be
    // open at once — settings reached from the Tampermonkey menu while the
    // manager sits behind it — so the newer one has to win.
    //
    // Node class names are prefixed `fav-fix-set-` and match none of
    // CARD_SELECTOR, so the MutationObserver's card scan never mistakes a row
    // for a bilibili video card.

    var _setHost = null;     // overlay root; non-null means the modal is open
    var _setGroup = null;    // id of the visible group
    var _setStylesInjected = false;

    function ensureSettingsStyles() {
        if (_setStylesInjected) return;
        _setStylesInjected = true;
        var st = document.createElement('style');
        st.id = '__fav_fix_set_styles';
        st.textContent = [
            // Same design language as the backup manager: white panel, #fb7299
            // reserved for the one accent, neutral grays for everything else.
            '.fav-fix-set-overlay {',
            '  position: fixed; inset: 0; z-index: 2147483647;',
            '  display: flex; align-items: center; justify-content: center;',
            '  background: rgba(24,25,28,.5);',
            '  font: 13px/1.5 -apple-system,"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei",sans-serif;',
            '  color: #18191c;',
            '}',
            '.fav-fix-set-panel {',
            '  width: min(760px, 92vw); max-height: 86vh;',
            '  display: flex; flex-direction: column;',
            '  background: #fff; border-radius: 10px; overflow: hidden;',
            '  box-shadow: 0 16px 48px rgba(0,0,0,.28);',
            '}',

            '.fav-fix-set-head {',
            '  flex: none; display: flex; align-items: center; gap: 8px;',
            '  padding: 14px 18px; border-bottom: 1px solid #f1f2f3; background: #fafbfc;',
            '}',
            '.fav-fix-set-head .t { font-size: 15px; font-weight: 600; }',
            '.fav-fix-set-head .v { font-size: 11px; color: #9499a0; }',
            '.fav-fix-set-head .n { margin-left: auto; font-size: 12px; color: #61666d; }',

            '.fav-fix-set-btn {',
            '  border: 1px solid #e3e5e7; background: #fff; color: #18191c;',
            '  border-radius: 6px; padding: 5px 12px; cursor: pointer;',
            '  font-size: 12px; line-height: 1.6; transition: background .12s, border-color .12s;',
            '}',
            '.fav-fix-set-btn:hover { background: #f6f7f8; border-color: #d0d3d6; }',
            '.fav-fix-set-btn[disabled] { opacity: .45; cursor: default; }',
            '.fav-fix-set-btn[disabled]:hover { background: #fff; border-color: #e3e5e7; }',
            '.fav-fix-set-btn.warn { color: #e13c53; border-color: rgba(225,60,83,.35); }',
            '.fav-fix-set-btn.warn:hover { background: rgba(225,60,83,.06); border-color: rgba(225,60,83,.55); }',

            '.fav-fix-set-tabs {',
            '  flex: none; display: flex; gap: 2px; padding: 0 12px;',
            '  border-bottom: 1px solid #f1f2f3; overflow-x: auto;',
            '}',
            '.fav-fix-set-tab {',
            '  flex: none; padding: 10px 12px; cursor: pointer; color: #61666d;',
            '  font-size: 13px; border-bottom: 2px solid transparent;',
            '  transition: color .12s, border-color .12s;',
            '}',
            '.fav-fix-set-tab:hover { color: #18191c; }',
            '.fav-fix-set-tab.on { color: #fb7299; border-bottom-color: #fb7299; font-weight: 600; }',
            // A dot, not a number: the tab strip answers "is anything changed
            // in there", and the exact count is already in the header.
            '.fav-fix-set-tab .dot[hidden] { display: none; }',
            '.fav-fix-set-tab .dot {',
            '  display: inline-block; width: 5px; height: 5px; margin-left: 5px;',
            '  border-radius: 50%; background: #fb7299; vertical-align: middle;',
            '}',

            '.fav-fix-set-body { flex: 1 1 auto; overflow-y: auto; padding: 4px 18px 12px; }',
            '.fav-fix-set-row {',
            '  display: flex; align-items: flex-start; gap: 16px;',
            '  padding: 14px 0; border-bottom: 1px solid #f4f5f6;',
            '}',
            '.fav-fix-set-row:last-child { border-bottom: 0; }',
            '.fav-fix-set-main { flex: 1 1 auto; min-width: 0; }',
            '.fav-fix-set-label { font-size: 13px; font-weight: 600; }',
            '.fav-fix-set-tag {',
            '  margin-left: 6px; padding: 0 5px; border-radius: 3px; vertical-align: 1px;',
            '  font-size: 10px; font-weight: 400; color: #fb7299; background: rgba(251,114,153,.1);',
            '}',
            '.fav-fix-set-desc { margin-top: 3px; font-size: 12px; color: #9499a0; }',
            '.fav-fix-set-err { margin-top: 4px; font-size: 12px; color: #e13c53; }',
            '.fav-fix-set-ctl { flex: none; display: flex; align-items: center; gap: 6px; padding-top: 1px; }',
            '.fav-fix-set-in {',
            '  width: 110px; box-sizing: border-box;',
            '  border: 1px solid #e3e5e7; border-radius: 6px; padding: 5px 8px;',
            '  font: inherit; font-size: 13px; color: #18191c; background: #fff;',
            '  text-align: right; transition: border-color .12s;',
            '}',
            '.fav-fix-set-in.wide { width: 236px; text-align: left; }',
            '.fav-fix-set-in:focus { outline: none; border-color: #fb7299; }',
            '.fav-fix-set-in.bad { border-color: #e13c53; }',
            '.fav-fix-set-unit { flex: none; width: 32px; font-size: 12px; color: #9499a0; }',
            '.fav-fix-set-rst {',
            '  flex: none; width: 44px; border: 0; background: none; padding: 0;',
            '  font: inherit; font-size: 12px; color: #9499a0; cursor: pointer;',
            '}',
            '.fav-fix-set-rst:hover { color: #fb7299; }',
            '.fav-fix-set-rst[hidden] { visibility: hidden; display: block; }',

            // Switch. A real <button role="switch"> rather than a restyled
            // checkbox: keyboard behaviour and aria-checked come for free.
            '.fav-fix-set-sw {',
            '  width: 40px; height: 22px; flex: none; padding: 0; cursor: pointer;',
            '  border: 1px solid #e3e5e7; border-radius: 11px; background: #f1f2f3;',
            '  position: relative; transition: background .15s, border-color .15s;',
            '}',
            '.fav-fix-set-sw::after {',
            '  content: ""; position: absolute; top: 2px; left: 2px;',
            '  width: 16px; height: 16px; border-radius: 50%; background: #fff;',
            '  box-shadow: 0 1px 3px rgba(0,0,0,.25); transition: transform .15s;',
            '}',
            '.fav-fix-set-sw[aria-checked="true"] { background: #fb7299; border-color: #fb7299; }',
            '.fav-fix-set-sw[aria-checked="true"]::after { transform: translateX(18px); }',

            '.fav-fix-set-foot {',
            '  flex: none; display: flex; align-items: center; gap: 8px;',
            '  padding: 12px 18px; border-top: 1px solid #f1f2f3; background: #fafbfc;',
            '}',
            '.fav-fix-set-note { margin-left: auto; font-size: 11px; color: #9499a0; text-align: right; }'
        ].join('\n');
        (document.head || document.documentElement).appendChild(st);
    }

    // ── Row rendering ───────────────────────────────────────────────────

    // How many settings currently differ from their shipped default, overall
    // and per group. Recomputed on every commit; the whole set is ~30 entries
    // read from a memo, so there is nothing to cache.
    function setChangedCounts() {
        var out = { total: 0, byGroup: {} };
        for (var i = 0; i < SETTINGS_SCHEMA.length; i++) {
            var e = SETTINGS_SCHEMA[i];
            if (cfgIsDefault(e.key)) continue;
            out.total++;
            out.byGroup[e.group] = (out.byGroup[e.group] || 0) + 1;
        }
        return out;
    }

    // The text a field shows for a value. An intlist is edited as the comma
    // list the user would write, not as a JSON array.
    function setDisplay(e, v) {
        return Array.isArray(v) ? v.join(', ') : String(v);
    }

    function setBuildRow(e) {
        var row = document.createElement('div');
        row.className = 'fav-fix-set-row';

        var main = document.createElement('div');
        main.className = 'fav-fix-set-main';
        var lab = document.createElement('div');
        lab.className = 'fav-fix-set-label';
        lab.textContent = e.label;
        var tag = document.createElement('span');
        tag.className = 'fav-fix-set-tag';
        tag.textContent = '已修改';
        lab.appendChild(tag);
        var desc = document.createElement('div');
        desc.className = 'fav-fix-set-desc';
        desc.textContent = e.desc;
        var err = document.createElement('div');
        err.className = 'fav-fix-set-err';
        err.hidden = true;
        main.appendChild(lab); main.appendChild(desc); main.appendChild(err);

        var ctl = document.createElement('div');
        ctl.className = 'fav-fix-set-ctl';

        var rst = document.createElement('button');
        rst.type = 'button';
        rst.className = 'fav-fix-set-rst';
        rst.textContent = '重置';
        rst.title = '恢复默认值 ' + setDisplay(e, e.def);

        // Repaint the row's own state (tag, reset affordance, error) plus the
        // two aggregate readouts. Every commit path ends here, so "what the
        // row looks like" is defined in exactly one place.
        function refresh(errorText) {
            var isDef = cfgIsDefault(e.key);
            tag.hidden = isDef;
            rst.hidden = isDef;
            err.hidden = !errorText;
            err.textContent = errorText || '';
            setRefreshCounts();
        }

        var input = null, sw = null;

        if (e.type === 'bool') {
            sw = document.createElement('button');
            sw.type = 'button';
            sw.className = 'fav-fix-set-sw';
            sw.setAttribute('role', 'switch');
            sw.setAttribute('aria-label', e.label);
            sw.setAttribute('aria-checked', cfg(e.key) ? 'true' : 'false');
            sw.addEventListener('click', function () {
                var next = sw.getAttribute('aria-checked') !== 'true';
                var r = cfgSet(e.key, next);
                if (!r.ok) { refresh(r.error); return; }
                sw.setAttribute('aria-checked', r.value ? 'true' : 'false');
                refresh('');
            });
            ctl.appendChild(sw);
            // Keeps the switch column aligned with the input column above it.
            var pad = document.createElement('span');
            pad.className = 'fav-fix-set-unit';
            ctl.appendChild(pad);
        } else {
            input = document.createElement('input');
            input.type = 'text';
            input.className = 'fav-fix-set-in' + (e.type === 'intlist' ? ' wide' : '');
            if (e.type === 'int') {
                input.setAttribute('inputmode', 'numeric');
                input.title = '取值范围 ' + e.min + ' – ' + e.max;
            }
            input.value = setDisplay(e, cfg(e.key));
            input.addEventListener('change', function () {
                var r = cfgSet(e.key, input.value);
                if (!r.ok) {
                    // Deliberately keeps the rejected text: replacing it with
                    // the stored value would delete the user's work and leave
                    // them guessing which character was wrong.
                    input.classList.add('bad');
                    refresh(r.error);
                    return;
                }
                input.classList.remove('bad');
                // Normalizes what was typed ("1000,2000" → "1000, 2000") so the
                // field shows the value as it was actually stored.
                input.value = setDisplay(e, r.value);
                refresh('');
            });
            // Enter commits. Without this the value only lands on blur, and a
            // user who types and closes the panel loses the edit.
            input.addEventListener('keydown', function (ev) {
                if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
            });
            ctl.appendChild(input);
            var unit = document.createElement('span');
            unit.className = 'fav-fix-set-unit';
            unit.textContent = e.unit || '';
            ctl.appendChild(unit);
        }

        rst.addEventListener('click', function () {
            var r = cfgReset(e.key);
            if (!r.ok) { refresh(r.error); return; }
            if (input) { input.value = setDisplay(e, r.value); input.classList.remove('bad'); }
            if (sw) sw.setAttribute('aria-checked', r.value ? 'true' : 'false');
            refresh('');
        });
        ctl.appendChild(rst);

        row.appendChild(main);
        row.appendChild(ctl);
        refresh('');
        return row;
    }

    // The header count and the per-tab dots. Split out because a commit deep
    // inside one row has to move readouts that live outside it.
    function setRefreshCounts() {
        if (!_setHost) return;
        var c = setChangedCounts();
        var n = _setHost.querySelector('.fav-fix-set-count');
        if (n) n.textContent = c.total ? ('已修改 ' + c.total + ' 项') : '全部为默认值';
        var tabs = _setHost.querySelectorAll('.fav-fix-set-tab');
        for (var i = 0; i < tabs.length; i++) {
            var gid = tabs[i].getAttribute('data-group');
            var dot = tabs[i].querySelector('.dot');
            if (dot) dot.hidden = !c.byGroup[gid];
        }
        var resetAll = _setHost.querySelector('.fav-fix-set-resetall');
        if (resetAll) resetAll.disabled = !c.total;
        var resetGrp = _setHost.querySelector('.fav-fix-set-resetgrp');
        if (resetGrp) resetGrp.disabled = !c.byGroup[_setGroup];
    }

    function setRenderBody() {
        if (!_setHost) return;
        var body = _setHost.querySelector('.fav-fix-set-body');
        body.textContent = '';
        for (var i = 0; i < SETTINGS_SCHEMA.length; i++) {
            if (SETTINGS_SCHEMA[i].group !== _setGroup) continue;
            body.appendChild(setBuildRow(SETTINGS_SCHEMA[i]));
        }
        body.scrollTop = 0;
        var tabs = _setHost.querySelectorAll('.fav-fix-set-tab');
        for (var t = 0; t < tabs.length; t++) {
            tabs[t].classList.toggle('on', tabs[t].getAttribute('data-group') === _setGroup);
        }
        setRefreshCounts();
    }

    // ── Open / close ────────────────────────────────────────────────────

    function closeSettings() {
        if (!_setHost) return;
        document.removeEventListener('keydown', setOnKeydown, true);
        _setHost.remove();
        _setHost = null;
    }

    function setOnKeydown(ev) {
        if (ev.key !== 'Escape' || !_setHost) return;
        ev.stopPropagation();
        closeSettings();
    }

    function openSettings() {
        // Already open: bring the user back to the panel rather than stacking a
        // second copy over the first (the TM menu can fire while it is open).
        if (_setHost) { _setHost.querySelector('.fav-fix-set-panel').focus(); return; }
        ensureSettingsStyles();
        _setGroup = _setGroup || SETTINGS_GROUPS[0].id;

        var host = document.createElement('div');
        host.className = 'fav-fix-set-overlay';
        host.setAttribute('data-fav-fix-settings', '1');

        var panel = document.createElement('div');
        panel.className = 'fav-fix-set-panel';
        panel.setAttribute('tabindex', '-1');

        var head = document.createElement('div');
        head.className = 'fav-fix-set-head';
        head.innerHTML = '<span class="t">设置</span><span class="v"></span>'
                       + '<span class="n fav-fix-set-count"></span>';
        head.querySelector('.v').textContent = CORE_VERSION;
        var closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'fav-fix-set-btn';
        closeBtn.textContent = '关闭';
        closeBtn.addEventListener('click', closeSettings);
        head.appendChild(closeBtn);

        var tabs = document.createElement('div');
        tabs.className = 'fav-fix-set-tabs';
        for (var i = 0; i < SETTINGS_GROUPS.length; i++) {
            (function (g) {
                var tab = document.createElement('div');
                tab.className = 'fav-fix-set-tab';
                tab.setAttribute('data-group', g.id);
                tab.textContent = g.label;
                var dot = document.createElement('span');
                dot.className = 'dot';
                dot.hidden = true;
                tab.appendChild(dot);
                tab.addEventListener('click', function () {
                    _setGroup = g.id;
                    setRenderBody();
                });
                tabs.appendChild(tab);
            })(SETTINGS_GROUPS[i]);
        }

        var body = document.createElement('div');
        body.className = 'fav-fix-set-body';

        var foot = document.createElement('div');
        foot.className = 'fav-fix-set-foot';
        var rg = document.createElement('button');
        rg.type = 'button';
        rg.className = 'fav-fix-set-btn fav-fix-set-resetgrp';
        rg.textContent = '恢复本组默认值';
        rg.addEventListener('click', function () {
            var n = cfgResetAll(_setGroup);
            setRenderBody();
            toast(n ? ('已恢复 ' + n + ' 项默认值') : '本组已全部为默认值', 'ok');
        });
        var ra = document.createElement('button');
        ra.type = 'button';
        ra.className = 'fav-fix-set-btn warn fav-fix-set-resetall';
        ra.textContent = '恢复全部默认值';
        ra.addEventListener('click', function () {
            var n = cfgResetAll();
            setRenderBody();
            toast(n ? ('已恢复 ' + n + ' 项默认值') : '当前已全部为默认值', 'ok');
        });
        var note = document.createElement('div');
        note.className = 'fav-fix-set-note';
        // Both facts belong here rather than in a per-row caption: they are
        // properties of the settings mechanism, not of any one setting. The
        // cross-tab limit is the same one the 停止重试 list carries (07a).
        note.textContent = '修改即时生效，无需保存；其他已打开的标签页需刷新后才会读到新值';
        foot.appendChild(rg); foot.appendChild(ra); foot.appendChild(note);

        panel.appendChild(head);
        panel.appendChild(tabs);
        panel.appendChild(body);
        panel.appendChild(foot);
        host.appendChild(panel);

        // Backdrop click closes; a click that started inside the panel must
        // not, or dragging a text selection out of a field would shut it.
        host.addEventListener('mousedown', function (ev) {
            if (ev.target === host) closeSettings();
        });

        document.body.appendChild(host);
        _setHost = host;
        setRenderBody();
        document.addEventListener('keydown', setOnKeydown, true);
        panel.focus();
    }
