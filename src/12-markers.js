    // ─── Loading indicator ──────────────────────────────────────────────
    //   Painted the instant findInvalidContainers() returns a hit (BEFORE
    //   any API call). Visual = white semi-transparent overlay on the cover
    //   area with a centered gray rotating ring. The user picked this style
    //   over the previous orange-pulse-outline + corner-badge combo.
    //
    //   Lifecycle:
    //     - markLoading(hit) on detect (patchOnce, before resolveItems)
    //     - clearLoading(hit) on resolve failure (patchOnce catch)
    //     - clearLoading(hit) on _no_source / no-img path (markPatched call)
    //     - clearLoading(hit) on img.onload / onerror (success-with-cover
    //       path) so the overlay outlives the cover-src swap and the user
    //       doesn't see the gray placeholder flicker to the real cover
    //     - clearLoading(hit) safety-net timer (4s) for edge cases where
    //       neither onload nor onerror fires (browser-cached src etc.)
    //
    //   Idempotent via data-fav-fix-loading on img + container. Skips hits
    //   with no img (Strategy 2 / inline-SVG placeholders): they have no
    //   cover area to anchor an overlay to, so no visual feedback there —
    //   acceptable, those hits are rare.

    var _loadingStylesInjected = false;
    function ensureLoadingStyles() {
        if (_loadingStylesInjected) return;
        _loadingStylesInjected = true;
        var st = document.createElement('style');
        st.id = '__fav_fix_loading_styles';
        st.textContent = [
            // Spinner: only rotate is animated; centering is via flexbox on
            // the overlay parent, so the transform doesn't fight the
            // centering math (a common spinner bug).
            '@keyframes __fav_fix_spin {',
            '  to { transform: rotate(360deg); }',
            '}',
            '.fav-fix-loading-overlay {',
            '  position: absolute; inset: 0;',
            '  background: rgba(255,255,255,.42);',
            '  z-index: 2147483645;',
            '  pointer-events: none;',
            '  display: flex; align-items: center; justify-content: center;',
            // Inherit cover rounded corners so the overlay doesn't bleed
            // past the card's curved edges. bilibili cover wraps use ~6px
            // border-radius; `inherit` picks that up automatically.
            '  border-radius: inherit;',
            '}',
            '.fav-fix-loading-spinner {',
            '  width: 32px; height: 32px;',
            // Ring effect: faint full circle + opaque top arc that rotates.
            '  border: 3px solid rgba(120,120,120,.22);',
            '  border-top-color: rgba(80,80,80,.85);',
            '  border-radius: 50%;',
            '  animation: __fav_fix_spin 0.9s linear infinite;',
            '}'
        ].join('\n');
        (document.head || document.documentElement).appendChild(st);
    }

    function markLoading(hit) {
        // Skip if no img — Strategy 2 (title-text fallback) hits have no
        // cover area to anchor an overlay to. Painting on the whole card
        // container would obscure the title/footer too aggressively.
        if (!hit || !hit.img) return;
        if (hit.img.getAttribute('data-fav-fix-loading')) return; // dedup
        if (hit.img.getAttribute('data-fav-fix-marked'))  return; // already done

        ensureLoadingStyles();
        var coverWrap = hit.img.parentElement;
        if (!coverWrap) return;
        // Defensive: if bilibili's cover wrap happens to be position:static
        // (shouldn't be — they have play-time badges etc. that need it),
        // promote to relative so the overlay anchors correctly. Won't
        // affect layout when already positioned.
        var pos = (coverWrap.ownerDocument.defaultView || window)
                    .getComputedStyle(coverWrap).position;
        if (pos === 'static') coverWrap.style.position = 'relative';

        var overlay = document.createElement('div');
        overlay.className = 'fav-fix-loading-overlay';
        overlay.setAttribute('data-fav-fix-overlay', '1');
        var spinner = document.createElement('div');
        spinner.className = 'fav-fix-loading-spinner';
        overlay.appendChild(spinner);
        coverWrap.appendChild(overlay);

        hit.img.setAttribute('data-fav-fix-loading', '1');
        // Mark container too so stats().cardsLoading reflects card count
        // (a card == one img). Container attr is the truth source for
        // counting; img attr is what the dedup check reads.
        if (hit.container) hit.container.setAttribute('data-fav-fix-loading', '1');
    }

    function clearLoading(hit) {
        if (!hit) return;
        if (hit.img) {
            hit.img.removeAttribute('data-fav-fix-loading');
            var coverWrap = hit.img.parentElement;
            if (coverWrap) {
                var overlay = coverWrap.querySelector('[data-fav-fix-overlay]');
                if (overlay) overlay.remove();
            }
        }
        if (hit.container) {
            hit.container.removeAttribute('data-fav-fix-loading');
            // Belt-and-braces: scan container for orphaned overlays in case
            // some bilibili DOM reshuffle moved the img between markLoading
            // and clearLoading (rare but observed on virtualized scrolls).
            var stray = hit.container.querySelectorAll('[data-fav-fix-overlay]');
            for (var i = 0; i < stray.length; i++) stray[i].remove();
        }
    }

    // ─── Retry indicator (background android flap recovery) ──────────────
    //   A small corner badge on the cover so the user can SEE that a deleted
    //   item is being re-fetched in the background (runFlapRecovery), instead
    //   of the card looking inert — and, since 0.13.0, the switch that turns
    //   that retrying off. Three states, passed as a string:
    //     'active'  → spinning dot + "重试中" (loop alive — owns the retry,
    //                 keeps sampling android on its backoff)
    //     'waiting' → pulsing gray + "待重试" (loop gave up; a fresh reload
    //                 re-kicks it, OR the card's "立即重试" menu item does so
    //                 on demand via kickManualRetry)
    //     'stopped' → static dark gray + "已停止重试" (the user pressed the
    //                 badge; the av is on the 停止重试 list and no automatic
    //                 path will request it again)
    //   Hovering swaps the label to the action the click performs (停止重试 /
    //   恢复重试). That swap is PURE CSS — two spans, one hidden by :hover —
    //   because MutationObserver re-runs the patch pass constantly and a JS
    //   textContent swap would fight the hover state on every tick.
    //   The badge is just the at-a-glance cue; the FULL explanation of what the
    //   three states mean lives in the card's hover tooltip (buildTipHtml's
    //   _pending branch), bound for pending cards via bindCardAffordances.
    //   Removed by clearPending() the moment the item recovers (real cover) or
    //   is written terminal. Distinct from markLoading's full-cover overlay so
    //   it reads as "still trying" rather than "page loading". No emoji.
    var _retryStylesInjected = false;
    function ensureRetryStyles() {
        if (_retryStylesInjected) return;
        _retryStylesInjected = true;
        var st = document.createElement('style');
        st.id = '__fav_fix_retry_styles';
        st.textContent = [
            '@keyframes __fav_fix_retry_spin { to { transform: rotate(360deg); } }',
            '@keyframes __fav_fix_retry_pulse { 0%,100%{opacity:.95} 50%{opacity:.5} }',
            '.fav-fix-retry-badge {',
            '  position:absolute; left:6px; top:6px; z-index:2147483646;',
            '  display:flex; align-items:center; gap:5px;',
            '  padding:3px 7px; border-radius:10px;',
            '  font:600 11px/1 -apple-system,Segoe UI,sans-serif;',
            '  color:#fff; background:rgba(192,57,43,.82);',
            // The badge is a BUTTON now, so it has to receive the pointer —
            // but only the root: children with their own hit area would let a
            // click land on a node whose handler we never bound.
            '  pointer-events:auto; cursor:pointer; user-select:none;',
            '}',
            '.fav-fix-retry-badge > * { pointer-events:none; }',
            '.fav-fix-retry-badge .fav-fix-retry-dot {',
            '  width:9px; height:9px; border-radius:50%;',
            '  border:2px solid rgba(255,255,255,.4); border-top-color:#fff;',
            '  animation:__fav_fix_retry_spin .8s linear infinite;',
            '}',
            '.fav-fix-retry-badge.waiting {',
            '  background:rgba(127,140,141,.8);',
            '  animation:__fav_fix_retry_pulse 1.8s ease-in-out infinite;',
            '}',
            '.fav-fix-retry-badge.waiting .fav-fix-retry-dot { animation:none; border-top-color:rgba(255,255,255,.55); }',
            // Stopped: no animation anywhere and no spinner dot — the card must
            // read as "nothing is happening here", which is the whole point.
            '.fav-fix-retry-badge.stopped {',
            '  background:rgba(60,64,67,.88);',
            '  animation:none;',
            '}',
            '.fav-fix-retry-badge.stopped .fav-fix-retry-dot { display:none; }',
            // Label swap on hover, CSS-only (see the block comment above).
            '.fav-fix-retry-badge .fav-fix-retry-hover { display:none; }',
            '.fav-fix-retry-badge:hover .fav-fix-retry-idle { display:none; }',
            '.fav-fix-retry-badge:hover .fav-fix-retry-hover { display:inline; }'
        ].join('\n');
        (document.head || document.documentElement).appendChild(st);
    }

    // Resting label / hover label per state. The hover label always names the
    // ACTION the click performs, never the state it is in.
    var RETRY_BADGE_TEXT = {
        active:  { idle: '重试中',     hover: '停止重试' },
        waiting: { idle: '待重试',     hover: '停止重试' },
        stopped: { idle: '已停止重试', hover: '恢复重试' }
    };

    // Write a state onto an existing badge. Early-returns when the state is
    // unchanged so the observer's repeated patch passes don't churn text nodes
    // under the user's cursor. data-fav-fix-retry-state is also the click
    // handler's source of truth (see bindRetryBadge).
    function applyRetryBadgeState(badge, state) {
        if (!RETRY_BADGE_TEXT[state]) state = 'waiting';
        if (badge.getAttribute('data-fav-fix-retry-state') === state) return;
        badge.setAttribute('data-fav-fix-retry-state', state);
        badge.classList.toggle('waiting', state === 'waiting');
        badge.classList.toggle('stopped', state === 'stopped');
        var idle  = badge.querySelector('[data-fav-fix-retry-txt]');
        var hover = badge.querySelector('[data-fav-fix-retry-hover]');
        if (idle)  idle.textContent  = RETRY_BADGE_TEXT[state].idle;
        if (hover) hover.textContent = RETRY_BADGE_TEXT[state].hover;
    }

    // The two user-facing transitions, defined once so the cover badge, the
    // card menu (11-menu.js) and the debug surface (17-boot.js) cannot drift.
    function stopRetryForAv(av) {
        setNoRetryUser(av);
        toast('已停止重试，可再次点击恢复', 'ok');
        // Repaint so any other card of the same av (and the badge, when the
        // caller did not update it in place) reflects the new state.
        schedule();
    }
    function resumeRetryForAv(av) {
        clearNoRetry(av);
        // Drop the _pending stub as well: with the suppression gone the whole
        // point is to ask the network again, and a live short-TTL stub would
        // have patchOnce serve the cached "still nothing" instead.
        dropItemCaches(av);
        toast('已恢复重试，正在重新抓取', 'ok');
        patchOnce().catch(function (e) { warn('resume-retry patchOnce threw:', e); });
    }

    // Bind the badge's click ONCE per element. Idempotent via __favFixBadgeBound
    // because markPending re-runs on every observer tick for the same node.
    function bindRetryBadge(badge) {
        if (badge.__favFixBadgeBound) return;
        badge.__favFixBadgeBound = true;
        // The badge sits inside the card, and the card is an <a>. stopPropagation
        // keeps the event away from the card's own handlers and from bilibili's
        // document-level delegates, but it does NOT stop the anchor's default
        // navigation — that needs preventDefault. Both are applied to mousedown
        // as well as click: bilibili has document-level listeners that rewrite
        // anchor behaviour (AGENTS.md gotcha 20, last bullet — an <a> appended to
        // the document had its blob: href hijacked and navigated the whole tab),
        // and some of that machinery acts before a click event ever exists.
        var swallow = function (e) { e.preventDefault(); e.stopPropagation(); };
        badge.addEventListener('mousedown', swallow);
        badge.addEventListener('click', function (e) {
            swallow(e);
            // Read av + state from the DOM at click time, never from a closure:
            // this node is reused by later render passes (and by bilibili's
            // virtualized scroll), so a captured value goes stale the moment the
            // card's state — or the card itself — changes.
            var av = badge.getAttribute('data-fav-fix-retry-av');
            if (!av) return;
            if (badge.getAttribute('data-fav-fix-retry-state') === 'stopped') {
                // Flip out of 'stopped' HERE, for the same reason the stop
                // direction flips in place below — only more so: nothing
                // repaints this card until applyPatch runs after the whole
                // resolve (phase 2 alone is budgeted at 10s), and the loading
                // overlay sits BELOW the badge, so a badge still reading
                // 已停止重试 stays visible and clickable throughout. A second
                // click would re-enter resumeRetryForAv: another cache drop,
                // another toast, and a _patchDirty second full resolve pass.
                applyRetryBadgeState(badge, _flapBgRunning ? 'active' : 'waiting');
                resumeRetryForAv(av);
            } else {
                // Flip the badge in place rather than waiting for the next
                // render pass: the flap loop may be mid-backoff and nothing else
                // would touch this card for up to two minutes.
                applyRetryBadgeState(badge, 'stopped');
                stopRetryForAv(av);
            }
        });
    }

    function markPending(hit, state, av) {
        if (!hit || !hit.img) return;          // need a cover area to anchor to
        var coverWrap = hit.img.parentElement;
        if (!coverWrap) return;
        ensureRetryStyles();
        var pos = (coverWrap.ownerDocument.defaultView || window)
                    .getComputedStyle(coverWrap).position;
        if (pos === 'static') coverWrap.style.position = 'relative';
        var badge = coverWrap.querySelector('[data-fav-fix-retry]');
        if (!badge) {
            badge = document.createElement('div');
            badge.setAttribute('data-fav-fix-retry', '1');
            badge.className = 'fav-fix-retry-badge';
            var dot = document.createElement('span');
            dot.className = 'fav-fix-retry-dot';
            var txt = document.createElement('span');
            txt.className = 'fav-fix-retry-idle';
            txt.setAttribute('data-fav-fix-retry-txt', '1');
            var hov = document.createElement('span');
            hov.className = 'fav-fix-retry-hover';
            hov.setAttribute('data-fav-fix-retry-hover', '1');
            badge.appendChild(dot);
            badge.appendChild(txt);
            badge.appendChild(hov);
            coverWrap.appendChild(badge);
        }
        // Re-stamped every pass: the same badge node can end up serving a
        // different card after a virtualized re-render.
        badge.setAttribute('data-fav-fix-retry-av', av == null ? '' : String(av));
        applyRetryBadgeState(badge, state);
        bindRetryBadge(badge);
    }

    function clearPending(hit) {
        if (!hit) return;
        var scopes = [];
        if (hit.img && hit.img.parentElement) scopes.push(hit.img.parentElement);
        if (hit.container) scopes.push(hit.container);
        for (var s = 0; s < scopes.length; s++) {
            var b = scopes[s].querySelectorAll('[data-fav-fix-retry]');
            for (var i = 0; i < b.length; i++) b[i].remove();
        }
    }

    // ─── Mark a patched item ────────────────────────────────────────────
    //   - solid red outline (4px) on the cover img — uses CSS outline so
    //     it doesn't reflow layout; outline-offset:-4px tucks it inside
    //     the rounded-corner clip so it doesn't bleed past corners
    //   - rich hover tooltip showing title / UP / stats / dates / intro
    //   - data-fav-fix-marked guard avoids double-binding on observer re-runs

    // Bind the hover tooltip + inject our card-menu items onto a card, WITHOUT
    // touching its cover / outline / title. markPatched calls this for recovered
    // and terminal cards; applyPatch's pending branch calls it directly so a
    // card still being chased by the flap loop ALSO gets the rich tooltip (now a
    // 重试中/待重试 state explainer) and the "立即重试" menu item — previously
    // pending cards skipped markPatched entirely and were left with only a bare
    // badge. __favFixReal is read live by the tooltip handler, so a later
    // markPatched (on recovery) upgrades the tooltip in place without re-binding.
    function bindCardAffordances(hit, real) {
        var bindEl = hit.container || hit.img;
        if (!bindEl) return;
        bindEl.__favFixReal = real;
        if (!bindEl.getAttribute('data-fav-fix-tipbound')) {
            bindEl.setAttribute('data-fav-fix-tipbound', '1');
            bindEl.addEventListener('mouseenter', function (e) {
                if (bindEl.__favFixReal) showTip(bindEl, bindEl.__favFixReal, e);
            });
            bindEl.addEventListener('mouseleave', hideTip);
        }
        // Inject per-card menu items (复制 AV/BV、复制完整信息、查看封面、
        // 在 biliplus 打开、清缓存、以及 pending 卡的「立即重试」). Safe to call
        // repeatedly; dedup via data-fav-fix-key on the menu items themselves.
        try { injectCardMenu(hit, real); }
        catch (e) { warn('injectCardMenu threw:', e); }
    }

    function markPatched(hit, real) {
        // NOTE: clearLoading() is NOT called here. The caller (patchOnce
        // application loop) decides when to clear:
        //   - _no_source / Strategy-2 paths: clear immediately, no img-load
        //     to wait on.
        //   - success-with-cover path: wait for img.onload before clearing
        //     so the overlay covers the placeholder-to-real-cover swap.
        // Calling clearLoading here would defeat that "wait for onload"
        // behavior — the overlay would vanish the instant patchCover
        // assigns the new src, exposing the gray placeholder for the
        // ~150ms CDN download window.
        // Two visual styles:
        //   - recovered (any source returned data): solid red outline, the
        //     "we know what this used to be" cue.
        //   - unrecoverable (real._no_source): dashed gray outline, the
        //     "we tried every source and they all whiffed" cue. Lower
        //     visual weight so it doesn't shout when the situation is
        //     literally unfixable (true 404).
        var isUnrecoverable = real && real._no_source;
        var outlineCss = isUnrecoverable
            ? '3px dashed rgba(127,140,141,.85)'
            : '4px solid rgba(192,57,43,.85)';

        if (hit.img && !hit.img.getAttribute('data-fav-fix-marked')) {
            hit.img.setAttribute('data-fav-fix-marked', isUnrecoverable ? 'nodata' : '1');
            hit.img.style.outline = outlineCss;
            hit.img.style.outlineOffset = '-4px';
        }
        // Also mark the container so `stats().cardsMarked` reflects EVERY
        // patched card — not just ones whose placeholder was a real <img>.
        // Some bilibili layouts render the deleted-video placeholder as an
        // inline SVG inside the card with no <img> tag at all; those cards
        // hit findInvalidContainers via the title-text fallback and have
        // hit.img === null.
        if (hit.container && !hit.container.getAttribute('data-fav-fix-marked')) {
            hit.container.setAttribute('data-fav-fix-marked', isUnrecoverable ? 'nodata' : '1');
        }
        // Tooltip + card-menu binding, extracted so the pending branch
        // (applyPatch) can reuse it without the outline/title work above.
        bindCardAffordances(hit, real);
    }

