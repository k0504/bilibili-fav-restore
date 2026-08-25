    // ─── Per-card menu injection ────────────────────────────────────────
    //
    // bilibili's own three-dot dropdown on each card (the "更多操作" menu)
    // is the most natural place for per-item actions — copy AV/BV/full
    // info, open the cover in a new tab, jump to a mirror site, clear
    // this item's cache. cerenkov's approach (mouseenter on the trigger,
    // delay 500ms, find the dynamically-rendered popper, append) works
    // well; we port it to vanilla and add dedup via data-fav-fix-key
    // so each item is only injected once per session.

    function buildPlainInfo(real) {
        var av = real.oid != null ? String(real.oid) : (real.bvid ? bvToAv(real.bvid) : null);
        var bv = real.bvid || (av ? avToBv(av) : null);
        // tag(field) → '[src]' or '' — inline source attribution.
        function tag(field) {
            var s = real['_src_' + field];
            return s ? ' [' + s + ']' : '';
        }
        var lines = [];
        lines.push('【fav-fix】数据来自收藏时的快照');
        lines.push('────────────');
        lines.push('标题：' + (real.title || '（无）') + tag('title'));
        // Mirror of the tooltip's cover row (AGENTS.md invariant: the two must
        // not diverge). Deliberately static — the copied text is a snapshot,
        // so the live three-way suppression read would be stale by the time
        // anyone reads the clipboard.
        if (real.cover)                lines.push('封面：（已恢复）' + tag('cover'));
        else if (real._cover_pending)  lines.push('封面：（后台重试中）');
        if (real.upper)                lines.push('UP 主：' + (real.upper.name || '（无）') + (real.upper.mid ? '  UID ' + real.upper.mid : '') + tag('upper'));
        if (av) lines.push('AV：av' + av);
        if (bv) lines.push('BV：' + bv + tag('bvid'));
        if (real.duration || real.playback_desc) lines.push('时长：' + (real.playback_desc || fmtDuration(real.duration)) + tag('duration'));
        if (real.cnt_info) {
            var c = real.cnt_info, bits = [];
            if (c.play     != null) bits.push('播放 ' + c.play);
            if (c.danmaku  != null) bits.push('弹幕 ' + c.danmaku);
            if (c.thumb_up != null) bits.push('点赞 ' + c.thumb_up);
            if (c.coin     != null) bits.push('投币 ' + c.coin);
            if (c.reply    != null) bits.push('评论 ' + c.reply);
            if (c.collect  != null) bits.push('收藏 ' + c.collect);
            if (bits.length) lines.push('数据：' + bits.join('  ·  ') + tag('cnt_info'));
        }
        if (real.tid != null)    lines.push('分区 TID：' + real.tid + tag('tid'));
        // Use the same fallback chain + source as the hover tooltip
        // (pickPubTs / pickPubSrc) so copied text matches what was shown.
        var _pubTs = pickPubTs(real);
        if (_pubTs) {
            var _pubSrc = pickPubSrc(real);
            lines.push('投稿：' + new Date(_pubTs * 1000).toLocaleString() + (_pubSrc ? ' [' + _pubSrc + ']' : ''));
        }
        if (real.fav_time)       lines.push('收藏：' + new Date(real.fav_time * 1000).toLocaleString() + tag('fav_time'));
        if (real.intro && real.intro.trim()) lines.push('简介：' + real.intro + tag('intro'));
        if (real.link)           lines.push('原 link：' + real.link);
        lines.push('────────────');
        if (real._sources) lines.push('数据来源：' + real._sources.join('、'));
        // Same split as buildTipHtml's footer: show "queried but empty"
        // sources so the user copying full info also sees the full chain.
        var pAttempted = real._attempted || real._attempted_3rd || [];
        var pMiss = pAttempted.filter(function (s) {
            return !real._sources || real._sources.indexOf(s) === -1;
        });
        if (pMiss.length) lines.push('已查询但无记录：' + pMiss.join('、'));
        return lines.join('\n');
    }

    function buildMenuItems(hit, real) {
        var av = real.oid != null ? String(real.oid) : (real.bvid ? bvToAv(real.bvid) : null);
        // Re-read the freshest cache entry. The `real` captured when injectCardMenu
        // bound this card's dropdown can be STALE: a pending card may have since
        // recovered (or vice-versa), and the new-UI popper handler keeps the
        // original closure. av/bv identity is stable, but _pending / title /
        // sources may have changed — build from the live entry so a recovered
        // card never shows "立即重试" and a pending card never copies an empty
        // snapshot. (buildMenuItems runs fresh on each menu open, so this stays
        // current.)
        if (av) { var _lc = loadCache(av); if (_lc) real = _lc; }
        var bv = real.bvid || (av ? avToBv(av) : null);
        // Same live-read reasoning as the loadCache line above, for the same
        // reason: the user may have stopped or resumed this av since the
        // dropdown was bound, and the closure would show the stale action.
        var stopped = av ? isNoRetryUser(av) : false;
        var items = [];
        // Retry controls, mutually exclusive by card state (the existing
        // 立即重试 / 清缓存并重抓 split, now with the stop switch folded in):
        //   stopped                       → 恢复重试 only. Offering 立即重试 next
        //                                   to it would be two buttons for one
        //                                   decision the user already made.
        //   _pending / _cover_pending     → 立即重试 (re-arm now) + 停止重试.
        //                                   Partial cards carry NO badge (the
        //                                   cover is chased quietly in the
        //                                   background), so the menu — plus the
        //                                   amber outline and the tooltip's
        //                                   封面 row — is their entry point.
        //                                   kickManualRetry re-derives the
        //                                   cover-only rule from loadCache, so
        //                                   a lone partial av is not retired by
        //                                   the title it already has.
        if (av && stopped) items.push({
            key: 'retry', label: '恢复重试',
            onClick: function () { resumeRetryForAv(av); }
        });
        else if (av && (real._pending || real._cover_pending)) {
            items.push({
                key: 'retry', label: '立即重试',
                onClick: function () { kickManualRetry(av); }
            });
            items.push({
                key: 'stop-retry', label: '停止重试',
                onClick: function () { stopRetryForAv(av); }
            });
        }
        if (av) items.push({
            key: 'cp-av', label: '复制 AV 号',
            successMsg: '已复制 av' + av + ' 至剪贴板',
            onClick: function () { GM_setClipboard('av' + av, 'text'); }
        });
        if (bv) items.push({
            key: 'cp-bv', label: '复制 BV 号',
            successMsg: '已复制 ' + bv + ' 至剪贴板',
            onClick: function () { GM_setClipboard(bv, 'text'); }
        });
        items.push({
            key: 'cp-info', label: '复制完整信息',
            successMsg: '完整信息已复制至剪贴板',
            onClick: function () { GM_setClipboard(buildPlainInfo(real), 'text'); }
        });
        // Cover URL may come from an untrusted 3rd-party source — only offer
        // "open cover" for an absolute http(s) URL (isHttpUrl rejects
        // javascript:/data: that GM_openInTab would otherwise navigate to).
        var coverUrl = real.cover ? String(real.cover).replace(/^http:\/\//, 'https://') : '';
        if (coverUrl && !COVER_PLACEHOLDER_RE.test(coverUrl) && isHttpUrl(coverUrl)) items.push({
            key: 'open-cover', label: '查看原始封面',
            onClick: function () {
                // Re-check at click time (defensive; coverUrl is captured above).
                if (!isHttpUrl(coverUrl)) { toast('封面链接异常，已拦截', 'warn'); return; }
                GM_openInTab(coverUrl, { active: true, insert: true, setParent: true });
            }
        });
        if (av) items.push({
            key: 'open-bp', label: '在 biliplus 查看',
            onClick: function () {
                GM_openInTab('https://www.biliplus.com/video/av' + av + '/',
                             { active: true, insert: true, setParent: true });
            }
        });
        // Hidden on _pending cards: they have no real cached snapshot to clear
        // (just a placeholder stub), so "清缓存并重抓" is a heavier, noisier
        // duplicate of "立即重试" (full-page foreground re-resolve + spinner
        // re-flash vs. a quiet android re-walk). Hidden on _cover_pending
        // (partial) cards for the opposite reason: they DO hold a real
        // title/UP/date snapshot, and clearing it discards data the card is
        // already displaying just to re-chase an image 立即重试 re-samples
        // without touching. The retry-flavored actions are mutually exclusive
        // by card state: 立即重试 for pending/partial, 清缓存并重抓 for
        // recovered/terminal cards where nuking a possibly-wrong snapshot
        // actually means something. (real is the live loadCache re-read above,
        // so this self-corrects as the card transitions pending↔recovered.)
        // Also hidden while the av is user-stopped: "恢复重试" already IS a
        // clear-and-refetch (resumeRetryForAv drops the caches and re-runs
        // patchOnce), and a second button that clears the cache while every
        // network path stays suppressed would only downgrade a patched card to
        // a bare pending stub.
        if (av && !real._pending && !real._cover_pending && !stopped) items.push({
            // Label kept short to avoid wrapping inside bilibili's
            // fixed-width card-menu popper. "清除本条缓存并重新抓取" (11
            // chars) wrapped to two lines and the second line overflowed
            // the popper bounds — see git log around this label change.
            key: 'clear-cache', label: '清缓存并重抓',
            successMsg: '缓存已清除，重新抓取中',
            onClick: function () {
                // An 'auto' 停止重试 record would silently gut this action:
                // the caches would be dropped and then resolveItems would skip
                // every network source, leaving the card worse off than before
                // the click. An explicit user action overrides what the loop
                // concluded, so drop that record too. (A 'user' record cannot be
                // present — this item is not offered for stopped cards.)
                clearNoRetry(av);
                // Cache nuke for this av (GM item + in-memory rows + page
                // promises). Shared with forceRefetch() via dropItemCaches so
                // both paths really re-fetch instead of re-merging stale rows.
                dropItemCaches(av);

                // The hit captured in this closure is from whenever
                // injectCardMenu was last called — possibly stale by now if
                // bilibili's SPA re-rendered the card. Operating on stale
                // refs paints overlays into detached subtrees that the user
                // never sees. Re-resolve to the LIVE element by hunting for
                // the card whose link mentions this av's avid or bvid.
                var bvid = null;
                try { bvid = avToBv(av); } catch (e) { /* invalid av */ }
                var sel = 'a[href*="/video/av' + av + '"]'
                        + (bvid ? ', a[href*="/video/' + bvid + '"]' : '');
                var liveContainer = null, liveImg = null;
                document.querySelectorAll(sel).forEach(function (a) {
                    if (liveContainer) return;
                    // Resolve to the WHOLE card (same scope findInvalidContainers
                    // now uses) so the title reset, mark-clearing, and the
                    // __favFixReal tooltip binding all act on the node markPatched
                    // actually touched — the cover-only sub-div never held the
                    // title leaf, which is why the reset used to miss it.
                    var card = a.closest(CARD_SELECTOR);
                    if (card) {
                        liveContainer = card;
                        liveImg = card.querySelector('img[src*="' + PLACEHOLDER_COVER_TOKEN + '"]')
                                  || card.querySelector('img');
                        return;
                    }
                    var n = a;
                    while (n && n !== document.body) {
                        var img = n.querySelector && n.querySelector('img');
                        if (img) { liveContainer = n; liveImg = img; return; }
                        n = n.parentElement;
                    }
                });
                // Fallback to closure hit if live lookup misses (defensive
                // — should not happen for a card the user just clicked).
                if (!liveContainer) liveContainer = hit && hit.container;
                if (!liveImg)       liveImg       = hit && hit.img;

                // Tear down any prior overlay on the LIVE img (rapid
                // double-click stacks spinners otherwise).
                if (liveImg) clearLoading({ img: liveImg, container: liveContainer });

                // Reset img: restore the placeholder src if we swapped it,
                // strip inline styles applied by markPatched / _no_source,
                // drop marker attrs so findInvalidContainers re-detects.
                if (liveImg) {
                    var orig = liveImg.getAttribute('data-fav-fix-original');
                    if (orig) {
                        liveImg.src = orig;
                        liveImg.removeAttribute('data-fav-fix-original');
                    }
                    liveImg.style.outline = '';
                    liveImg.style.outlineOffset = '';
                    liveImg.style.opacity = '';
                    liveImg.style.filter = '';
                    liveImg.removeAttribute('data-fav-fix-marked');
                    liveImg.removeAttribute('data-fav-fix-loading');
                    // Hygiene: the item is hidden for partial cards, but the
                    // card's state can shift between menu render and click —
                    // a full reset must not leave the amber partial marker.
                    liveImg.removeAttribute('data-fav-fix-partial');
                }
                // Reset container: revert any title text we wrote
                // (recovered title or "（视频已删除）"), drop marker attrs.
                // Keep `data-fav-fix-tipbound` + bound listeners — they
                // read __favFixReal live, so the next markPatched picks up
                // the new payload automatically.
                if (liveContainer) {
                    var prevReal = liveContainer.__favFixReal;
                    var patchedTitles = ['（视频已删除）'];
                    if (prevReal && prevReal.title) patchedTitles.push(prevReal.title);
                    var walker = document.createTreeWalker(liveContainer, NodeFilter.SHOW_TEXT, null);
                    var node;
                    while ((node = walker.nextNode())) {
                        var t = node.nodeValue.trim();
                        if (patchedTitles.indexOf(t) !== -1) {
                            node.nodeValue = node.nodeValue.replace(t, INVALID_TITLE);
                        }
                    }
                    patchedTitles.forEach(function (pt) {
                        liveContainer.querySelectorAll('[title="' + pt + '"]').forEach(function (el) {
                            el.setAttribute('title', INVALID_TITLE);
                        });
                    });
                    liveContainer.removeAttribute('data-fav-fix-marked');
                    liveContainer.removeAttribute('data-fav-fix-loading');
                    liveContainer.removeAttribute('data-fav-fix-partial');
                    liveContainer.__favFixReal = null;
                }

                // Paint spinner on the LIVE img immediately — user sees the
                // click took effect before any network round-trip.
                if (liveImg) markLoading({ img: liveImg, container: liveContainer });

                // Fire patchOnce immediately rather than going through
                // schedule()'s 400ms debounce — the user just told us they
                // want action now. patchOnce dedups via `data-fav-fix-loading`
                // so the spinner we just painted won't double-stack.
                patchOnce().catch(function (e) { warn('clear-cache patchOnce threw:', e); });
            }
        });
        return items;
    }

    function appendMenuItems(popper, items, opts) {
        // opts: { itemClass, itemTag }
        // Clear-then-append, NOT dedup-by-key. bilibili's new-UI dropdown reuses
        // / pools popper nodes across cards (observed: the same popper, or a
        // small pool, serves whichever card is hovered). The old dedup-by-key
        // kept the FIRST card's items when a different card reused the popper —
        // so a card could show a previous card's stale av bindings, or (once the
        // item set became state-specific) a recovered card showing 立即重试 / a
        // pending card showing 清缓存并重抓. Removing our prior items first
        // guarantees the popper reflects ONLY the current card. The handler
        // re-runs on every trigger mouseenter, so this stays fresh; it only ever
        // touches our own [data-fav-fix-key] nodes, never bilibili's.
        Array.from(popper.querySelectorAll('[data-fav-fix-key]')).forEach(function (el) { el.remove(); });
        items.forEach(function (it) {
            var el = document.createElement(opts.itemTag || 'div');
            el.className = opts.itemClass + ' bili-fav-fix-menu-item';
            el.setAttribute('data-fav-fix-key', it.key);
            el.textContent = it.label;
            el.style.cursor = 'pointer';
            // Hard cap on item width — bilibili's popper is fixed-width and
            // long labels otherwise wrap onto a 2nd line that bleeds past
            // the popper edge. nowrap + ellipsis truncates cleanly inside
            // the popper if someone ever adds a label past ~6 Chinese chars.
            el.style.whiteSpace   = 'nowrap';
            el.style.overflow     = 'hidden';
            el.style.textOverflow = 'ellipsis';
            el.addEventListener('click', function (e) {
                e.stopPropagation();
                try { it.onClick(); } catch (err) { warn('menu', it.key, 'threw', err); }
                // Confirmation goes to the toast (bottom-center), NOT back
                // into the menu cell. Previous in-place text replacement
                // (label = successMsg for 1.5s) caused the menu to bleed
                // out of bounds because the popper width is fixed and most
                // successMsgs were 10+ chars. Toast has its own width logic
                // (max-width + word-wrap) so it handles long strings.
                if (it.successMsg) toast(it.successMsg, 'ok');
            });
            popper.appendChild(el);
        });
    }

    function injectCardMenu(hit, real) {
        if (!hit.container) return;

        // New UI: trigger is .bili-card-dropdown inside the card; the
        // popper is rendered LATE (appended to body, not the card) and
        // gets class .visible only while it's open. Wait 500ms after
        // mouseenter to give the popper time to render before we look.
        var trigger = hit.container.querySelector('.bili-card-dropdown');
        if (trigger && !trigger.__favFixBound) {
            trigger.__favFixBound = true;
            trigger.addEventListener('mouseenter', function () {
                // Card mouseenter already fired our hover tooltip; close it
                // so it doesn't overlap with the B 站 native dropdown popper.
                // (mouseleave on the card never fires because the three-dot
                // is INSIDE the card.)
                hideTip();
                setTimeout(function () {
                    var popper = document.querySelector('.bili-card-dropdown-popper.visible');
                    if (!popper) { log('new-UI popper not visible at inject time'); return; }
                    hideTip();   // belt-and-suspenders: kill tooltip again when popper appears
                    appendMenuItems(popper, buildMenuItems(hit, real), {
                        itemClass: 'bili-card-dropdown-popper__item',
                        itemTag: 'div'
                    });
                }, 500);
            });
            return;
        }

        // Old UI: <ul class="be-dropdown-menu"> rendered inline inside
        // the card. We can append directly (no async wait). The trigger
        // is .be-dropdown-trigger; bind tooltip-hide on it too.
        var oldTrigger = hit.container.querySelector('.be-dropdown-trigger');
        if (oldTrigger && !oldTrigger.__favFixBound) {
            oldTrigger.__favFixBound = true;
            oldTrigger.addEventListener('mouseenter', hideTip);
        }
        var oldMenu = hit.container.querySelector('.be-dropdown-menu');
        if (oldMenu && !oldMenu.__favFixBound) {
            oldMenu.__favFixBound = true;
            appendMenuItems(oldMenu, buildMenuItems(hit, real), {
                itemClass: 'be-dropdown-item',
                itemTag: 'li'
            });
        }
    }

