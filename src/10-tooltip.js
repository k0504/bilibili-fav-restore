    // ─── Hover tooltip (rich) ───────────────────────────────────────────

    // Third-party archives (xbeibeix HTML scrape, biliplus, jijidown) are an
    // untrusted boundary: a poisoned/compromised source could return a
    // cover/avatar URL of `javascript:…` or `data:text/html,…`. Setting such
    // a value as img.src is inert (browsers never execute it), but handing it
    // to GM_openInTab would navigate a real tab there. Whitelist absolute
    // http(s) before any URL crosses into GM_openInTab or an <img src> we
    // build from source data.
    function isHttpUrl(url) {
        return typeof url === 'string' && /^https?:\/\//i.test(url);
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function fmtCount(n) {
        if (n == null) return '';
        n = Number(n);
        if (!isFinite(n)) return '';
        if (n >= 1e8)  return (n / 1e8).toFixed(n >= 1e9 ? 0 : 1) + '亿';
        if (n >= 1e4)  return (n / 1e4).toFixed(n >= 1e6 ? 0 : 1) + '万';
        return String(n);
    }
    function fmtDuration(sec) {
        sec = Number(sec) || 0;
        if (sec <= 0) return '';
        var h = Math.floor(sec / 3600);
        var m = Math.floor((sec % 3600) / 60);
        var s = sec % 60;
        var pad = function (x) { return x < 10 ? '0' + x : String(x); };
        return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
    }
    function fmtTime(ts) {
        if (!ts) return '';
        var d = new Date(Number(ts) * 1000);
        if (isNaN(d.getTime())) return '';
        var pad = function (x) { return x < 10 ? '0' + x : String(x); };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    // Single source of truth for "投稿时间" so the hover tooltip and the
    // "复制完整信息" clipboard text never diverge (AGENTS.md gotcha #83).
    // Both must read the SAME field-fallback chain and the SAME source tag,
    // otherwise an item that carries ctime but not pubtime shows a date on
    // hover but a blank one when copied.
    function pickPubTs(real) {
        return real.ctime || real.pubtime || real.pubdate || null;
    }
    function pickPubSrc(real) {
        return real._src_ctime || real._src_pubtime || real._src_pubdate || null;
    }

    // Single global tooltip element, reused across all hovers.
    var _tipEl = null;
    function getTip() {
        if (_tipEl) return _tipEl;
        _tipEl = document.createElement('div');
        _tipEl.id = '__fav_fix_tip';
        _tipEl.style.cssText = [
            'position:fixed', 'z-index:2147483646', 'pointer-events:none',
            'max-width:340px', 'padding:10px 12px', 'border-radius:8px',
            'background:rgba(28,28,30,.96)', 'color:#fff',
            'box-shadow:0 8px 24px rgba(0,0,0,.35)',
            'font:12px/1.55 -apple-system,Segoe UI,"PingFang SC","Microsoft YaHei",sans-serif',
            'opacity:0', 'transition:opacity .12s', 'display:none'
        ].join(';');
        document.body.appendChild(_tipEl);
        return _tipEl;
    }

    // Two-column "label / value" row helper, used throughout the tooltip.
    function row(label, valueHtml, srcName) {
        return '<div style="display:flex;gap:10px;margin-bottom:4px;font-size:12px;align-items:flex-start">'
             + '<span style="color:#8a8a92;flex:0 0 52px;text-align:right">' + esc(label) + '</span>'
             + '<span style="color:#e6e6ea;flex:1;min-width:0;word-break:break-word">' + valueHtml + srcTag(srcName) + '</span>'
             + '</div>';
    }
    function codeTag(text) {
        return '<code style="background:rgba(255,255,255,.1);padding:1px 6px;border-radius:3px;font-size:11px;font-family:Consolas,Menlo,monospace">'
             + esc(text) + '</code>';
    }

    // Source attribution chips. Color-coded per source so the user can
    // see at a glance which API contributed which field of the snapshot.
    var SOURCE_COLORS = {
        android:   '#5b8def',
        'public':  '#67c23a',
        biliplus:  '#e6a23c',
        xbeibeix:  '#9b59b6',
        jijidown:  '#f56c6c'
    };
    function srcTag(src) {
        if (!src) return '';
        var color = SOURCE_COLORS[src] || '#909399';
        return ' <span style="display:inline-block;padding:0 6px;margin-left:6px;'
             + 'border-radius:3px;background:' + color + ';color:#fff;'
             + 'font-size:9px;font-weight:600;line-height:14px;vertical-align:1px;'
             + 'letter-spacing:.3px;text-transform:uppercase">' + esc(src) + '</span>';
    }

    function buildTipHtml(real) {
        if (!real) return '';

        // Unrecoverable stub — no source returned data. Render a slim
        // tooltip that says exactly that (and lists which sources we tried)
        // instead of the normal rich layout with empty fields everywhere.
        if (real._no_source) {
            var av = real.oid != null ? String(real.oid) : '';
            var bv = av ? avToBv(av) : null;
            // Prefer _attempted (new, accurate: phase 1 + phase 2 unioned).
            // Fall back to _attempted_3rd (legacy: 3rd-party only) for old
            // cache entries, then to _tried_sources (oldest: all possible
            // sources from the registry, not necessarily queried) as a
            // last-resort display.
            var attemptedList = real._attempted || real._attempted_3rd || real._tried_sources || [];
            var attemptedHtml = attemptedList.map(srcTag).join('');
            return '<div style="font-weight:600;font-size:13px;margin-bottom:8px;color:#fff;'
                 + 'line-height:1.35;border-bottom:1px solid rgba(255,255,255,.12);padding-bottom:6px">'
                 + '视频已删除 · 无任何数据来源保留快照</div>'
                 + (av ? '<div style="font-size:11px;color:#bdbdc2;margin-bottom:4px">AV ' + codeTag('av' + av) + '</div>' : '')
                 + (bv ? '<div style="font-size:11px;color:#bdbdc2;margin-bottom:4px">BV ' + codeTag(bv) + '</div>' : '')
                 + '<div style="margin-top:6px;color:#bdbdc2;font-size:11px;line-height:1.5">'
                 + '已查询以下数据来源，均无记录：'
                 + '</div>'
                 + '<div style="margin-top:4px">' + attemptedHtml + '</div>'
                 + '<div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08);color:#666;font-size:10px">'
                 + 'fav-fix · 视频可能已被永久删除' + '</div>';
        }

        // Pending — still being chased by the background android flap loop, or
        // waiting for a future retry after it gave up. There's no good snapshot
        // yet, so render a state-aware explainer (NOT the normal rich layout
        // with empty fields). _flapBgRunning is read LIVE here — showTip rebuilds
        // innerHTML on every hover — so the text tracks whether the loop is
        // currently alive (重试中) or has stopped (待重试), matching the badge.
        if (real._pending) {
            var pav = real.oid != null ? String(real.oid) : (real.bvid ? bvToAv(real.bvid) : '');
            var pbv = real.bvid || (pav ? avToBv(pav) : null);
            var pActive = _flapBgRunning;
            var pHead = pActive ? '正在找回此视频快照…' : '暂未找回，等待重试';
            var pBody = pActive
                ? 'bilibili 的 android 收藏接口会随机漏掉一部分失效视频，脚本正在后台多次重新采样把它捞回来。找回后本卡片会自动更新封面与标题，无需手动操作。'
                : '后台已多次重新采样仍未取回——可能视频确实已被删除，也可能是 bilibili 接口暂时不返回。重新整理本页会自动再试一轮；也可在本卡片右上「···」菜单点「立即重试」立刻再抓一轮。';
            return '<div style="font-weight:600;font-size:13px;margin-bottom:8px;color:#fff;'
                 + 'line-height:1.35;border-bottom:1px solid rgba(255,255,255,.12);padding-bottom:6px">'
                 + esc(pHead) + '</div>'
                 + (pav ? '<div style="font-size:11px;color:#bdbdc2;margin-bottom:4px">AV ' + codeTag('av' + pav) + '</div>' : '')
                 + (pbv ? '<div style="font-size:11px;color:#bdbdc2;margin-bottom:4px">BV ' + codeTag(pbv) + '</div>' : '')
                 + '<div style="margin-top:6px;color:#bdbdc2;font-size:11px;line-height:1.55">'
                 + esc(pBody) + '</div>'
                 + '<div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08);color:#666;font-size:10px">'
                 + 'fav-fix · ' + (pActive ? '重试中（后台自动）' : '待重试') + '</div>';
        }

        var parts = [];

        // Title — full width, bold, with source chip after the title text.
        parts.push('<div style="font-weight:600;font-size:13px;margin-bottom:8px;color:#fff;line-height:1.35;border-bottom:1px solid rgba(255,255,255,.12);padding-bottom:6px">'
                   + esc(real.title || '（无标题）')
                   + srcTag(real._src_title)
                   + '</div>');

        // 封面 — dedicated row showing WHICH source supplied the patched
        // cover. The cover itself isn't shown in tooltip (it's on the
        // card img), so this row exists purely for source attribution.
        if (real.cover && real._src_cover) {
            parts.push(row('封面', '<span style="color:#888;font-size:11px">已恢复</span>', real._src_cover));
        }

        // UP 主
        if (real.upper && (real.upper.name || real.upper.face)) {
            var faceUrl = real.upper.face ? real.upper.face.replace(/^http:\/\//, 'https://') : '';
            // Only render the avatar img for absolute http(s) faces (esc still
            // guards attribute breakout; isHttpUrl rejects javascript:/data:).
            var avatar = isHttpUrl(faceUrl)
                ? '<img src="' + esc(faceUrl) + '" '
                  + 'style="width:18px;height:18px;border-radius:50%;vertical-align:middle;margin-right:6px;background:#444" />'
                : '';
            var uid = real.upper.mid ? ' <span style="color:#888;font-size:11px">UID ' + esc(real.upper.mid) + '</span>' : '';
            parts.push(row('UP 主', avatar + esc(real.upper.name || '（未知）') + uid, real._src_upper));
        }

        // Stats — no emoji, Chinese labels separated by middle dot.
        var c = real.cnt_info || {};
        var stats = [];
        if (c.play     != null) stats.push('播放 '  + fmtCount(c.play));
        if (c.danmaku  != null) stats.push('弹幕 '  + fmtCount(c.danmaku));
        if (c.thumb_up != null) stats.push('点赞 '  + fmtCount(c.thumb_up));
        if (c.reply    != null) stats.push('评论 '  + fmtCount(c.reply));
        if (c.collect  != null) stats.push('收藏 '  + fmtCount(c.collect));
        if (stats.length) parts.push(row('数据', stats.join('  ·  '), real._src_cnt_info));

        // Duration
        var dur = real.playback_desc || fmtDuration(real.duration);
        if (dur) parts.push(row('时长', esc(dur), real._src_duration || real._src_playback_desc));

        // BV + AV — always show both; if response only carries one, derive the other.
        var av = real.oid != null ? String(real.oid) : (real.bvid ? bvToAv(real.bvid) : null);
        var bv = real.bvid || (av ? avToBv(av) : null);
        if (av) parts.push(row('AV', codeTag('av' + av)));
        if (bv) parts.push(row('BV', codeTag(bv), real._src_bvid));

        // Dates — invalid-item snapshots may omit some date fields. Show
        // the row regardless so user knows what's missing vs unknown.
        var pubT = fmtTime(pickPubTs(real));
        var favT = fmtTime(real.fav_time);
        var dateBits = [];
        dateBits.push('投稿 ' + (pubT || '<span style="color:#777">快照未记录</span>'));
        dateBits.push('收藏 ' + (favT || '<span style="color:#777">快照未记录</span>'));
        // Use the source that gave us at least one of the two dates
        // (typically public).
        var dateSrc = pickPubSrc(real) || real._src_fav_time;
        parts.push(row('日期', dateBits.join('  ·  '), dateSrc));

        // Intro (truncated to 240).
        if (real.intro && real.intro.trim()) {
            var intro = real.intro.length > 240 ? real.intro.slice(0, 240) + '…' : real.intro;
            parts.push('<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.12);color:#bdbdc2;white-space:pre-wrap;word-break:break-word;font-size:12px">'
                       + esc(intro)
                       + srcTag(real._src_intro)
                       + '</div>');
        }

        // Footer — list of contributing sources + sources that queried but
        // returned nothing. Two fields drive this:
        //   _sources    = sources whose data ended up in some merged field
        //   _attempted  = every source that actually queried this av
        //                 (phase 1 paginated + phase 2 per-av). Tooltip
        //                 shows attempted-minus-contributing as "已查询但
        //                 无记录" so the user can see "android + public
        //                 + biliplus all came back empty, only jijidown
        //                 had it" instead of those sources silently
        //                 disappearing.
        //   _attempted_3rd = legacy field (3rd-party only). Read as a
        //                    fallback so pre-0.7.2 cached entries still
        //                    show whatever attempts they have.
        var srcChips = '';
        if (real._sources && real._sources.length) {
            srcChips = '<div style="margin-top:4px">数据来源：' + real._sources.map(srcTag).join('') + '</div>';
        }
        var attempted = real._attempted || real._attempted_3rd || [];
        var missAttempts = attempted.filter(function (s) {
            return !real._sources || real._sources.indexOf(s) === -1;
        });
        var missChips = '';
        if (missAttempts.length) {
            missChips = '<div style="margin-top:2px;color:#777">已查询但无记录：'
                      + missAttempts.map(srcTag).join('') + '</div>';
        }
        parts.push('<div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08);color:#666;font-size:10px">'
                   + 'fav-fix · 数据来自收藏时的快照'
                   + srcChips
                   + missChips
                   + '</div>');
        return parts.join('');
    }

    function showTip(el, real, evt) {
        var tip = getTip();
        tip.innerHTML = buildTipHtml(real);
        tip.style.display = 'block';
        // Position: prefer above the element, centered horizontally;
        // if it would clip off the top, place it below.
        var r = el.getBoundingClientRect();
        var vw = window.innerWidth, vh = window.innerHeight;
        // Make sure layout is computed before reading offsetWidth.
        tip.style.left = '0px'; tip.style.top = '0px';
        var tw = tip.offsetWidth, th = tip.offsetHeight;
        var left = Math.max(8, Math.min(vw - tw - 8, r.left + r.width / 2 - tw / 2));
        var top  = r.top - th - 10;
        if (top < 8) top = Math.min(vh - th - 8, r.bottom + 10);
        tip.style.left = left + 'px';
        tip.style.top = top + 'px';
        // rAF so the opacity transition actually animates from 0 → 1.
        requestAnimationFrame(function () { tip.style.opacity = '1'; });
    }
    function hideTip() {
        var tip = getTip();
        tip.style.opacity = '0';
        setTimeout(function () {
            if (tip.style.opacity === '0') tip.style.display = 'none';
        }, 150);
    }

