    // ─── Auth storage ───────────────────────────────────────────────────
    // Supports two modes:
    //   mode='tv'      → use access_key issued via TV QR login (TV appkey signing)
    //   mode='android' → use a manually-pasted access_key + Android-main-app signing

    function getAuth() {
        return {
            mode: GM_getValue('auth_mode', 'tv'),
            access_key: GM_getValue('access_key', ''),
            ts: GM_getValue('access_key_ts', 0)
        };
    }
    function setAuth(mode, ak) {
        GM_setValue('auth_mode', mode);
        GM_setValue('access_key', ak);
        GM_setValue('access_key_ts', Date.now());
    }
    function clearAuth() {
        GM_deleteValue('access_key');
        GM_deleteValue('access_key_ts');
        // Also drop the mode so getAuth() falls back to its 'tv' default
        // after logout instead of retaining a stale 'android'/'tv' choice.
        GM_deleteValue('auth_mode');
    }

    function appkeyFor(mode) { return mode === 'android' ? AND_APPKEY : TV_APPKEY; }
    function appsecFor(mode) { return mode === 'android' ? AND_APPSEC : TV_APPSEC; }

    // ─── TV QR login ────────────────────────────────────────────────────

    function tvAuthCode() {
        var p = signParams({ appkey: TV_APPKEY, local_id: '0', ts: String(Math.floor(Date.now() / 1000)) }, TV_APPSEC);
        return gmPostForm('https://passport.bilibili.com/x/passport-tv-login/qrcode/auth_code', toQuery(p));
    }
    function tvPoll(authCode) {
        var p = signParams({ appkey: TV_APPKEY, auth_code: authCode, local_id: '0', ts: String(Math.floor(Date.now() / 1000)) }, TV_APPSEC);
        return gmPostForm('https://passport.bilibili.com/x/passport-tv-login/qrcode/poll', toQuery(p));
    }

    function showQrModal(loginUrl, onClose) {
        // Tiny modal. Uses api.qrserver.com to render the QR — bilibili
        // doesn't ship a JS QR encoder and pulling one would double the
        // file. qrserver.com has been live since ~2014; if it ever dies,
        // swap in a JS encoder (e.g. davidshimjs/qrcodejs).
        var qr = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' + encodeURIComponent(loginUrl);
        var host = document.createElement('div');
        host.id = '__fav_fix_qr_host';
        host.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:2147483647',
            'display:flex', 'align-items:center', 'justify-content:center',
            'background:rgba(0,0,0,.45)',
            'font:14px/1.4 -apple-system,Segoe UI,sans-serif'
        ].join(';');
        host.innerHTML = ''
            + '<div style="background:#fff;border-radius:12px;padding:20px 24px;min-width:300px;box-shadow:0 8px 32px rgba(0,0,0,.3);text-align:center">'
            +   '<div style="font-weight:600;font-size:16px;margin-bottom:4px">扫码登录（TV 端授权）</div>'
            +   '<div style="color:#888;font-size:12px;margin-bottom:12px">请使用 bilibili 手机客户端的扫一扫功能</div>'
            +   '<img src="' + qr + '" style="display:block;margin:0 auto 12px;width:240px;height:240px" />'
            +   '<div id="__fav_fix_qr_status" style="color:#666;font-size:12px;margin-bottom:8px">等待扫描</div>'
            +   '<button id="__fav_fix_qr_close" style="border:0;background:#f4f4f4;padding:6px 16px;border-radius:6px;cursor:pointer">取消</button>'
            + '</div>';
        document.body.appendChild(host);
        host.querySelector('#__fav_fix_qr_close').addEventListener('click', function () { onClose('cancel'); });
        return host;
    }
    function setQrStatus(host, text) {
        var el = host && host.querySelector('#__fav_fix_qr_status');
        if (el) el.textContent = text;
    }
    function closeQr(host) { if (host && host.parentNode) host.parentNode.removeChild(host); }

    async function tvLogin() {
        toast('正在请求登录授权…');
        var ac;
        try { ac = await tvAuthCode(); }
        catch (e) { toast('授权请求失败：' + e.message, 'err'); return; }
        if (ac.code !== 0 || !ac.data || !ac.data.auth_code || !ac.data.url) {
            toast('授权响应异常：错误码 ' + ac.code + '，' + ac.message, 'err'); return;
        }
        var host = null, done = false;
        var promise = new Promise(function (resolve) {
            host = showQrModal(ac.data.url, function (reason) {
                done = true; closeQr(host); resolve({ ok: false, reason: reason });
            });
            // Poll every 2s for up to 3 minutes.
            var deadline = Date.now() + 180000;
            (function tick() {
                if (done) return;
                if (Date.now() > deadline) {
                    setQrStatus(host, '登录超时，请重新尝试');
                    setTimeout(function () { closeQr(host); resolve({ ok: false, reason: 'timeout' }); }, 1500);
                    return;
                }
                tvPoll(ac.data.auth_code).then(function (r) {
                    if (done) return;
                    if (r.code === 0 && r.data && r.data.access_token) {
                        done = true;
                        setAuth('tv', r.data.access_token);
                        setQrStatus(host, '登录成功');
                        setTimeout(function () { closeQr(host); resolve({ ok: true }); }, 800);
                        return;
                    }
                    // 86039 = waiting for scan; 86090 = scanned, waiting for confirm; 86038 = expired
                    if (r.code === 86090) setQrStatus(host, '已扫描，请在手机上确认登录');
                    else if (r.code === 86038) {
                        setQrStatus(host, '二维码已过期，请重新尝试');
                        setTimeout(function () { closeQr(host); resolve({ ok: false, reason: 'expired' }); }, 1500);
                        return;
                    }
                    setTimeout(tick, 2000);
                }).catch(function (e) {
                    warn('poll failed', e); setTimeout(tick, 2000);
                });
            })();
        });
        var res = await promise;
        if (res.ok) toast('登录成功，凭据已保存', 'ok');
        else toast('登录已取消（' + res.reason + '）', 'warn');
    }

    function manualLogin() {
        var ak = prompt('请输入 Android 主版 access_key\n（由 appkey ' + AND_APPKEY + ' 签发，对应 mobi_app=android）');
        if (!ak || !ak.trim()) return;
        setAuth('android', ak.trim());
        toast('凭据已保存（手动输入 / Android 模式）', 'ok');
    }

