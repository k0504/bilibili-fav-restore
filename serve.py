# -*- coding: utf-8 -*-
"""Tiny local HTTP server that serves the userscript core (assembled live).

Why this exists:
  Tampermonkey rejects http://127.0.0.1 as an @updateURL (insecure-origin
  policy), so we can't have the userscript auto-update from a local source.
  The bootstrap stub (`bilibili-fav-list-fix.user.js`) is therefore pinned
  at @version 1.0.0 forever and fetches the latest core JS from THIS
  server every time a matched page loads.

Usage:
  python serve.py        # listens on http://127.0.0.1:8766/
  python serve.py 9000   # custom port

The bootstrap fetches /bilibili-fav-list-fix-core.js, which this server
ASSEMBLES on the fly from src/*.js (see bundle.py) — there is no file by that
name on disk. Edit any src/ module freely; each tab reload pulls the freshly
assembled core (no build step, no Tampermonkey re-touch).

Only the bootstrap (a real file) and the virtual core path are served (see
ALLOWED_PATHS); the repo root holds .git/, build.py, src/, etc., and there's
no reason to expose the whole tree even on loopback. src/ in particular is
NOT exposed — only the assembled core is.

Port 8766 (8765 was taken by another long-running process; switched
2026-05-22). If you change it, update bilibili-fav-list-fix.user.js
SERVER_BASE and README to match.
"""
import sys
import os
import io
import hashlib
import http.server
import socketserver
from functools import partial

import bundle

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 8766

# Virtual path: the core is NOT a file on disk anymore — it is ASSEMBLED on
# the fly from src/*.js (see bundle.py) so the dev loop stays "edit a src
# module + reload tab" with no build step. send_head() synthesizes this path;
# the bootstrap path below is a real file served normally.
CORE_VIRTUAL_PATH = '/bilibili-fav-list-fix-core.js'

# Whitelist of paths this server will serve. The bootstrap only ever fetches
# the core; the browser only ever navigates to the bootstrap. Everything else
# (.git/, build.py, src/, dist/, README, ...) 404s — a whitelist beats
# blacklisting sensitive prefixes because it can't silently miss a newly-added
# one. NOTE: src/ is deliberately NOT exposed; only the assembled core is.
ALLOWED_PATHS = frozenset([
    '/bilibili-fav-list-fix.user.js',
    CORE_VIRTUAL_PATH,
])


class CoreHandler(http.server.SimpleHTTPRequestHandler):
    """Serves files from ROOT with no-cache header, mirroring dl-manager.

    Header set deliberately minimal to match dl-manager's FastAPI FileResponse
    (`Cache-Control: no-cache`, no `Pragma`, no `no-store`):
      - `no-store` was previously here and seems to break some Tampermonkey
        install detection paths (TM caches the response briefly to inspect
        the metadata block; `no-store` forbids that). Removed.
      - `Pragma` was redundant with `Cache-Control`; HTTP/1.0-only fallback.
    """

    # Python's SimpleHTTPRequestHandler defaults to HTTP/1.0. Newer
    # Tampermonkey versions appear to assume HTTP/1.1 semantics (persistent
    # connections, chunked transfer, etc.) when deciding whether to fire
    # the userscript install flow on direct navigation. dl-manager's
    # uvicorn serves HTTP/1.1 and works; mirror that here.
    protocol_version = 'HTTP/1.1'

    # Override the default `Server: SimpleHTTP/0.6 Python/3.12.7` banner.
    # The "Python" token in the header has been observed to trip various
    # extension/security blocklists. dl-manager's uvicorn replies with
    # `server: uvicorn` and works on the same browser where we don't,
    # so mirror that exact string. sys_version='' suppresses the trailing
    # Python version token entirely.
    server_version = 'uvicorn'
    sys_version = ''

    def send_head(self):
        # Whitelist gate: only the bootstrap + (virtual) core are ever served.
        # Strip query (bootstrap appends ?t=…) and fragment before matching.
        path = self.path.split('?', 1)[0].split('#', 1)[0]
        if path not in ALLOWED_PATHS:
            self.send_error(404, 'Not Found')
            return None
        # The core is synthesized from src/*.js, not read off disk.
        if path == CORE_VIRTUAL_PATH:
            return self._send_core()
        # Bootstrap: a real file. Compute a weak ETag from the file's mtime+size
        # so we can mirror dl-manager's FastAPI FileResponse, which sends both
        # ETag and Accept-Ranges. TM has been observed to treat responses
        # without ETag as "incomplete" on the install-detection path. Cache it
        # on the instance so end_headers() can emit it.
        try:
            st = os.stat(self.translate_path(self.path))
            self._etag = '"%s"' % hashlib.md5(
                ('%d-%d' % (int(st.st_mtime), st.st_size)).encode('ascii')
            ).hexdigest()
        except OSError:
            self._etag = None
        return super().send_head()

    def _send_core(self):
        """Assemble the core from src/*.js and serve it from memory.

        Returns the same kind of thing SimpleHTTPRequestHandler.send_head
        returns for a real file — a readable body object, with the status line
        and headers already written — so the base do_GET/do_HEAD copy loop
        works unchanged. Differences from the disk path:
          - ETag is the CONTENT hash (there is no on-disk mtime to key off).
          - Content-Type is forced to application/javascript (TM only fires the
            install/update flow on that type — AGENTS.md gotcha #4).
          - Content-Length is set, so HTTP/1.1 keep-alive stays on (no
            Connection: close) — preserves the install-detection round-trip
            behaviour documented on ThreadedHTTPServer (gotcha #5).
        """
        try:
            body = bundle.build_core_bytes()
        except bundle.BundleError as e:
            # src/ vs MANIFEST mismatch (or an unreadable module) would ship a
            # broken core. Return 500 with the reason and log it, rather than
            # silently serving a truncated/empty body; the bootstrap surfaces
            # "core HTTP 500" on the page so the dev notices immediately.
            sys.stderr.write('[serve] core assembly failed: %s\n' % e)
            self.send_error(500, 'core assembly failed')
            return None
        self._etag = '"%s"' % hashlib.md5(body).hexdigest()
        self.send_response(200)
        self.send_header('Content-Type', 'application/javascript')
        self.send_header('Content-Length', str(len(body)))
        # end_headers() (overridden below) appends Cache-Control / Accept-Ranges
        # / ETag and writes the terminating blank line.
        self.end_headers()
        return io.BytesIO(body)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        # NOTE: do NOT emit `Connection: close`. With HTTP/1.1 + keep-alive,
        # TM's install-detection flow can re-use the TCP connection for the
        # multiple round-trips it makes (metadata probe → content probe →
        # install-dialog trigger). Forcing close adds a full TCP handshake
        # per round-trip, which makes the install URL feel "stuck for ages"
        # before the dialog appears. SimpleHTTPRequestHandler's base class
        # DOES have a keep-alive loop (BaseHTTPRequestHandler.handle()
        # iterates while not self.close_connection).
        self.send_header('Accept-Ranges', 'bytes')
        if getattr(self, '_etag', None):
            self.send_header('ETag', self._etag)
        super().end_headers()

    def guess_type(self, path):
        # Force .user.js / .js to application/javascript.
        # Python's mime db maps .js → text/javascript; some Tampermonkey
        # versions only fire the userscript install/update flow when the
        # response is application/javascript, so navigating to the .user.js
        # URL with text/javascript silently displays as text instead of
        # prompting install. dl-manager's FastAPI backend serves with this
        # explicit content-type for the same reason.
        if path.endswith('.user.js') or path.endswith('.js'):
            return 'application/javascript'
        return super().guess_type(path)

    def log_message(self, fmt, *args):
        # One-line, timestamped, only the request line — no extra noise.
        sys.stderr.write('[%s] %s %s\n' % (
            self.log_date_time_string(),
            self.address_string(),
            fmt % args,
        ))


class ThreadedHTTPServer(socketserver.ThreadingTCPServer):
    """Threaded so TM's install-detection round-trips run concurrently.

    Default `TCPServer` is single-threaded and serializes every request
    on one thread. TM's install path fires multiple requests back-to-back
    against tampermonkey.net/script_installation.php → our server; with
    serial handling, each one waits for the previous to finish, which
    presents as "the install dialog takes forever to appear" (the user
    described it as taking ~30s). ThreadingTCPServer fans each request
    onto its own daemon thread; install dialog appears immediately.
    """
    daemon_threads = True              # don't block process exit
    allow_reuse_address = True         # rebind without TIME_WAIT delay


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    handler = partial(CoreHandler, directory=ROOT)
    with ThreadedHTTPServer(('127.0.0.1', port), handler) as httpd:
        print('bilibili-fav-list-fix serving %s on http://127.0.0.1:%d/' % (ROOT, port))
        print('  bootstrap: http://127.0.0.1:%d/bilibili-fav-list-fix.user.js' % port)
        print('  core:      http://127.0.0.1:%d/bilibili-fav-list-fix-core.js' % port)
        print('Press Ctrl+C to stop.')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nbye.')


if __name__ == '__main__':
    main()
