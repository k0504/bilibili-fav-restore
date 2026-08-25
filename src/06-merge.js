    // ─── Quality predicates ────────────────────────────────────────────
    //
    // Returning 0 means "skip this value, try the next source for this field".

    var COVER_PLACEHOLDER_RE = /be27fd62/i;
    var QUALITY = {
        cover: function (url) {
            if (!url) return 0;
            if (COVER_PLACEHOLDER_RE.test(url)) return 0;
            if (/bfs\/archive/i.test(url)) return 10;
            return 5;
        },
        title: function (t) {
            if (!t) return 0;
            t = String(t).trim();
            if (t === '已失效视频' || t === '该视频已被删除' || t === '已失效') return 0;
            return 10;
        },
        upper: function (u) {
            if (!u || typeof u !== 'object') return 0;
            if (!u.name || u.name === '账号已注销' || u.name === '账号已注销.') return 0;
            return 10;
        },
        cnt_info: function (c) {
            if (!c || typeof c !== 'object') return 0;
            // Public endpoint sometimes returns all zeros for invalid items;
            // Android-app endpoint preserves the snapshot. Prefer whichever
            // has more non-zero fields (handled by priority + this check).
            var nonzero = 0;
            for (var k in c) if (c[k] && typeof c[k] === 'number') nonzero++;
            return nonzero > 0 ? 10 : 1;
        },
        'default': function (v) {
            if (v == null) return 0;
            if (typeof v === 'string' && !v.trim()) return 0;
            if (Array.isArray(v) && v.length === 0) return 0;
            return 10;
        }
    };

    // Priority order: source name LEFT wins if its value passes QUALITY.
    // `backup` (15a-backup.js) leads every field it supplies: it is the only
    // source captured while the video was still ALIVE, so its snapshot beats
    // any post-mortem one by construction. It is absent from attr / link /
    // playback_desc on purpose — those describe the item's CURRENT state and
    // must come from a live source.
    // 3rd-party archives (biliplus / jijidown) carry only title/cover/
    // upper.name — they're the last-resort fallback for items even the
    // Android-app snapshot couldn't save.
    var FIELD_PRIORITY = {
        // Android endpoint preserves invalid-item snapshots for these.
        cover:    ['backup', 'android', 'public', 'biliplus', 'jijidown'],
        title:    ['backup', 'android', 'public', 'biliplus', 'jijidown'],
        upper:    ['backup', 'android', 'public', 'biliplus', 'jijidown'],
        intro:    ['backup', 'android', 'public'],
        duration: ['backup', 'android', 'public'],
        playback_desc: ['android', 'public'],
        attr:     ['android', 'public'],
        link:     ['android', 'public'],
        bvid:     ['backup', 'public', 'android'],
        // Public endpoint has these; Android omits them for invalid items:
        cnt_info: ['backup', 'public',  'android'],
        pubtime:  ['backup', 'public'],
        ctime:    ['backup', 'public',  'android'],
        fav_time: ['backup', 'public'],
        tid:      ['backup', 'public'],
        pages:    ['backup', 'public'],
        page:     ['backup', 'public',  'android']
    };

    function mergeBySource(perSource) {
        var out = {};
        var srcs = Object.keys(SOURCES);
        // Field-priority merge
        for (var field in FIELD_PRIORITY) {
            var order = FIELD_PRIORITY[field];
            for (var i = 0; i < order.length; i++) {
                var src = order[i];
                var data = perSource[src];
                if (!data) continue;
                var v = data[field];
                var q = (QUALITY[field] || QUALITY['default'])(v);
                if (q > 0) { out[field] = v; out['_src_' + field] = src; break; }
            }
        }
        // Pass-through for any field not covered by FIELD_PRIORITY (e.g.
        // oid, otype, ugc, card_type, jump_link…). First source that has
        // the field wins (Android > public by registry order).
        for (var s = 0; s < srcs.length; s++) {
            var d = perSource[srcs[s]];
            if (!d) continue;
            for (var k in d) {
                if (out[k] !== undefined) continue;
                if (FIELD_PRIORITY[k]) continue;
                out[k] = d[k];
            }
        }
        out._sources = Object.keys(perSource);
        // Degenerate = neither cover nor title passed QUALITY from any source.
        // Card will render visually unchanged (placeholder cover + "已失效视频"
        // text) but with the red marker — easy to confuse with a permanent
        // 404. Flagged so loadCache can use a short TTL: the most common
        // cause is Android API's walk-to-walk drop (server returns the av
        // on some walks, not others), and a fresh walk in ~10 min often
        // recovers it. Without the short TTL, one bad walk locks in 30 days.
        if (!out._src_cover && !out._src_title) out._degenerate = true;
        return out;
    }

    // Shared promotion predicate: is this merged record a CONFIDENT full
    // recovery — one whose cover AND title are real, settled data? Used by
    // the backup walker's merged-fallback gate (15a buildBackupRecord) and by
    // the recovery-time promotion pipeline (15e-promote.js), so the two can
    // never drift apart on what "confident" means. The _degenerate / _pending
    // / _cover_pending exclusions are implied by requiring both _src_* fields
    // (mergeBySource only sets those when QUALITY passed), and the QUALITY
    // re-checks are likewise redundant — stated anyway as belt-and-braces,
    // because a record passing this gate may be written into the backup store
    // where a bad value would be served back as gospel forever.
    function promotionGate(m) {
        return !!m
            && !m._degenerate && !m._pending && !m._cover_pending
            && !!m._src_cover && !!m._src_title
            && QUALITY.cover(m.cover) >= 5
            && QUALITY.title(m.title) >= 10;
    }

