    // ─── Menu commands ──────────────────────────────────────────────────
    //
    // Every command is a NAMED function here, and both surfaces call the same
    // one: the Tampermonkey menu registered at the bottom of this file, and
    // the in-page FAB menu (16a-fab.js). The two must never drift — a command
    // reachable from one and not the other is the bug this shape prevents.

    function cmdLogout() {
        clearAuth();
        toast('登录凭据已清除', 'ok');
    }

    function cmdToggleDebug() {
        DEBUG = !DEBUG; GM_setValue('debug', DEBUG);
        toast('调试日志：' + (DEBUG ? '已开启' : '已关闭'), 'ok');
    }

    function cmdRescan() {
        pageCache.clear(); pageItems.clear(); schedule();
    }

    function cmdScanMissing() {
        var mid = detectMediaId();
        if (!mid) { toast('无法识别当前收藏夹 ID', 'err'); return; }
        // Reset all three caches so a manual re-scan re-fetches both
        // ids endpoint AND walks phase 1 again (fresh state).
        _idsListCache.delete(mid);
        _phase1AvsCache.delete(mid);
        _missingBannerShown.delete(mid);
        detectMissingAndRender(mid);
    }

    function cmdClearAllCache() {
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
    }

    function cmdClearAllNoRetry() {
        var c = clearAllNoRetry();
        var n = c.user + c.auto;
        if (!n) { toast('当前没有「停止重试」标记', 'ok'); return; }
        toast('已清除 ' + n + ' 项停止重试标记（手动 ' + c.user + ' · 自动 ' + c.auto + '）', 'ok');
        // Deliberately no reload: clearing the list changes no card's cached
        // snapshot, only which badge the next render pass paints. A repaint
        // is enough, and a reload would throw away a live flap loop.
        schedule();
    }

    // Every av on THIS page whose retry is still live — the payload of the
    // bulk stop below, and the source of its menu hint.
    //
    // Two sources, unioned, because neither alone is the whole page:
    //   - the rendered pending cards, which is what the user is looking at;
    //   - _flapLeftover, the set the loop gave up on in THIS folder. Those
    //     cards are pending too, but an av can sit in the leftover set while
    //     its card is momentarily absent from the DOM (mid re-render).
    // Avs the user already stopped are excluded so the count reads as "what
    // this click will actually change", not "how many pending cards exist".
    function pendingAvsOnPage() {
        var set = new Set();
        var nodes = document.querySelectorAll('[data-fav-fix-retry-action][data-fav-fix-retry-av]');
        for (var i = 0; i < nodes.length; i++) {
            var av = nodes[i].getAttribute('data-fav-fix-retry-av');
            if (av && !isNoRetryUser(av)) set.add(av);
        }
        var mid = detectMediaId();
        if (mid && _flapLeftoverMid === mid) {
            _flapLeftover.forEach(function (av) { if (!isNoRetryUser(av)) set.add(av); });
        }
        return Array.from(set);
    }

    function cmdStopRetryThisPage() {
        var avs = pendingAvsOnPage();
        if (!avs.length) { toast('本页没有仍在重试的条目', 'ok'); return; }
        avs.forEach(function (av) { setNoRetryUser(av); });
        toast('已停止本页 ' + avs.length + ' 项的重试', 'ok');
        // Repaint so every affected cover flips to 已停止重试 at once. The
        // running loop is left alone on purpose: it re-reads the stop list per
        // walk (isRetrySuppressed), so it drops these avs by itself.
        schedule();
    }

    function cmdBackupFolder() {
        // Async and long-running; nothing awaits it, so swallow rejections
        // here or an unexpected throw surfaces only as an unhandled
        // rejection in the console.
        backupCurrentFolder().catch(function (e) {
            warn('backup run threw', e);
            toast('备份失败：' + (e && e.message), 'err');
        });
    }

    function cmdManageBackup() {
        // Same swallow-the-rejection reasoning as the backup run above:
        // the panel opens asynchronously (IndexedDB probe + index walk)
        // and nothing awaits it here.
        openBackupManager().catch(function (e) {
            warn('backup manager threw', e);
            toast('打开备份管理失败：' + (e && e.message), 'err');
        });
    }

    function cmdImportBackup() {
        // Nothing to swallow here: the picker helper (15d-backup-import.js)
        // owns the whole lifecycle — it opens the dialog, reports refusals as
        // toasts and catches a throwing run itself. A dismissed dialog is
        // silent by design.
        importPickBackupFile();
    }

    function cmdSettings() {
        // Synchronous and self-contained: the modal owns its own lifecycle
        // and re-focuses instead of stacking when it is already open.
        openSettings();
    }

    function cmdAuthStatus() {
        var a = getAuth();
        var age = a.ts ? Math.floor((Date.now() - a.ts) / 86400000) : null;
        var msg = '登录模式：' + (a.mode || '未登录')
                + '　凭据：' + (a.access_key ? '已保存' : '未保存')
                + '　已保存：' + (age == null ? '未知' : age + ' 天前');
        toast(msg);
    }

    try {
        GM_registerMenuCommand('fav-fix：登录（TV 端二维码）', tvLogin);
        GM_registerMenuCommand('fav-fix：登录（手动输入凭据）', manualLogin);
        GM_registerMenuCommand('fav-fix：注销（清除登录凭据）', cmdLogout);
        GM_registerMenuCommand('fav-fix：开关调试日志', cmdToggleDebug);
        GM_registerMenuCommand('fav-fix：立即重新扫描并修复', cmdRescan);
        GM_registerMenuCommand('fav-fix：扫描静默丢弃的条目', cmdScanMissing);
        GM_registerMenuCommand('fav-fix：清除所有缓存并刷新页面', cmdClearAllCache);
        GM_registerMenuCommand('fav-fix：本页全部停止重试', cmdStopRetryThisPage);
        GM_registerMenuCommand('fav-fix：清除所有「停止重试」标记', cmdClearAllNoRetry);
        GM_registerMenuCommand('fav-fix：备份当前收藏夹（封面+信息 → IndexedDB）', cmdBackupFolder);
        GM_registerMenuCommand('fav-fix：管理备份', cmdManageBackup);
        GM_registerMenuCommand('fav-fix：导入备份文件', cmdImportBackup);
        GM_registerMenuCommand('fav-fix：设置', cmdSettings);
        GM_registerMenuCommand('fav-fix：查看登录状态', cmdAuthStatus);
    } catch (e) { warn('menu register failed', e); }

