#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENV_DIR="${ROOT_DIR}/.venv-libretranslate"
PY_BIN="${PYTHON_BIN:-python3}"
HOST="${LIBRETRANSLATE_HOST:-127.0.0.1}"
PORT="${LIBRETRANSLATE_PORT:-5000}"

if [[ "${TRANSLATE_TO_ID:-true}" == "false" ]]; then
  echo "[libretranslate] TRANSLATE_TO_ID=false, skipping translator service"
  exit 0
fi

if ! command -v "$PY_BIN" >/dev/null 2>&1; then
  echo "[libretranslate] ERROR: python3 not found"
  exit 1
fi

if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  echo "[libretranslate] Creating virtualenv at ${VENV_DIR}"
  "$PY_BIN" -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

if ! python -c "import libretranslate" >/dev/null 2>&1; then
  echo "[libretranslate] Installing libretranslate into venv"
  pip install --upgrade pip >/dev/null
  pip install libretranslate >/dev/null
fi

echo "[libretranslate] Starting on ${HOST}:${PORT}"
exec libretranslate --host "$HOST" --port "$PORT"
