    // ─── Signing ────────────────────────────────────────────────────────

    function signParams(params, appsec) {
        var keys = Object.keys(params).sort();
        var q = keys.map(function (k) { return k + '=' + params[k]; }).join('&');
        var out = {};
        for (var i = 0; i < keys.length; i++) out[keys[i]] = params[keys[i]];
        out.sign = md5(q + appsec);
        return out;
    }

    function toQuery(p) {
        return Object.keys(p).map(function (k) {
            return encodeURIComponent(k) + '=' + encodeURIComponent(p[k]);
        }).join('&');
    }

    // ─── HTTP wrapper ──────────────────────────────────────────────────

    function gmGet(url, opts) {
        opts = opts || {};
        var timeoutMs = opts.timeout || 15000;
        // GM_xmlhttpRequest's `timeout` field is unreliable for connections
        // that stall mid-handshake (no FIN/RST ever sent — e.g. biliplus
        // when its server is overloaded). The `ontimeout` callback simply
        // never fires and the request hangs forever. Wrap with a client-side
        // Promise.race so caller-supplied budgets are HARD. Live request
        // continues in the background after we reject (no way to cancel
        // GM_xmlhttpRequest cleanly across all TM versions), but that's
        // acceptable for best-effort fallback sources.
        var underlying = new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: opts.method || 'GET',
                url: url,
                data: opts.data,
                headers: opts.headers || { 'User-Agent': 'Mozilla/5.0 BiliDroid/8.94.0' },
                timeout: timeoutMs,
                onload: function (resp) {
                    var text = resp.responseText;
                    // Some responses arrive with no text body — an empty 204,
                    // an opaque/blocked response, or a GM build that leaves
                    // responseText undefined for certain statuses. Guard
                    // BEFORE JSON.parse AND before building the error string:
                    // the old code did `resp.responseText.slice(0, 200)` inside
                    // the parse-failure catch, which itself threw a TypeError
                    // when responseText was undefined. That throw escaped as an
                    // *uncaught* error in GM's onload (reject was never reached),
                    // so the promise never rejected — it hung until the
                    // client-side guard fired timeoutMs+500 later. Turn it into
                    // a clean rejection the caller's .catch already handles.
                    if (typeof text !== 'string') {
                        reject(new Error('empty/non-text response (status=' + resp.status + '): ' + url));
                        return;
                    }
                    try { resolve(JSON.parse(text)); }
                    catch (e) { reject(new Error('JSON parse failed: ' + e.message + ' body=' + text.slice(0, 200))); }
                },
                onerror: function () { reject(new Error('network error: ' + url)); },
                ontimeout: function () { reject(new Error('timeout: ' + url)); }
            });
        });
        // Pad client-side guard by 500ms so the underlying GM timer wins
        // for legitimate timeouts (cleaner error message), and we only
        // catch the pathological stall case. Clear the guard once the race
        // settles so a successful request doesn't leave a live timer pending
        // for timeoutMs+500 (every call would otherwise leak one).
        var guardTimer = null;
        var guard = new Promise(function (_, rej) {
            guardTimer = setTimeout(function () {
                rej(new Error('client-side timeout (' + timeoutMs + 'ms+500): ' + url));
            }, timeoutMs + 500);
        });
        return Promise.race([underlying, guard]).finally(function () {
            if (guardTimer) clearTimeout(guardTimer);
        });
    }

    // Binary sibling of gmGet, for the manual backup (15a-backup.js): pulls a
    // cover image straight into a Blob so it can be stored in IndexedDB. Kept
    // as a separate function rather than a flag on gmGet because gmGet's whole
    // contract is "resolves to parsed JSON" and every caller depends on it.
    // Same client-side Promise.race guard, same reason (GM's own `timeout`
    // never fires on a connection that stalls mid-handshake).
    function gmGetBlob(url, opts) {
        opts = opts || {};
        var timeoutMs = opts.timeout || 10000;
        var underlying = new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'blob',
                // hdslb serves covers without a Referer check today, but send
                // one anyway — a hotlink guard would otherwise turn every
                // backup into "封面失败 N".
                headers: opts.headers || { 'Referer': 'https://www.bilibili.com/' },
                timeout: timeoutMs,
                onload: function (resp) {
                    if (resp.status && (resp.status < 200 || resp.status >= 300)) {
                        reject(new Error('HTTP ' + resp.status + ': ' + url));
                        return;
                    }
                    var b = resp.response;
                    // Duck-typed, NOT `instanceof Blob`: the Blob is minted in
                    // the GM sandbox realm, whose Blob constructor is not
                    // necessarily the one visible here — instanceof can be
                    // false for a perfectly good Blob.
                    if (!b || typeof b.size !== 'number' || !b.size) {
                        reject(new Error('empty/non-blob response (status=' + resp.status + '): ' + url));
                        return;
                    }
                    resolve(b);
                },
                onerror: function () { reject(new Error('network error: ' + url)); },
                ontimeout: function () { reject(new Error('timeout: ' + url)); }
            });
        });
        var guardTimer = null;
        var guard = new Promise(function (_, rej) {
            guardTimer = setTimeout(function () {
                rej(new Error('client-side timeout (' + timeoutMs + 'ms+500): ' + url));
            }, timeoutMs + 500);
        });
        return Promise.race([underlying, guard]).finally(function () {
            if (guardTimer) clearTimeout(guardTimer);
        });
    }

    function gmPostForm(url, body) {
        return gmGet(url, {
            method: 'POST',
            data: body,
            headers: {
                'User-Agent': 'Mozilla/5.0 BiliDroid/8.94.0',
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
    }

