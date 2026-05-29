    // ─── Toast ──────────────────────────────────────────────────────────

    function toast(msg, kind) {
        var color = kind === 'err' ? '#c0392b' : kind === 'warn' ? '#e67e22' : kind === 'ok' ? '#27ae60' : '#34495e';
        var el = document.createElement('div');
        el.textContent = 'fav-fix: ' + msg;
        el.style.cssText = [
            // Bottom-center: anchor at left:50% and use translateX(-50%)
            // for self-centering regardless of width. bottom:32px keeps
            // it above bilibili's own footer / floating buttons but still
            // visually clearly "in the bottom band".
            'position:fixed', 'left:50%', 'bottom:32px',
            'transform:translateX(-50%)',
            'z-index:2147483647',
            'padding:8px 14px', 'border-radius:8px',
            'font:600 13px/1.3 -apple-system,Segoe UI,sans-serif',
            'color:#fff', 'background:' + color,
            'box-shadow:0 4px 12px rgba(0,0,0,.25)', 'pointer-events:none',
            // max-width + word-wrap: caps the toast width at 360px so a
            // long error string ("授权响应异常：错误码 -3, bilibili 长描述…")
            // doesn't stretch the box past the viewport edge. Wraps onto
            // multiple lines instead. break-word handles long unspaced
            // CJK / URLs. text-align:center reads better for centered toast.
            'max-width:360px', 'white-space:normal', 'text-align:center',
            'overflow-wrap:break-word', 'word-break:break-word'
        ].join(';');
        if (document.body) document.body.appendChild(el);
        else document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(el); }, { once: true });
        setTimeout(function () { try { el.remove(); } catch (e) {} }, 4500);
    }

