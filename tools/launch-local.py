#!/usr/bin/env python3
"""Build and serve only the local Firebase target for Finder launches."""
import argparse
import errno
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import webbrowser
from urllib.request import build_opener, ProxyHandler

ROOT = Path(__file__).resolve().parents[1]
PORT = 8102

class LocalHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        resolved = Path(super().translate_path(path))
        if not resolved.exists() and not resolved.suffix:
            html = resolved.with_suffix('.html')
            if html.is_file():
                return str(html)
        return str(resolved)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--page', default='index.html', help='Page relative to the local build root')
    args = parser.parse_args()
    subprocess.run([sys.executable, str(ROOT / 'tools/build-site.py'), 'local'], check=True)
    output = ROOT / 'dist/local'
    config = (output / 'scripts/build-target.js').read_text()
    if "const target = 'local';" not in config or "const target = 'live';" in config:
        raise RuntimeError('Local build target verification failed; server was not started.')
    page = (output / args.page).resolve()
    if not page.is_relative_to(output.resolve()) or not page.is_file() or page.suffix != '.html':
        raise RuntimeError('Requested page must be an existing HTML file inside the local build.')
    url = f'http://127.0.0.1:{PORT}/{page.relative_to(output.resolve()).as_posix()}'
    handler = partial(LocalHandler, directory=str(output))
    try:
        server = ThreadingHTTPServer(('127.0.0.1', PORT), handler)
    except OSError as error:
        if error.errno != errno.EADDRINUSE:
            raise
        opener = build_opener(ProxyHandler({}))
        with opener.open(f'http://127.0.0.1:{PORT}/scripts/build-target.js', timeout=3) as response:
            served_config = response.read().decode('utf-8')
        if served_config != config:
            raise RuntimeError('Port is occupied by a different build; refusing to reuse it.') from error
        print(f'Opening existing local website: {url}', flush=True)
        webbrowser.open(url)
        return
    with server:
        print(f'\nLocal website: {url}', flush=True)
        print('Firebase target: online testing.', flush=True)
        print('Keep this Terminal window open. Press Control-C to stop.\n', flush=True)
        webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print('\nLocal website stopped.')

if __name__ == '__main__':
    main()
