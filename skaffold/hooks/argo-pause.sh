#!/usr/bin/env bash
# Pause ArgoCD reconcile for the listed apps. Idempotent — safe to re-run.
#
# Usage:
#   ARGO_APPS="workflow-builder workflow-orchestrator" bash argo-pause.sh
#   bash argo-pause.sh workflow-builder workflow-orchestrator
#
# Reads apps from $ARGO_APPS (space-separated) OR positional args. If both are
# provided, the positional args win.

set -euo pipefail

if [ "$#" -gt 0 ]; then
  apps=("$@")
else
  : "${ARGO_APPS:?ARGO_APPS env required (or pass apps as positional args)}"
  # shellcheck disable=SC2206
  apps=(${ARGO_APPS})
fi

ns="${ARGO_NS:-argocd}"

for app in "${apps[@]}"; do
  if ! kubectl get application "${app}" -n "${ns}" >/dev/null 2>&1; then
    echo "argo-pause: skip ${app} (not found in ${ns})" >&2
    continue
  fi
  kubectl annotate application "${app}" -n "${ns}" \
    "argocd.argoproj.io/skip-reconcile=true" --overwrite >/dev/null
  echo "argo-pause: paused ${app}"
done
