#!/usr/bin/env bash
# Resume ArgoCD reconcile + hard refresh. Idempotent — safe to re-run.
#
# Usage:
#   ARGO_APPS="workflow-builder workflow-orchestrator" bash argo-resume.sh
#   bash argo-resume.sh workflow-builder workflow-orchestrator
#
# If Skaffold is `kill -9`'d and the dev wrapper's trap doesn't fire, run this
# by hand to recover. Annotation removal is `<key>-` syntax; `2>/dev/null ||
# true` masks the "annotation not found" case so the script stays idempotent.

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
    echo "argo-resume: skip ${app} (not found in ${ns})" >&2
    continue
  fi
  kubectl annotate application "${app}" -n "${ns}" \
    "argocd.argoproj.io/skip-reconcile-" 2>/dev/null || true
  kubectl annotate application "${app}" -n "${ns}" \
    "argocd.argoproj.io/refresh=hard" --overwrite >/dev/null
  echo "argo-resume: resumed ${app}"
done
