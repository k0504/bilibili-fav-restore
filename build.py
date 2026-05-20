# -*- coding: utf-8 -*-
"""Build the end-user single-file userscript at dist/bilibili-fav-restore.user.js.

Why this exists:
  The dev workflow uses a two-layer setup — `bilibili-fav-list-fix.user.js`
  (bootstrap, pinned at @version 1.0.0) fetches `bilibili-fav-list-fix-core.js`
  from a local `serve.py` and `eval`s it. That's great for iteration (edit
  core → reload tab) but terrible for end users (they'd have to install
  Python + run a server).

  This script bundles the SAME core into a self-contained userscript with
  GitHub-raw @updateURL, so end users can install via a single Tampermonkey
  link and TM will auto-update them when we commit a new dist/.

Outputs:
  dist/bilibili-fav-restore.user.js  (committed to git so the raw URL serves)

Run:
  python build.py

Cross-file invariants:
  - `@version` in dist/ MUST equal `CORE_VERSION` in core.js. TM's auto-update
    only fires when @version increases — bumping core but not rebuilding dist
    means end users get stuck.
  - `@grant` list MUST be a superset of every GM_* API the core actually
    calls. Keep this in sync with the bootstrap's @grant block (they are the
    same list by design).
  - `@connect` list drops `127.0.0.1` / `localhost` (single-file has no
    server fetch). The rest must match the bootstrap's @connect list.
  - Do NOT include the bootstrap's eval/fetch logic in dist/. The core is
    inlined directly — it runs as the userscript body, not via eval.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
CORE_PATH = os.path.join(ROOT, 'bilibili-fav-list-fix-core.js')
OUT_DIR   = os.path.join(ROOT, 'dist')
OUT_PATH  = os.path.join(OUT_DIR, 'bilibili-fav-restore.user.js')

GH_USER = 'k0504'
GH_REPO = 'bilibili-fav-restore'
RAW_BASE = 'https://raw.githubusercontent.com/%s/%s/main/dist' % (GH_USER, GH_REPO)


def extract_core_version(src):
    """Pull `var CORE_VERSION = 'x.y.z';` out of core.js."""
    m = re.search(r"var\s+CORE_VERSION\s*=\s*['\"]([^'\"]+)['\"]", src)
    if not m:
        sys.stderr.write('FATAL: could not find CORE_VERSION in core.js\n')
        sys.exit(1)
    return m.group(1)


def build_header(version):
    """Userscript meta block for the end-user single-file build.

    Headers are written here (not generated from bootstrap) so the bootstrap's
    eval/fetch comments don't leak into the dist file. Keep grant/connect
    lists in sync with bootstrap — there's no programmatic check, it's a
    documented gotcha in AGENTS.md.
    """
    lines = [
        '// ==UserScript==',
        '// @name         Bilibili 收藏夹失效视频还原',
        '// @name:en      Bilibili Fav Restore',
        '// @namespace    https://github.com/%s/%s' % (GH_USER, GH_REPO),
        '// @version      ' + version,
        '// @description  在 bilibili 网页版收藏夹页面，自动还原失效（已删除 / UP 自删）视频的原始封面、标题与 metadata。',
        '// @description:en  Restore original cover/title/metadata of invalid (deleted) videos on bilibili web favorites pages.',
        '// @author       %s' % GH_USER,
        '// @homepageURL  https://github.com/%s/%s' % (GH_USER, GH_REPO),
        '// @supportURL   https://github.com/%s/%s/issues' % (GH_USER, GH_REPO),
        '// @updateURL    %s/bilibili-fav-restore.user.js' % RAW_BASE,
        '// @downloadURL  %s/bilibili-fav-restore.user.js' % RAW_BASE,
        '// @match        https://space.bilibili.com/*',
        '// @match        https://www.bilibili.com/list/*',
        '// @match        https://www.bilibili.com/medialist/*',
        '// @match        https://www.bilibili.com/favlist*',
        '// @grant        GM_xmlhttpRequest',
        '// @grant        GM_getValue',
        '// @grant        GM_setValue',
        '// @grant        GM_deleteValue',
        '// @grant        GM_listValues',
        '// @grant        GM_setClipboard',
        '// @grant        GM_openInTab',
        '// @grant        GM_registerMenuCommand',
        '// @grant        unsafeWindow',
        '// @run-at       document-start',
        '// @connect      api.bilibili.com',
        '// @connect      passport.bilibili.com',
        '// @connect      hdslb.com',
        '// @connect      biliplus.com',
        '// @connect      jijidown.com',
        '// @connect      xbeibeix.com',
        '// @license      MIT',
        '// ==/UserScript==',
        '',
        '/*',
        ' * AUTO-GENERATED — do not edit by hand.',
        ' * Source: bilibili-fav-list-fix-core.js (CORE_VERSION = ' + version + ')',
        ' * Regenerate with: python build.py',
        ' *',
        ' * For dev workflow (edit core + reload tab without rebuilding) see',
        ' * README "Development" section — uses bilibili-fav-list-fix.user.js',
        ' * (bootstrap) + serve.py instead.',
        ' */',
        '',
    ]
    return '\n'.join(lines)


def main():
    with open(CORE_PATH, 'r', encoding='utf-8') as f:
        core_src = f.read()

    version = extract_core_version(core_src)
    header = build_header(version)

    os.makedirs(OUT_DIR, exist_ok=True)
    out = header + core_src
    with open(OUT_PATH, 'w', encoding='utf-8', newline='\n') as f:
        f.write(out)

    print('built %s' % OUT_PATH)
    print('  @version = %s (from CORE_VERSION)' % version)
    print('  size     = %d bytes' % len(out.encode('utf-8')))
    print('  raw URL  = %s/bilibili-fav-restore.user.js' % RAW_BASE)


if __name__ == '__main__':
    main()
