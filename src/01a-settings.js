    // ─── Settings registry ──────────────────────────────────────────────
    //
    // Every tunable in this script used to be a `var X = <literal>` sitting
    // next to the code that read it. That is the right shape for a protocol
    // constant (a ZIP signature, an appkey, the cache schema version) but the
    // wrong one for a value the USER has a legitimate reason to disagree with:
    // how many pages a rescue walk may burn, how long a cached merge stays
    // trusted, whether an av number may be sent to a third-party archive.
    //
    // This module is the single registry of those values. It is DATA, not
    // code — the same shape as SOURCES, FIELD_PRIORITY and FAB_MENU elsewhere
    // in this file — so adding a tunable means appending one schema row and
    // nothing else: persistence, validation, the reset paths and every row of
    // the settings modal (16b-settings.js) are all derived from the schema.
    //
    // ── Contract ──
    //   cfg(key)            → the live value. Cheap (memoised), safe to call
    //                         on a hot path, never throws, falls back to the
    //                         schema default for a missing/corrupt store.
    //   cfgSet(key, raw)    → {ok, value} | {ok:false, error} — validates,
    //                         persists, updates the memo, runs `apply`.
    //   cfgReset(key)       → back to the default, store entry deleted.
    //
    // ── Why call-time reads ──
    // Callers read cfg() where they USE the value, not once at boot, so a
    // change takes effect without a reload. The two exceptions are deliberate
    // and documented at their sites: a long-running loop (runFlapRecovery) and
    // a single archive sweep (SOURCES.biliplus / SOURCES.jijidown) each
    // snapshot their parameters into locals up front, so a mid-flight edit
    // lands on the NEXT round instead of changing the rules under a
    // half-finished one.
    //
    // ── Storage ──
    // GM storage under `cfg:<key>`, one entry per NON-DEFAULT setting; a
    // setting left at its default stores nothing. GM_addValueChangeListener is
    // not granted and the bootstrap @version is frozen (see AGENTS.md), so —
    // exactly like the 停止重试 list in 07a — a change made in tab A reaches
    // tab B only after a reload. Do not try to work around it here.

    var SETTINGS_PREFIX = 'cfg:';

    var SETTINGS_GROUPS = [
        { id: 'scan',   label: '扫描与修复' },
        { id: 'retry',  label: '后台重试' },
        { id: 'cache',  label: '缓存与标记' },
        { id: 'net',    label: '网络与数据源' },
        { id: 'backup', label: '备份' },
        { id: 'ui',     label: '界面与调试' }
    ];

    // One row per tunable. Fields:
    //   key/group/label/desc  identity, and what the modal renders
    //   type                  'int' | 'bool' | 'intlist'
    //   def                   the value shipped in this version
    //   min/max               inclusive bounds (an 'int', or EACH member of an
    //                         'intlist'). Out-of-range input is REFUSED with a
    //                         message rather than silently clamped: a clamp
    //                         would report success and then do something else.
    //   unit                  suffix rendered after the field
    //   gmKey                 storage-key override, for a setting that existed
    //                         before this registry did
    //   apply                 hook run after a successful set, for a value
    //                         mirrored elsewhere (see `debug`)
    var SETTINGS_SCHEMA = [
        // ── 扫描与修复 ──
        { key: 'maxPageWalk', group: 'scan', type: 'int', def: 50, min: 5, max: 500, unit: '页',
          label: '修复扫描页数上限',
          desc: '每页 20 条。收藏夹条目超出上限时，靠后的失效条目扫不到；调高会延长一次完整扫描的耗时。' },
        { key: 'patchDebounceMs', group: 'scan', type: 'int', def: 400, min: 100, max: 3000, unit: '毫秒',
          label: '页面变动合并延迟',
          desc: '页面结构变动后等待多久执行一次修补。调低响应更快，但翻页途中会重复触发。' },
        { key: 'spaSwitchDelayMs', group: 'scan', type: 'int', def: 1500, min: 200, max: 10000, unit: '毫秒',
          label: '切换收藏夹后的检测延迟',
          desc: '切换收藏夹后等待页面稳定的时间，随后才开始检测静默丢弃的条目。网络较慢时可调高。' },
        { key: 'coverLoadTimeoutMs', group: 'scan', type: 'int', def: 4000, min: 1000, max: 20000, unit: '毫秒',
          label: '封面加载等待上限',
          desc: '替换封面后等待图片加载结果的上限。超时即撤下加载动画，避免动画长期停留。' },
        { key: 'missingDryRounds', group: 'scan', type: 'int', def: 2, min: 1, max: 5, unit: '轮',
          label: '丢弃检测收敛轮数',
          desc: '连续这么多轮走访没有发现新条目，即认定并集已饱和。调低会高估「静默丢弃」的数量。' },
        { key: 'missingMaxWalks', group: 'scan', type: 'int', def: 8, min: 1, max: 20, unit: '次',
          label: '丢弃检测走访上限',
          desc: 'android 数据源逐轮抖动，需多轮取并集才准确。这是硬上限，防止无止境走访。' },

        // ── 后台重试 ──
        { key: 'flapMaxDry', group: 'retry', type: 'int', def: 7, min: 1, max: 30, unit: '轮',
          label: '放弃前的连续无收获轮数',
          desc: '后台重试连续这么多轮没有恢复任何条目即停止，并写入自动「停止重试」标记。' },
        { key: 'flapTimeBudgetMin', group: 'retry', type: 'int', def: 30, min: 1, max: 240, unit: '分钟',
          label: '后台重试总时限',
          desc: '单个收藏夹的后台重试从开始计时的硬上限，无论是否仍有条目待恢复。' },
        { key: 'flapBackoffMs', group: 'retry', type: 'intlist',
          def: [1000, 2000, 5000, 15000, 30000, 60000, 120000],
          min: 200, max: 900000, minLen: 1, maxLen: 12, unit: '毫秒',
          label: '重试间隔梯度',
          desc: '按当前连续无收获轮数取用，超出长度则取最后一项。必须非递减，用逗号分隔。前段密集以捕捉秒级抖动，尾段拉长以降低请求压力。' },

        // ── 缓存与标记 ──
        { key: 'cacheTtlDays', group: 'cache', type: 'int', def: 30, min: 1, max: 365, unit: '天',
          label: '成功恢复的缓存有效期',
          desc: '已确定恢复的条目在本地缓存中的存活时间，到期后重新向数据源查询。' },
        { key: 'cacheTtlDegenerateMin', group: 'cache', type: 'int', def: 10, min: 1, max: 1440, unit: '分钟',
          label: '未确定恢复的缓存有效期',
          desc: '仅拿到占位信息、或仍在重试的条目所用的缓存有效期。刻意远短于上一项，避免一次失败的走访被锁定数十天。' },
        { key: 'autoNoRetryTtlDays', group: 'cache', type: 'int', def: 7, min: 1, max: 90, unit: '天',
          label: '自动「停止重试」标记有效期',
          desc: '后台重试放弃后写入的标记的存活时间。手动按下的停止标记不受此项影响，永久有效。' },

        // ── 网络与数据源 ──
        { key: 'httpTimeoutMs', group: 'net', type: 'int', def: 15000, min: 2000, max: 60000, unit: '毫秒',
          label: 'GET 请求超时',
          desc: '未单独指定超时的 GET 请求所使用的默认值。' },
        { key: 'httpPostTimeoutMs', group: 'net', type: 'int', def: 10000, min: 2000, max: 60000, unit: '毫秒',
          label: 'POST 请求超时',
          desc: '登录轮询等表单提交所使用的默认超时。' },
        { key: 'phase2BudgetMs', group: 'net', type: 'int', def: 10000, min: 1000, max: 60000, unit: '毫秒',
          label: '第三方数据源总预算',
          desc: '一次解析中留给全部第三方存档站的合计时间。超时即跳过剩余数据源，先把已拿到的信息贴回页面。' },
        { key: 'sourceFailThreshold', group: 'net', type: 'int', def: 3, min: 1, max: 10, unit: '次',
          label: '数据源熔断阈值',
          desc: '同一数据源连续失败这么多次后暂时停用。刷新页面会立即重置熔断状态。' },
        { key: 'sourceBackoffMin', group: 'net', type: 'int', def: 5, min: 1, max: 60, unit: '分钟',
          label: '数据源熔断时长',
          desc: '触发熔断后停用该数据源的时长。' },
        { key: 'thirdPartyTimeoutMs', group: 'net', type: 'int', def: 5000, min: 1000, max: 30000, unit: '毫秒',
          label: '第三方存档站单次超时',
          desc: 'biliplus 与 jijidown 每次请求的超时。刻意短于通用 GET 超时，避免慢速存档站拖住页面修补。' },
        { key: 'biliplusChunk', group: 'net', type: 'int', def: 50, min: 1, max: 200, unit: '条',
          label: 'biliplus 每批查询条数',
          desc: '单次请求携带的 av 号数量。调高可减少请求次数，但更易触发对方限流。' },
        { key: 'jijidownPollMs', group: 'net', type: 'int', def: 1200, min: 200, max: 10000, unit: '毫秒',
          label: 'jijidown 重轮询间隔',
          desc: 'jijidown 首次查询冷门条目会先返回「正在加载」，需隔一段时间再问一次。' },
        { key: 'jijidownMaxPolls', group: 'net', type: 'int', def: 2, min: 0, max: 10, unit: '次',
          label: 'jijidown 重轮询次数',
          desc: '首次请求之外的追加轮询次数。设为 0 即不再追问，冷门条目基本查不到。' },
        { key: 'enableBiliplus', group: 'net', type: 'bool', def: true,
          label: '启用 biliplus 存档源',
          desc: '关闭后不再向 biliplus.com 发送任何请求。启用时该站会收到失效视频的 av 号。' },
        { key: 'enableJijidown', group: 'net', type: 'bool', def: true,
          label: '启用 jijidown 存档源',
          desc: '关闭后不再向 jijidown.com 发送任何请求。启用时该站会收到失效视频的 av 号。' },

        // ── 备份 ──
        { key: 'backupMaxPages', group: 'backup', type: 'int', def: 500, min: 10, max: 2000, unit: '页',
          label: '备份走访页数上限',
          desc: '每页 20 条。备份是用户主动发起的一次性操作，上限刻意远高于修复扫描：截断即等于丢失数据。' },
        { key: 'backupPageDelayMs', group: 'backup', type: 'int', def: 300, min: 0, max: 5000, unit: '毫秒',
          label: '备份翻页间隔',
          desc: '相邻两页之间的等待时间。调低会加快备份，但请求密度更高。' },
        { key: 'backupBlobConcurrency', group: 'backup', type: 'int', def: 3, min: 1, max: 16, unit: '并发',
          label: '封面下载并发数',
          desc: '同时下载多少张封面。调高更快，但占用更多内存与带宽。' },
        { key: 'backupProgressEvery', group: 'backup', type: 'int', def: 3, min: 1, max: 50, unit: '页',
          label: '备份进度提示间隔',
          desc: '每走访这么多页弹出一次进度提示。第一页始终提示。' },

        // ── 界面与调试 ──
        { key: 'mgrPageSize', group: 'ui', type: 'int', def: 20, min: 5, max: 100, unit: '条',
          label: '备份管理每页条数',
          desc: '备份管理面板一页列出多少条记录。调高会同时加载更多封面缩略图。' },
        { key: 'mgrSearchDebounceMs', group: 'ui', type: 'int', def: 300, min: 50, max: 2000, unit: '毫秒',
          label: '备份管理搜索延迟',
          desc: '停止输入多久之后才执行过滤。' },
        { key: 'tooltipRefreshMs', group: 'ui', type: 'int', def: 1000, min: 200, max: 10000, unit: '毫秒',
          label: '悬浮信息刷新间隔',
          desc: '鼠标停留在仍在重试的卡片上时，信息浮层的刷新频率。' },
        { key: 'debug', group: 'ui', type: 'bool', def: false, gmKey: 'debug',
          label: '调试日志',
          desc: '在浏览器控制台输出详细过程日志。与菜单中的「开关调试日志」是同一个开关。',
          apply: function (v) { DEBUG = v; } }
    ];

    // key → entry. A linear scan per cfg() call would be fine at this size,
    // but cfg() sits on the DOM-patch path and this index costs nothing.
    var _cfgIndex = (function () {
        var m = {};
        for (var i = 0; i < SETTINGS_SCHEMA.length; i++) m[SETTINGS_SCHEMA[i].key] = SETTINGS_SCHEMA[i];
        return m;
    })();

    // key → resolved value. Populated lazily by cfg(); invalidated only by
    // cfgSet / cfgReset — nothing else may write it.
    var _cfgCache = {};

    function cfgEntry(key) { return _cfgIndex[key] || null; }
    function cfgGmKey(e)   { return e.gmKey || (SETTINGS_PREFIX + e.key); }

    // Parse + validate ONE candidate against its schema row. Returns
    // {ok:true, value} or {ok:false, error}. Feeds both user input (strings
    // out of the modal) and stored values (already typed), so every branch
    // has to accept the string form as well.
    function cfgCoerce(e, raw) {
        if (e.type === 'bool') {
            if (typeof raw === 'boolean') return { ok: true, value: raw };
            if (raw === 'true'  || raw === 1 || raw === '1') return { ok: true, value: true };
            if (raw === 'false' || raw === 0 || raw === '0') return { ok: true, value: false };
            return { ok: false, error: '必须是开或关' };
        }
        if (e.type === 'int') {
            var s = String(raw).trim();
            if (!s) return { ok: false, error: '不能为空' };
            var n = Number(s);
            if (!isFinite(n)) return { ok: false, error: '必须是数字' };
            if (Math.floor(n) !== n) return { ok: false, error: '必须是整数' };
            if (n < e.min || n > e.max) return { ok: false, error: '取值范围 ' + e.min + ' – ' + e.max };
            return { ok: true, value: n };
        }
        if (e.type === 'intlist') {
            var parts = Array.isArray(raw)
                ? raw.slice()
                : String(raw).split(/[,，\s]+/).filter(function (x) { return x !== ''; });
            if (parts.length < e.minLen || parts.length > e.maxLen) {
                return { ok: false, error: '需要 ' + e.minLen + ' – ' + e.maxLen + ' 个数值' };
            }
            var out = [];
            for (var i = 0; i < parts.length; i++) {
                var v = Number(String(parts[i]).trim());
                if (!isFinite(v) || Math.floor(v) !== v) {
                    return { ok: false, error: '第 ' + (i + 1) + ' 项不是整数' };
                }
                if (v < e.min || v > e.max) {
                    return { ok: false, error: '第 ' + (i + 1) + ' 项超出范围 ' + e.min + ' – ' + e.max };
                }
                // The ladder is indexed by a counter that only grows, so a dip
                // would make the script back off LESS the longer a failure
                // persists — the opposite of what a backoff is for.
                if (i && v < out[i - 1]) {
                    return { ok: false, error: '第 ' + (i + 1) + ' 项小于前一项，必须非递减' };
                }
                out.push(v);
            }
            return { ok: true, value: out };
        }
        return { ok: false, error: '未知的设置类型' };
    }

    // The live value. Never throws: an unreadable store, a value written by an
    // older version whose bounds have since narrowed, or a key dropped from the
    // schema all degrade to the default rather than taking a caller down with
    // them — every call site here is on a path the user is watching.
    function cfg(key) {
        if (Object.prototype.hasOwnProperty.call(_cfgCache, key)) return _cfgCache[key];
        var e = cfgEntry(key);
        if (!e) { warn('cfg: unknown setting ' + key); return undefined; }
        var val = e.def;
        try {
            var raw = GM_getValue(cfgGmKey(e), null);
            if (raw !== null && raw !== undefined) {
                var r = cfgCoerce(e, raw);
                if (r.ok) val = r.value;
                else warn('cfg: stored value for ' + key + ' rejected (' + r.error + ') — using default');
            }
        } catch (err) { warn('cfg: read failed for ' + key, err); }
        // Frozen because the memo hands the SAME array to every caller: an
        // accidental push / sort at one call site would otherwise rewrite the
        // setting for the rest of this page's life.
        if (Array.isArray(val)) Object.freeze(val);
        _cfgCache[key] = val;
        return val;
    }

    function cfgIsDefault(key) {
        var e = cfgEntry(key);
        if (!e) return true;
        var v = cfg(key);
        // Arrays compare by identity, and the stored one is a different object
        // from e.def even when it holds the same numbers.
        if (Array.isArray(e.def)) return String(v) === String(e.def);
        return v === e.def;
    }

    // Validate → persist → memoise → apply. A value equal to the default
    // DELETES its store entry instead of writing it, so "what has this user
    // actually changed" stays answerable, and a future change to a default
    // still reaches everyone who never touched that setting.
    function cfgSet(key, raw) {
        var e = cfgEntry(key);
        if (!e) return { ok: false, error: '未知设置项' };
        var r = cfgCoerce(e, raw);
        if (!r.ok) return r;
        var isDef = Array.isArray(e.def) ? (String(r.value) === String(e.def)) : (r.value === e.def);
        try {
            if (isDef) GM_deleteValue(cfgGmKey(e));
            else GM_setValue(cfgGmKey(e), r.value);
        } catch (err) {
            warn('cfg: write failed for ' + key, err);
            return { ok: false, error: '无法写入设置存储' };
        }
        if (Array.isArray(r.value)) Object.freeze(r.value);
        _cfgCache[key] = r.value;
        // A throwing hook must not make the write look failed: the value IS
        // stored by this point, and saying otherwise would invite the user to
        // set it a second time.
        if (e.apply) {
            try { e.apply(r.value); }
            catch (err2) { warn('cfg: apply hook threw for ' + key, err2); }
        }
        return { ok: true, value: r.value };
    }

    function cfgReset(key) {
        var e = cfgEntry(key);
        if (!e) return { ok: false, error: '未知设置项' };
        return cfgSet(key, e.def);
    }

    // Resets one group, or everything when groupId is omitted. Returns how many
    // settings were actually carrying a non-default value, so a caller can tell
    // "已恢复 6 项" apart from "nothing to reset".
    function cfgResetAll(groupId) {
        var n = 0;
        for (var i = 0; i < SETTINGS_SCHEMA.length; i++) {
            var e = SETTINGS_SCHEMA[i];
            if (groupId && e.group !== groupId) continue;
            if (cfgIsDefault(e.key)) continue;
            if (cfgReset(e.key).ok) n++;
        }
        return n;
    }

    // Every non-default setting — for the debug surface, and for the "what did
    // you change" question every bug report eventually needs answered.
    function cfgChanged() {
        var out = {};
        for (var i = 0; i < SETTINGS_SCHEMA.length; i++) {
            var k = SETTINGS_SCHEMA[i].key;
            if (!cfgIsDefault(k)) out[k] = cfg(k);
        }
        return out;
    }

    // Run every `apply` hook once at boot, so a mirrored value (DEBUG) reflects
    // the store from the first line of the first patch rather than from the
    // first time someone happens to open the settings modal.
    function cfgBoot() {
        for (var i = 0; i < SETTINGS_SCHEMA.length; i++) {
            var e = SETTINGS_SCHEMA[i];
            if (!e.apply) continue;
            try { e.apply(cfg(e.key)); }
            catch (err) { warn('cfg: boot apply threw for ' + e.key, err); }
        }
    }
