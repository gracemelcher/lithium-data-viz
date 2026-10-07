#!/usr/bin/env python3
"""Static server for the atlas that never lets the browser cache anything.

python3 -m http.server sends no cache headers at all, which leaves browsers
free to hold on to ES modules. Editing src/*.js then reloading can give you a
page stitched together from old and new files — the symptom is things quietly
not working: a button with no handler, a layer that never appears.

    python3 python_scripts/serve.py            # http://localhost:8000
    python3 python_scripts/serve.py 8412       # another port

Ctrl-C to stop.
"""

import functools
import http.server
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = "dymaxion_atlas.html"


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "404" in (fmt % args):                 # keep the noise down
            sys.stderr.write("  missing: %s\n" % (args[0] if args else "?"))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with Server(("", port), handler) as httpd:
        print(f"serving {ROOT}")
        print(f"  http://localhost:{port}/{PAGE}")
        print("  no-store headers set, so a plain reload always picks up edits")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
