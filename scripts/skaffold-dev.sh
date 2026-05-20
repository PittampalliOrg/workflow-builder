#!/usr/bin/env bash
# Wrapper for `skaffold dev` that pauses + resumes ArgoCD for the target apps.
#
# Why a wrapper instead of Skaffold lifecycle hooks: Skaffold's deploy.hooks
# fire per-deploy-cycle (one pause per file save), and there is no first-class
# "cleanup on Ctrl-C" event we can rely on across versions. A shell `trap` is
# version-agnostic and matches the devspace-dev-ryzen.sh pattern.
#
# Usage:
#   bash scripts/skaffold-dev.sh                          # default: workflow-builder
#   bash scripts/skaffold-dev.sh workflow-builder         # explicit
#   bash scripts/skaffold-dev.sh workflow-builder workflow-orchestrator
#
# Recovery if `kill -9` skips the trap:
#   ARGO_APPS="<apps>" bash skaffold/hooks/argo-resume.sh

set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"

modules=("$@")
if [ "${#modules[@]}" -eq 0 ]; then
  modules=(workflow-builder)
fi

# Argo apps default to the same names as the skaffold module list (matches our
# convention: one module = one Argo app). Override via $ARGO_APPS.
if [ -z "${ARGO_APPS:-}" ]; then
  ARGO_APPS="${modules[*]}"
fi
export ARGO_APPS

ns="${ARGO_NS:-argocd}"
export ARGO_NS="${ns}"

resumed=0
resume_argo() {
  if [ "${resumed}" -ne 0 ]; then
    return 0
  fi
  resumed=1
  printf '\n==> Resuming ArgoCD for: %s\n' "${ARGO_APPS}"
  bash skaffold/hooks/argo-resume.sh ${ARGO_APPS} || true
}

trap resume_argo EXIT INT TERM

printf '==> Pausing ArgoCD for: %s\n' "${ARGO_APPS}"
bash skaffold/hooks/argo-pause.sh ${ARGO_APPS}

# Comma-separated for `skaffold -m`.
mod_csv="$(IFS=,; echo "${modules[*]}")"

printf '==> skaffold dev -m %s\n' "${mod_csv}"
exec skaffold dev -m "${mod_csv}" "${SKAFFOLD_DEV_EXTRA_ARGS:-}"
