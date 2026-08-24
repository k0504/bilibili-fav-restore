# -*- coding: utf-8 -*-
"""Single source of truth for assembling the userscript core from src/*.js.

Why this exists:
  The core ships as ONE eval-able IIFE (see AGENTS.md: bootstrap fetches it and
  `eval`s it in the isolated world; build.py inlines it into dist/). For
  maintainability the core is SPLIT BY CONCERN under src/, and this module
  concatenates the pieces back into that single IIFE.

  Both consumers import build_core() so the dev bytes and the release bytes can
  never drift:
    - serve.py  (dev)     synthesizes the virtual /bilibili-fav-list-fix-core.js
                          live on each fetch — no build step, edit src/ + reload.
    - build.py  (release) inlines the assembled core into dist/.

How the concatenation works:
  Raw byte join, NO separators. The src/ files were produced by slicing the
  historical single-file core at line boundaries, so each file already ends
  exactly where the next begins. ''.join(MANIFEST files) therefore reproduces
  the original core byte-for-byte. Do NOT insert newlines/headers between files
  — that would shift the bytes and (harmlessly but needlessly) change dist/.

  Because files are concatenated into ONE function scope, every `var` / function
  declaration is hoisted across the whole IIFE, so cross-file references work
  regardless of file order at call time. Only top-level `var X = <expr>` INIT
  runs in MANIFEST order — keep that order matching the historical top-to-bottom
  layout (it already does).
"""
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(ROOT, 'src')


class BundleError(Exception):
    """src/ and MANIFEST disagree, or a module is unreadable. Callers decide
    the consequence: build.py aborts the build, serve.py returns HTTP 500."""


# Authoritative load order. The numeric filename prefix mirrors this for human
# scanning, but THIS list is the source of truth — order is data, not
# glob-sort luck. A new module MUST be registered here (check_manifest enforces
# it) so a forgotten file fails loudly instead of silently dropping code.
MANIFEST = [
    '00-prologue.js',       # banner, IIFE open, load guard, pageWin
    '01-constants.js',      # appkeys/tokens, MAX_PAGE_WALK, CARD_SELECTOR, DEBUG, log/warn
    '02-md5.js',            # blueimp-md5 (inline, MIT)
    '03-http.js',           # signParams, toQuery, gmGet, gmPostForm
    '04-auth.js',           # auth storage + TV QR login + manual login
    '05-sources.js',        # source intro doc, failure gate, SOURCES, normalizePublicResp
    '06-merge.js',          # QUALITY, FIELD_PRIORITY, mergeBySource
    '07-cache.js',          # persistent per-avid GM cache + in-memory page/item maps
    '08-resolver.js',       # ensurePage, hasGoodCoverAndTitle, resolveItems
    '09-dom.js',            # URL/page detection + DOM scan + cover/title patch
    '10-tooltip.js',        # shared format helpers (esc/fmt*/pickPub*) + hover tooltip
    '11-menu.js',           # buildPlainInfo (clipboard) + per-card 3-dot menu
    '12-markers.js',        # loading overlay + patched-badge markers
    '13-missing.js',        # silently-dropped item recovery + banner
    '14-orchestrate.js',    # applyPatch, patchOnce, schedule, MutationObserver
    '15-toast.js',          # bottom-center toast
    '15a-backup.js',        # IndexedDB backup store + walker + SOURCES.backup
    '16-menu-commands.js',  # GM_registerMenuCommand wiring
    '17-boot.js',           # boot + __biliFavFix debug surface + IIFE close
]


def check_manifest():
    """Fail loudly if src/ and MANIFEST disagree — a new .js not registered, or
    a manifest entry with no file on disk. Either way the assembled core would
    be wrong; surface it instead of silently shipping it."""
    try:
        on_disk = set(f for f in os.listdir(SRC_DIR) if f.endswith('.js'))
    except OSError as e:
        raise BundleError('cannot read src/ dir %s: %s' % (SRC_DIR, e))
    listed = set(MANIFEST)
    missing = sorted(listed - on_disk)
    if missing:
        raise BundleError('MANIFEST lists src files that do not exist: '
                          + ', '.join(missing))
    unlisted = sorted(on_disk - listed)
    if unlisted:
        raise BundleError('src/ has .js not registered in bundle.MANIFEST '
                          '(add them in load order): ' + ', '.join(unlisted))


def build_core_bytes():
    """Assemble the core as bytes — byte-identical to the historical single
    file. Raw join, no separators (see module docstring)."""
    check_manifest()
    out = bytearray()
    for name in MANIFEST:
        path = os.path.join(SRC_DIR, name)
        try:
            with open(path, 'rb') as f:
                out += f.read()
        except OSError as e:
            raise BundleError('cannot read module %s: %s' % (name, e))
    return bytes(out)


def build_core():
    """Assemble the core as a str (utf-8). build.py wants text for header
    concatenation; serve.py wants bytes (Content-Length) via build_core_bytes."""
    return build_core_bytes().decode('utf-8')


if __name__ == '__main__':
    import hashlib
    blob = build_core_bytes()
    print('core: %d bytes · %d modules · md5 %s'
          % (len(blob), len(MANIFEST), hashlib.md5(blob).hexdigest()))
