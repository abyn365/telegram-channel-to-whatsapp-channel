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

ensure_venv() {
  local venv_py="${VENV_DIR}/bin/python"

  if [[ ! -x "$venv_py" ]]; then
    echo "[libretranslate] Creating virtualenv at ${VENV_DIR}"
    rm -rf "$VENV_DIR"
    if ! "$PY_BIN" -m venv "$VENV_DIR"; then
      echo "[libretranslate] ERROR: failed creating venv. Install python venv package (e.g. apt install python3-venv)."
      exit 1
    fi
  fi

  if [[ ! -x "${VENV_DIR}/bin/pip" ]]; then
    echo "[libretranslate] pip not found in venv, recreating ${VENV_DIR}"
    rm -rf "$VENV_DIR"
    "$PY_BIN" -m venv "$VENV_DIR"
  fi
}

ensure_venv

VENV_PY="${VENV_DIR}/bin/python"
VENV_PIP="${VENV_DIR}/bin/pip"
VENV_LT_BIN="${VENV_DIR}/bin/libretranslate"

if ! "$VENV_PY" -c "import libretranslate" >/dev/null 2>&1; then
  echo "[libretranslate] Installing libretranslate into venv"
  "$VENV_PIP" install --upgrade pip >/dev/null
  "$VENV_PIP" install libretranslate >/dev/null
fi

if [[ ! -x "$VENV_LT_BIN" ]]; then
  echo "[libretranslate] libretranslate binary not found, reinstalling"
  "$VENV_PIP" install --upgrade --force-reinstall libretranslate >/dev/null
fi

echo "[libretranslate] Starting on ${HOST}:${PORT}"
exec "$VENV_LT_BIN" --host "$HOST" --port "$PORT"
