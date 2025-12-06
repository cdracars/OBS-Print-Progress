#!/usr/bin/env bash
PORT=${PORT:-8000}
URL="http://localhost:${PORT}/printer.html"

echo "Starting simple server on ${URL}"
echo "Press Ctrl+C to stop."
echo

if ! command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1; then
  echo "Python is required (python3 -m http.server). Please install Python."
  exit 1
fi

PYTHON_BIN="python3"
command -v python3 >/dev/null 2>&1 || PYTHON_BIN="python"

cd "$(dirname "$0")" || exit 1
${PYTHON_BIN} -m http.server "${PORT}"
