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

    // ─── Mark a patched item ────────────────────────────────────────────
    //   - solid red outline (4px) on the cover img — uses CSS outline so
    //     it doesn't reflow layout; outline-offset:-4px tucks it inside
    //     the rounded-corner clip so it doesn't bleed past corners
    //   - rich hover tooltip showing title / UP / stats / dates / intro
    //   - data-fav-fix-marked guard avoids double-binding on observer re-runs

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
        // Bind tooltip handlers to the whole container so hovering anywhere
        // on the card triggers them. Read latest data from `__favFixReal`
        // inside the handler so cache refreshes propagate without re-binding.
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
        // 在 biliplus 打开、清缓存). Safe to call repeatedly; dedup via
        // data-fav-fix-key on the menu items themselves.
        try { injectCardMenu(hit, real); }
        catch (e) { warn('injectCardMenu threw:', e); }
    }

