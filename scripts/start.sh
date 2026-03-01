#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

LT_PID=""
cleanup() {
  if [[ -n "$LT_PID" ]] && kill -0 "$LT_PID" >/dev/null 2>&1; then
    kill "$LT_PID" >/dev/null 2>&1 || true
    wait "$LT_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [[ "${TRANSLATE_TO_ID:-true}" != "false" ]]; then
  "${ROOT_DIR}/scripts/run-libretranslate.sh" &
  LT_PID=$!
  sleep 2
fi

exec node "${ROOT_DIR}/src/index.js"
