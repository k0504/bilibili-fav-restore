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
  - `@grant` / `@match` / `@connect` are NO LONGER hand-copied here. They are
    PARSED from the bootstrap (bilibili-fav-list-fix.user.js) — the single
    source of truth — so the two lists can't drift. `@connect` drops
    `127.0.0.1` / `localhost` (the single-file build has no local server).
  - A lint step (lint_grants) fails the build if core.js calls a GM_* API
    that the bootstrap's @grant block doesn't cover, so a forgotten @grant
    surfaces at build time instead of as a runtime ReferenceError.
  - Do NOT include the bootstrap's eval/fetch logic in dist/. The core is
    inlined directly — it runs as the userscript body, not via eval.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
CORE_PATH = os.path.join(ROOT, 'bilibili-fav-list-fix-core.js')
BOOTSTRAP_PATH = os.path.join(ROOT, 'bilibili-fav-list-fix.user.js')
OUT_DIR   = os.path.join(ROOT, 'dist')
OUT_PATH  = os.path.join(OUT_DIR, 'bilibili-fav-restore.user.js')

# @connect entries the single-file build must NOT carry (dev-server only).
LOCAL_CONNECTS = ('127.0.0.1', 'localhost')

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


def extract_header_block(src):
    """Return the text between `// ==UserScript==` and `// ==/UserScript==`."""
    m = re.search(r'//\s*==UserScript==(.*?)//\s*==/UserScript==', src, re.S)
    if not m:
        sys.stderr.write('FATAL: no ==UserScript== block found in bootstrap\n')
        sys.exit(1)
    return m.group(1)


def parse_meta(header_block, key):
    """All values of `// @<key> <value>` lines, in order. Bare key only —
    `@name:zh-TW` does NOT match key 'name' (the ':' breaks the \\s+)."""
    pat = re.compile(r'^//\s*@' + re.escape(key) + r'\s+(\S.*?)\s*$')
    out = []
    for line in header_block.splitlines():
        mm = pat.match(line)
        if mm:
            out.append(mm.group(1).strip())
    return out


def lint_grants(core_src, bootstrap_src):
    """Fail the build if core.js calls a GM_* API the bootstrap doesn't grant.

    Catches the AGENTS.md gotcha (#2/#11): a new GM_* call in core without a
    matching @grant makes TM set that API to undefined -> runtime ReferenceError
    only when the code path runs. Surface it at build time instead.
    """
    granted = set(parse_meta(extract_header_block(bootstrap_src), 'grant'))
    used = set(re.findall(r'\b(GM_\w+)\s*\(', core_src))
    missing = sorted(used - granted)
    if missing:
        sys.stderr.write(
            'FATAL: core.js calls GM_* APIs missing from the bootstrap @grant '
            'block: ' + ', '.join(missing) + '\n'
            '  Add the @grant line(s) to bilibili-fav-list-fix.user.js, then '
            'rebuild.\n')
        sys.exit(1)
    unused = sorted(g for g in granted if g.startswith('GM_') and g not in used)
    if unused:
        sys.stderr.write(
            'WARN: bootstrap @grant lists GM_* not called by core.js: '
            + ', '.join(unused) + ' (safe to remove if intentional)\n')


def build_header(version, bootstrap_src):
    """Userscript meta block for the end-user single-file build.

    @match / @grant / @connect are parsed from the bootstrap (single source of
    truth) so the two can't drift; @connect drops the dev-server entries.
    Everything else (@name / @description / @updateURL / ...) is dist-specific
    and built here. Locale variants: bare @name/@description 为简体（主要语言）；
    @*:zh-TW 繁体；@*:en 英文（Tampermonkey 按 navigator.language 自动挑选）。
    """
    hb = extract_header_block(bootstrap_src)
    matches  = parse_meta(hb, 'match')
    grants   = parse_meta(hb, 'grant')
    connects = [c for c in parse_meta(hb, 'connect') if c not in LOCAL_CONNECTS]
    if not (matches and grants and connects):
        sys.stderr.write('FATAL: could not parse @match/@grant/@connect from bootstrap\n')
        sys.exit(1)

    lines = [
        '// ==UserScript==',
        '// @name         Bilibili 收藏夹失效视频信息还原',
        '// @name:zh-TW   Bilibili 收藏夾失效影片資訊還原',
        '// @name:en      Bilibili Fav Restore',
        '// @namespace    https://github.com/%s/%s' % (GH_USER, GH_REPO),
        '// @version      ' + version,
        '// @description  在 bilibili 网页版收藏夹页面，自动还原失效（已删除 / UP 自删）视频的原始封面、标题与 metadata。',
        '// @description:zh-TW  在 bilibili 網頁版收藏夾頁面，自動還原失效（已刪除 / UP 自刪）影片的原始封面、標題與 metadata。',
        '// @description:en  Restore original cover/title/metadata of invalid (deleted) videos on bilibili web favorites pages.',
        '// @author       %s' % GH_USER,
        '// @homepageURL  https://github.com/%s/%s' % (GH_USER, GH_REPO),
        '// @supportURL   https://github.com/%s/%s/issues' % (GH_USER, GH_REPO),
        '// @updateURL    %s/bilibili-fav-restore.user.js' % RAW_BASE,
        '// @downloadURL  %s/bilibili-fav-restore.user.js' % RAW_BASE,
    ]
    lines += ['// @match        ' + m for m in matches]
    lines += ['// @grant        ' + g for g in grants]
    lines.append('// @run-at       document-start')
    lines += ['// @connect      ' + c for c in connects]
    lines += [
        '// @license      MIT',
        '// ==/UserScript==',
        '',
        '/*',
        ' * AUTO-GENERATED — do not edit by hand.',
        ' * Source: bilibili-fav-list-fix-core.js (CORE_VERSION = ' + version + ')',
        ' * @match/@grant/@connect parsed from bilibili-fav-list-fix.user.js.',
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
    with open(BOOTSTRAP_PATH, 'r', encoding='utf-8') as f:
        bootstrap_src = f.read()

    # Fail fast before writing dist: a GM_* call without a matching @grant
    # would otherwise ship a broken userscript.
    lint_grants(core_src, bootstrap_src)

    version = extract_core_version(core_src)
    header = build_header(version, bootstrap_src)

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
