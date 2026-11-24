#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -x ".venv/bin/python" ]; then
  echo "Error: Virtual environment not found. Run ./setup_unix.sh first." >&2
  exit 1
fi

echo "Starting StemForge Local GPU Server on http://127.0.0.1:8000 ..."
exec .venv/bin/python -m uvicorn gpu_server:app --host 127.0.0.1 --port 8000
