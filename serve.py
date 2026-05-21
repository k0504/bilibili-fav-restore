# -*- coding: utf-8 -*-
"""Tiny local HTTP server that serves the userscript core file.

Why this exists:
  Tampermonkey rejects http://127.0.0.1 as an @updateURL (insecure-origin
  policy), so we can't have the userscript auto-update from a local source.
  The bootstrap stub (`bilibili-fav-list-fix.user.js`) is therefore pinned
  at @version 1.0.0 forever and fetches the latest core JS from THIS
  server every time a matched page loads.

Usage:
  python serve.py        # listens on http://127.0.0.1:8765/
  python serve.py 9000   # custom port

The bootstrap fetches /bilibili-fav-list-fix-core.js. Edit that file freely
— each tab reload pulls the latest version (no Tampermonkey re-touch).

Port 8765 chosen to avoid clashing with dl-manager (which uses 8000).
"""
import sys
import os
import hashlib
import http.server
import socketserver
from functools import partial

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 8766


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
        # Compute a weak ETag from the file's mtime+size so we can mirror
        # dl-manager's FastAPI FileResponse, which sends both ETag and
        # Accept-Ranges. TM has been observed to treat responses without
        # ETag as "incomplete" on the install-detection path. Cache it
        # on the instance so end_headers() can emit it.
        try:
            st = os.stat(self.translate_path(self.path))
            self._etag = '"%s"' % hashlib.md5(
                ('%d-%d' % (int(st.st_mtime), st.st_size)).encode('ascii')
            ).hexdigest()
        except OSError:
            self._etag = None
        return super().send_head()

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
