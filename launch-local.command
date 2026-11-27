#!/bin/bash
# Finder starts this in Terminal; resolve all paths relative to this launcher.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd -- "$(dirname -- "$0")" || exit 1
if ! python3 tools/launch-local.py; then
    printf '\nLocal website could not start. Review the error above.\n'
    read -r -p 'Press Return to close.'
    exit 1
fi
