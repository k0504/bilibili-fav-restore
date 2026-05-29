    // ─── URL / page detection ───────────────────────────────────────────

    function detectMediaId() {
        // Pattern 1: www.bilibili.com/list/ml{media_id}
        var m = location.pathname.match(/\/list\/ml(\d+)/);
        if (m) return m[1];
        // Pattern 2: ?fid={media_id} on space.bilibili.com/{mid}/favlist
        var qs = new URLSearchParams(location.search);
        var fid = qs.get('fid');
        if (fid) return fid;
        // Pattern 3: ?fav_id={media_id} (some new pages)
        var favId = qs.get('fav_id');
        if (favId) return favId;
        return null;
    }

    function isFavPage() {
        return /\/favlist/.test(location.pathname) || /\/list\/ml\d+/.test(location.pathname);
    }

    // ─── DOM scanning / patching ────────────────────────────────────────

    function findInvalidContainers() {
        // Strategy 1: covers whose URL contains the placeholder hash token.
        // Filter out imgs we've already processed (recovered → solid red
        // mark, OR _no_source → "nodata" mark); they still match the
        // selector because we don't rewrite the placeholder URL on nodata,
        // but re-processing them is wasted observer work and inflates
        // `invalidDetectedNow` to the user.
        var imgs = document.querySelectorAll(
            'img[src*="' + PLACEHOLDER_COVER_TOKEN + '"]:not([data-fav-fix-marked])'
        );
        var nodes = Array.from(imgs).map(function (img) {
            // Resolve the container to the WHOLE fav card, not the first
            // ancestor that happens to hold a /video/ link. On the modern
            // layout that ancestor is `div.bili-video-card__cover`, which
            // contains the cover <img> but NOT the title — the title is a
            // sibling leaf <a>. A cover-only container means patchTitle can
            // never reach the title node, so a recovered item shows its real
            // cover with a stale "（视频已删除）" / "已失效视频" title (verified
            // on a real card). Scoping to the card keeps cover AND title in
            // one patchable subtree.
            var card = img.closest(CARD_SELECTOR);
            if (card) {
                return { container: card, img: img, link: card.querySelector('a[href*="/video/"]') };
            }
            // Fallback (img not inside a known card class): old walk-up.
            var n = img;
            while (n && n !== document.body) {
                var a = n.querySelector && n.querySelector('a[href*="/video/"]');
                if (a) return { container: n, img: img, link: a };
                n = n.parentElement;
            }
            return { container: img.parentElement, img: img, link: null };
        });

        // Strategy 2 (fallback): titles that match "已失效视频" exactly.
        // Only used to detect items whose cover URL doesn't include the
        // placeholder token (some pages render an inline SVG instead).
        //
        // Scope the scan to fav cards (CARD_SELECTOR) instead of every
        // p/span/div/a in the document. The old全-document querySelectorAll
        // returned thousands of nodes (sidebar / nav / recs / footer) and ran
        // on every debounced observer tick — the heaviest single step in the
        // patch cycle. Cards are ~20-40 per page, so this is one to two orders
        // of magnitude fewer nodes. Container resolution (walk up to the
        // nearest /video/ link ancestor) is kept identical to Strategy 1 so
        // the two strategies produce the SAME container object for a card and
        // the dedupe below still collapses them.
        var titleHits = [];
        var cards = document.querySelectorAll(CARD_SELECTOR);
        for (var ci = 0; ci < cards.length; ci++) {
            var card = cards[ci];
            var cand = card.querySelectorAll('p, span, div, a');
            var titleEl = null;
            for (var k = 0; k < cand.length; k++) {
                if (cand[k].children.length === 0 && cand[k].textContent.trim() === INVALID_TITLE) {
                    titleEl = cand[k];
                    break;
                }
            }
            if (!titleEl) continue;
            // Container = the whole card (same as Strategy 1), so the dedupe
            // below collapses both strategies' hits for one card into one and
            // patchTitle/patchCover share a single subtree that holds both the
            // title leaf and the cover <img>.
            var link2 = card.querySelector('a[href*="/video/"]');
            if (link2) titleHits.push({ container: card, img: card.querySelector('img'), link: link2, titleEl: titleEl });
        }

        // Merge by container (dedupe).
        var seen = new Set();
        var out = [];
        nodes.concat(titleHits).forEach(function (hit) {
            if (!hit.container || seen.has(hit.container)) return;
            seen.add(hit.container);
            out.push(hit);
        });
        return out;
    }

    function extractAvFromLink(href) {
        if (!href) return null;
        var m = href.match(/\/video\/av(\d+)/i);
        if (m) return m[1];
        // BV → bvid; we can't resolve to av without an extra API call.
        // The fav API returns oid as av number, so BV-only items would
        // need a BV→av conversion. For POC, skip BV-only items and log.
        var bv = href.match(/\/video\/(BV[0-9A-Za-z]+)/);
        if (bv) { log('skip BV-only item (av not derivable from DOM)', bv[1]); return null; }
        return null;
    }

    function avToBv(aid) {
        // 2023 new-algorithm AV→BV (mirror of bvToAv below). Verbatim from
        // bilibili-API-collect docs/misc/bvid_desc.md JS section.
        var XOR_CODE  = 23442827791579n;
        var MAX_AID   = 1n << 51n;
        var BASE      = 58n;
        var data = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf';
        try {
            var bytes = ['B','V','1','0','0','0','0','0','0','0','0','0'];
            var bvIdx = bytes.length - 1;
            var tmp = (MAX_AID | BigInt(aid)) ^ XOR_CODE;
            while (tmp > 0n) {
                bytes[bvIdx] = data[Number(tmp % BASE)];
                tmp = tmp / BASE;
                bvIdx -= 1;
            }
            var t;
            t = bytes[3]; bytes[3] = bytes[9]; bytes[9] = t;
            t = bytes[4]; bytes[4] = bytes[7]; bytes[7] = t;
            return bytes.join('');
        } catch (e) { return null; }
    }

    function bvToAv(bvid) {
        // 2023 new-algorithm BV→AV. Verbatim from bilibili-API-collect
        // docs/misc/bvid_desc.md JS section. Pure function; works for any
        // 12-char "BV1XXXXXXXXX" issued after 2020-03-23 (i.e. anything a
        // modern fav page would link to). Pre-2020 BVs with the old 6-char
        // layout will decode to garbage — but those are essentially extinct
        // on modern bilibili.
        var XOR_CODE  = 23442827791579n;
        var MASK_CODE = 2251799813685247n;
        var MAX_AID   = 1n << 51n;
        var BASE      = 58n;
        var data = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf';
        try {
            if (typeof bvid !== 'string' || bvid.length !== 12) return null;
            var arr = bvid.split('');
            var t;
            t = arr[3]; arr[3] = arr[9]; arr[9] = t;
            t = arr[4]; arr[4] = arr[7]; arr[7] = t;
            arr.splice(0, 3);
            var tmp = 0n;
            for (var i = 0; i < arr.length; i++) {
                var idx = data.indexOf(arr[i]);
                if (idx < 0) return null;
                tmp = tmp * BASE + BigInt(idx);
            }
            var avBig = (tmp & MASK_CODE) ^ XOR_CODE;
            if (avBig <= 0n || avBig >= MAX_AID) return null;
            return avBig.toString();
        } catch (e) { return null; }
    }

    function getAvFromHit(hit) {
        var href = hit.link && hit.link.getAttribute('href');
        if (!href) return null;
        var m = href.match(/\/video\/av(\d+)/i);
        if (m) return m[1];
        var bv = href.match(/\/video\/(BV[0-9A-Za-z]+)/);
        if (bv) return bvToAv(bv[1]);
        return null;
    }

    function patchCover(img, realCoverUrl) {
        if (!img || !realCoverUrl) return;
        // bilibili web is https — Android-app responses are sometimes http.
        var u = realCoverUrl.replace(/^http:\/\//, 'https://');
        if (img.getAttribute('data-fav-fix-original')) return; // already patched
        img.setAttribute('data-fav-fix-original', img.src || '');
        img.src = u;
        img.style.opacity = '1';
    }

    // Rewrite an element's visible title text in place. The title is a leaf
    // (text-only) on bilibili's card, so we set its first non-empty text node
    // and blank any extras — keeping the element itself (and its listeners /
    // data attrs) rather than reassigning textContent wholesale.
    function setTitleText(el, text) {
        var tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        var n, set = false;
        while ((n = tw.nextNode())) {
            if (!n.nodeValue.trim()) continue;
            if (!set) { n.nodeValue = text; set = true; }
            else n.nodeValue = '';
        }
        if (!set) el.textContent = text;
    }

    function patchTitle(container, realTitle) {
        if (!container || !realTitle) return;
        // Robust path: once a prior patch tagged the title element, update it
        // directly — independent of what it currently shows ("已失效视频",
        // "（视频已删除）", or a previous real title). The old text-match-only
        // approach was one-shot: after the first rewrite the text no longer
        // equalled INVALID_TITLE, so a later refetch (android flap → recovered)
        // updated the cover but never the title. Verified on a real card: the
        // title is a leaf <a> outside the cover container, reachable here only
        // via the INVALID_TITLE match, which can never fire twice.
        var tagged = container.querySelectorAll('[data-fav-fix-title]');
        if (tagged.length) {
            tagged.forEach(function (el) {
                // Leaf element → safe to rewrite text. Non-leaf (tagged only
                // for its title attribute) → leave children, just fix the attr.
                if (el.children.length === 0) setTitleText(el, realTitle);
                if (el.hasAttribute('title')) el.setAttribute('title', realTitle);
            });
            return;
        }
        // First touch: rewrite the INVALID_TITLE leaf and tag it so subsequent
        // patches skip the (fragile) text match.
        var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
        var node;
        while ((node = walker.nextNode())) {
            if (node.nodeValue.trim() === INVALID_TITLE) {
                node.nodeValue = node.nodeValue.replace(INVALID_TITLE, realTitle);
                if (node.parentElement) node.parentElement.setAttribute('data-fav-fix-title', '1');
            }
        }
        // Also patch + tag title attributes (native tooltip).
        container.querySelectorAll('[title="' + INVALID_TITLE + '"]').forEach(function (el) {
            el.setAttribute('title', realTitle);
            el.setAttribute('data-fav-fix-title', '1');
        });
    }

