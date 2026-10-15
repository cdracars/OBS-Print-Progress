#!/usr/bin/env bash
# Starts the OBS Print Progress server and opens the setup page.
# Keep this running while you stream. Ctrl+C to stop.
cd "$(dirname "$0")" || exit 1

PYTHON_BIN=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'; then
    PYTHON_BIN="$candidate"
    break
  fi
done

if [ -z "$PYTHON_BIN" ]; then
  echo "Python 3.8 or newer is required."
  echo "  macOS:  install from https://www.python.org/downloads/ (or: brew install python)"
  echo "  Linux:  sudo apt install python3"
  exit 1
fi

exec "$PYTHON_BIN" server.py "$@"
