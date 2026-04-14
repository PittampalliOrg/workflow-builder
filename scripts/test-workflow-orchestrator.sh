#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="${ROOT_DIR}/services/workflow-orchestrator"

if command -v nix >/dev/null 2>&1; then
  GCC_LIB="$(nix eval --raw nixpkgs#gcc.cc.lib.outPath 2>/dev/null || true)"
  if [ -n "${GCC_LIB}" ] && [ -d "${GCC_LIB}/lib" ]; then
    export LD_LIBRARY_PATH="${GCC_LIB}/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
  fi
fi

if [ "$#" -eq 0 ]; then
  set -- "${PROJECT_DIR}/tests"
fi

exec uv run --project "${PROJECT_DIR}" pytest "$@"
