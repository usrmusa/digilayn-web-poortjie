#!/usr/bin/env python3
"""Generate explicit service targets; adapt file routing only in the local output."""
import argparse
import json
import posixpath
import re
import shutil
from pathlib import Path
from urllib.parse import unquote, urlsplit, urlunsplit


def local_navigation(source):
    """Wrap existing navigation expressions without replacing browser APIs."""
    source = re.sub(
        r'((?:window\.(?:top\.)?)?location\.(?:replace|assign)\()([^;\n]*?)(\);)',
        lambda m: m[1] + 'window.PoortjieLocalRouting.resolve(' + m[2] + ')' + m[3], source)
    literal = r"(?:'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w.$]*)"
    return re.sub(r'((?:window\.(?:top\.)?)?location\.href\s*=\s*)(' + literal + r')',
                  lambda m: m[1] + 'window.PoortjieLocalRouting.resolve(' + m[2] + ')', source)


def build(target):
    root = Path(__file__).resolve().parents[1]
    output = root / 'dist' / target
    shutil.copytree(root, output, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns('.git', '.idea', 'dist', 'AGENTS.md', '__pycache__'))
    config = output / 'scripts/build-target.js'
    config.write_text(config.read_text().replace("const target = 'live';", f"const target = '{target}';"))
    if target == 'local':
        files = {p.relative_to(output).as_posix() for p in output.rglob('*') if p.is_file()}
        pages = {name[:-5]: name for name in files if name.endswith('.html')}
        for name in files:
            if name == 'index.html' or name.endswith('/index.html'):
                directory = name[:-10]
                pages[directory] = name
                if directory: pages[directory.rstrip('/')] = name
        routing = (root / 'tools/templates/local-routing.js').read_text()
        routing = routing.replace('__LOCAL_FILES__', json.dumps(sorted(files))).replace('__LOCAL_PAGES__', json.dumps(pages, sort_keys=True))
        (output / 'scripts/local-routing.js').write_text(routing)
        for name in files:
            p = output / name
            if p.suffix not in {'.html', '.js'} or name.startswith(('tests/', 'tools/')): continue
            source = p.read_text()
            if name == 'scripts/site.js':
                source = source.replace("  'use strict';", "  'use strict';\n  if (window.PoortjieLocalRouting) return;", 1)
            else:
                source = local_navigation(source)
            if p.suffix == '.html':
                directory = posixpath.dirname(name) or '.'
                def local_reference(value):
                    url = urlsplit(value)
                    if url.scheme or url.netloc or not url.path: return value
                    candidate = posixpath.normpath(unquote(url.path).lstrip('/') if url.path.startswith('/') else posixpath.join(directory, unquote(url.path)))
                    if candidate == '.': candidate = ''
                    file = pages.get(candidate, candidate)
                    if file not in files: return value
                    return urlunsplit(('', '', posixpath.relpath(file, directory), url.query, url.fragment))
                source = re.sub(r'\b(href|src|action)=("|\')([^"\']*)\2',
                                lambda m: m[1] + '=' + m[2] + local_reference(m[3]) + m[2], source)
                source = re.sub(r'(content=["\']\d+;\s*url=)([^"\']+)',
                                lambda m: m[1] + local_reference(m[2]), source, flags=re.I)
                # IntelliJ protects local resources; manifest requests must carry its credentials.
                source = re.sub(r'(<link\b(?=[^>]*\brel=[\"\']manifest[\"\'])[^>]*)(>)',
                                lambda m: m[1] + ' crossorigin="use-credentials"' + m[2], source)
                script = posixpath.relpath('scripts/local-routing.js', directory)
                source = source.replace('<head>', f'<head>\n    <script src="{script}"></script>', 1)
            p.write_text(source)
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('target', choices=('local', 'live'))
    print(build(parser.parse_args().target))
