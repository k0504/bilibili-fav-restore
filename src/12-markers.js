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
        // Partial cards (markPartial below) already display a real title; a
        // TTL-expiry re-resolve must not flash a spinner over content the
        // user can read while only the cover is still being chased.
        if (hit.img.getAttribute('data-fav-fix-partial')) return;

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
            // Status only, never a click target. The action lives in the
            // centred button below, where the user can actually see it.
            '  pointer-events:none; user-select:none;',
            '}',
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
            // Stopped: no animation anywhere and no spinner dot. The card must
            // read as "nothing is happening here", which is the whole point.
            '.fav-fix-retry-badge.stopped {',
            '  background:rgba(60,64,67,.88);',
            '  animation:none;',
            '}',
            '.fav-fix-retry-badge.stopped .fav-fix-retry-dot { display:none; }',
            // THE action control: a real button, centred on the cover, visible
            // at rest. An earlier revision made the corner badge itself
            // clickable, and a status label reads as a status label no matter
            // what it does on hover. The affordance has to be its own object,
            // sitting where the eye already lands.
            //
            // Icon-only and circular: a labelled pill covers a third of the
            // cover art. The wording survives as title + aria-label, so the
            // meaning is one hover away and screen readers still get it.
            '.fav-fix-retry-action {',
            '  position:absolute; left:50%; top:50%;',
            '  transform:translate(-50%,-50%); z-index:2147483646;',
            '  width:52px; height:52px; border-radius:50%;',
            '  display:flex; align-items:center; justify-content:center;',
            '  border:1px solid rgba(255,255,255,.18);',
            '  color:#fff; background:rgba(28,28,30,.86);',
            '  cursor:pointer; pointer-events:auto; user-select:none;',
            '  box-shadow:0 2px 10px rgba(0,0,0,.35);',
            '  transition:background .15s, box-shadow .15s, transform .12s;',
            '}',
            '.fav-fix-retry-action svg { width:36px; height:36px; display:block; fill:currentColor; }',
            '.fav-fix-retry-action > * { pointer-events:none; }',
            // Every transform here MUST re-state translate(-50%,-50%): the
            // centring lives in the same property, so a bare scale() would
            // snap the button to the cover's bottom-right quadrant on hover.
            '.fav-fix-retry-action:hover {',
            '  background:rgba(192,57,43,.92); box-shadow:0 3px 14px rgba(0,0,0,.45);',
            '  transform:translate(-50%,-50%) scale(1.08);',
            '}',
            '.fav-fix-retry-action:active { transform:translate(-50%,-50%) scale(.94); }',
            '.fav-fix-retry-action.resume:hover { background:rgba(52,120,190,.92); }'
        ].join('\n');
        (document.head || document.documentElement).appendChild(st);
    }

    // Badge label per state. Status wording only; it is not clickable.
    var RETRY_BADGE_TEXT = {
        active:  '重试中',
        waiting: '待重试',
        stopped: '已停止重试'
    };
    // Button wording per state. Names the ACTION, never the state. No longer
    // rendered as visible text — it is the button's title and accessible name.
    var RETRY_ACTION_TEXT = {
        active:  '停止重试',
        waiting: '停止重试',
        stopped: '恢复重试'
    };
    // Button glyph per state. A stop square and a refresh arrow, deliberately
    // NOT a pause/play pair: a play triangle centred on a video cover reads as
    // "play this video", which is exactly the wrong thing to suggest here.
    var RETRY_ACTION_ICON = {
        active:  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
        waiting: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
        stopped: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>'
    };

    // Write a state onto an existing badge. Early-returns when the state is
    // unchanged so the observer's repeated patch passes don't churn text nodes.
    function applyRetryBadgeState(badge, state) {
        if (!RETRY_BADGE_TEXT[state]) state = 'waiting';
        if (badge.getAttribute('data-fav-fix-retry-state') === state) return;
        badge.setAttribute('data-fav-fix-retry-state', state);
        badge.classList.toggle('waiting', state === 'waiting');
        badge.classList.toggle('stopped', state === 'stopped');
        var t = badge.querySelector('[data-fav-fix-retry-txt]');
        if (t) t.textContent = RETRY_BADGE_TEXT[state];
    }

    // Same for the action button. data-fav-fix-retry-state on the BUTTON is the
    // click handler's source of truth, so it is stamped here rather than read
    // off the badge: the two nodes are updated in the same pass, but the
    // handler must not depend on that ordering.
    function applyRetryActionState(btn, state) {
        if (!RETRY_ACTION_TEXT[state]) state = 'waiting';
        btn.classList.toggle('resume', state === 'stopped');
        if (btn.getAttribute('data-fav-fix-retry-state') === state) return;
        btn.setAttribute('data-fav-fix-retry-state', state);
        btn.innerHTML = RETRY_ACTION_ICON[state];
        btn.title = RETRY_ACTION_TEXT[state];
        btn.setAttribute('aria-label', RETRY_ACTION_TEXT[state]);
    }

    // The two user-facing transitions, defined once so the cover button, the
    // card menu (11-menu.js) and the debug surface (17-boot.js) cannot drift.
    function stopRetryForAv(av) {
        setNoRetryUser(av);
        toast('已停止重试，可再次点击恢复', 'ok');
        // Repaint so any other card of the same av (and the control, when the
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

    // Bind the button's click ONCE per element. Idempotent via
    // __favFixActionBound because markPending re-runs on every observer tick
    // for the same node.
    function bindRetryAction(btn) {
        if (btn.__favFixActionBound) return;
        btn.__favFixActionBound = true;
        // The button sits inside the card, and the card is an <a>.
        // stopPropagation keeps the event away from the card's own handlers and
        // from bilibili's document-level delegates, but it does NOT stop the
        // anchor's default navigation, which needs preventDefault. Both are
        // applied to mousedown as well as click: bilibili has document-level
        // listeners that rewrite anchor behaviour (AGENTS.md gotcha 20, last
        // bullet: an <a> appended to the document had its blob: href hijacked
        // and navigated the whole tab), and some of that machinery acts before
        // a click event ever exists.
        var swallow = function (e) { e.preventDefault(); e.stopPropagation(); };
        btn.addEventListener('mousedown', swallow);
        btn.addEventListener('click', function (e) {
            swallow(e);
            // Read av + state from the DOM at click time, never from a closure:
            // this node is reused by later render passes (and by bilibili's
            // virtualized scroll), so a captured value goes stale the moment the
            // card's state, or the card itself, changes.
            var av = btn.getAttribute('data-fav-fix-retry-av');
            if (!av) return;
            if (btn.getAttribute('data-fav-fix-retry-state') === 'stopped') {
                // Flip out of 'stopped' HERE: nothing repaints this card until
                // applyPatch runs after the whole resolve (phase 2 alone is
                // budgeted at 10s), and a button still reading the resume label
                // stays clickable throughout. A second click would re-enter
                // resumeRetryForAv: another cache drop, another toast, and a
                // _patchDirty second full resolve pass.
                applyRetryActionState(btn, _flapBgRunning ? 'active' : 'waiting');
                resumeRetryForAv(av);
            } else {
                // Flip in place rather than waiting for the next render pass:
                // the flap loop may be mid-backoff and nothing else would touch
                // this card for up to two minutes.
                applyRetryActionState(btn, 'stopped');
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
            txt.setAttribute('data-fav-fix-retry-txt', '1');
            badge.appendChild(dot);
            badge.appendChild(txt);
            coverWrap.appendChild(badge);
        }
        applyRetryBadgeState(badge, state);

        // The control itself, centred on the cover. Created alongside the badge
        // and torn down with it (clearPending removes both).
        var btn = coverWrap.querySelector('[data-fav-fix-retry-action]');
        if (!btn) {
            btn = document.createElement('div');
            btn.setAttribute('data-fav-fix-retry-action', '1');
            btn.setAttribute('role', 'button');
            btn.setAttribute('tabindex', '0');
            btn.className = 'fav-fix-retry-action';
            coverWrap.appendChild(btn);
        }
        // Re-stamped every pass: the same nodes can end up serving a different
        // card after a virtualized re-render.
        btn.setAttribute('data-fav-fix-retry-av', av == null ? '' : String(av));
        applyRetryActionState(btn, state);
        bindRetryAction(btn);
    }

    function clearPending(hit) {
        if (!hit) return;
        var scopes = [];
        if (hit.img && hit.img.parentElement) scopes.push(hit.img.parentElement);
        if (hit.container) scopes.push(hit.container);
        for (var s = 0; s < scopes.length; s++) {
            // Both nodes: the corner status badge and the centred action button.
            var b = scopes[s].querySelectorAll('[data-fav-fix-retry], [data-fav-fix-retry-action]');
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

    // ─── Mark a PARTIALLY patched item (_cover_pending) ─────────────────
    //   Title recovered and painted, cover still a placeholder while the
    //   background loop chases the image. Honest visual = amber dashed
    //   outline, sitting between recovered (solid red) and unrecoverable
    //   (dashed gray). Deliberately does NOT set data-fav-fix-marked: the
    //   img keeps its placeholder src, so findInvalidContainers Strategy 1
    //   (`:not([data-fav-fix-marked])`) keeps re-finding the card every
    //   pass — and the moment the loop saveCache()s a merge that carries a
    //   cover, the next patchOnce re-detects it, loadCache returns the
    //   upgraded merge, and applyPatch's recovered branch paints the cover
    //   IN PLACE (no virtual-scroll node recreation required). Marking it
    //   would reopen exactly that repaint gap. Idempotence rides on our own
    //   data-fav-fix-partial attribute instead, which Strategy 1 ignores.
    //   No badge on purpose: the cover chase is a quiet background fill,
    //   not a _pending retry owner (see AGENTS.md gotcha 20).
    function markPartial(hit, real) {
        if (hit.img && !hit.img.getAttribute('data-fav-fix-partial')) {
            hit.img.setAttribute('data-fav-fix-partial', '1');
            hit.img.style.outline = '3px dashed rgba(230,162,60,.9)';
            hit.img.style.outlineOffset = '-3px';
        }
        // Container too: covers Strategy-2 no-img cards and feeds
        // stats().cardsPartial, same split as markPatched above.
        if (hit.container && !hit.container.getAttribute('data-fav-fix-partial')) {
            hit.container.setAttribute('data-fav-fix-partial', '1');
        }
        bindCardAffordances(hit, real);
    }

    // Undo markPartial. The img guard keeps this from wiping a recovered
    // card's solid-red outline on repeated passes: only an img that actually
    // carries the partial attribute has the amber outline to reset.
    function clearPartial(hit) {
        if (!hit) return;
        if (hit.img && hit.img.getAttribute('data-fav-fix-partial')) {
            hit.img.removeAttribute('data-fav-fix-partial');
            hit.img.style.outline = '';
            hit.img.style.outlineOffset = '';
        }
        if (hit.container) hit.container.removeAttribute('data-fav-fix-partial');
    }

