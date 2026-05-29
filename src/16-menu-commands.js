    // ─── Menu commands ──────────────────────────────────────────────────

    try {
        GM_registerMenuCommand('fav-fix：登录（TV 端二维码）', tvLogin);
        GM_registerMenuCommand('fav-fix：登录（手动输入凭据）', manualLogin);
        GM_registerMenuCommand('fav-fix：注销（清除登录凭据）', function () { clearAuth(); toast('登录凭据已清除', 'ok'); });
        GM_registerMenuCommand('fav-fix：开关调试日志', function () {
            DEBUG = !DEBUG; GM_setValue('debug', DEBUG);
            toast('调试日志：' + (DEBUG ? '已开启' : '已关闭'), 'ok');
        });
        GM_registerMenuCommand('fav-fix：立即重新扫描并修复', function () { pageCache.clear(); pageItems.clear(); schedule(); });
        GM_registerMenuCommand('fav-fix：扫描静默丢弃的条目', function () {
            var mid = detectMediaId();
            if (!mid) { toast('无法识别当前收藏夹 ID', 'err'); return; }
            // Reset all three caches so a manual re-scan re-fetches both
            // ids endpoint AND walks phase 1 again (fresh state).
            _idsListCache.delete(mid);
            _phase1AvsCache.delete(mid);
            _missingBannerShown.delete(mid);
            detectMissingAndRender(mid);
        });
        GM_registerMenuCommand('fav-fix：清除所有缓存并刷新页面', function () {
            var n = clearAllItemCache();
            if (n < 0) { toast('GM_listValues 权限缺失，无法批量清除', 'err'); return; }
            // Persistent GM items gone; now flush every in-memory layer too,
            // otherwise the page keeps serving cached rows until reload. The
            // on-screen cards are already patched (they no longer match the
            // invalid signature), so an in-place re-scan can't refresh them —
            // a reload is the clean, correct way to surface fresh data.
            dropAllInMemory();
            toast('已清除 ' + n + ' 项缓存，正在刷新…', 'ok');
            setTimeout(function () { location.reload(); }, 600);
        });
        GM_registerMenuCommand('fav-fix：查看登录状态', function () {
            var a = getAuth();
            var age = a.ts ? Math.floor((Date.now() - a.ts) / 86400000) : null;
            var msg = '登录模式：' + (a.mode || '未登录')
                    + '　凭据：' + (a.access_key ? '已保存' : '未保存')
                    + '　已保存：' + (age == null ? '未知' : age + ' 天前');
            toast(msg);
        });
    } catch (e) { warn('menu register failed', e); }

