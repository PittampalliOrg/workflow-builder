#!/usr/bin/env bash
#
# Thin wrapper around `devspace dev` that:
#   1. Injects the default profile (openshell-inner-loop) if none specified
#   2. Guards against duplicate DevSpace sessions
#
# All ArgoCD pause/resume logic lives in devspace.yaml (pipelines.dev + hooks).

set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_PROFILE="openshell-inner-loop"
WL_NS="workflow-builder"
ARGO_NS="argocd"
ARGO_APPS=(workflow-builder workflow-orchestrator function-router)
SKIP_ANNOTATION="argocd.argoproj.io/skip-reconcile"
REFRESH_ANNOTATION="argocd.argoproj.io/refresh"

args=("$@")
profile="$DEFAULT_PROFILE"
for i in "${!args[@]}"; do
  if [[ "${args[$i]}" == "--profile" || "${args[$i]}" == "-p" ]]; then
    profile="${args[$((i + 1))]}"
    break
  fi
done
if [[ " ${args[*]} " != *" --profile "* ]] && [[ " ${args[*]} " != *" -p "* ]]; then
  args=(--profile "$profile" "${args[@]}")
fi

# Guard: if replacement deployments already exist, session is running
if kubectl get deployment -n "$WL_NS" -l devspace.sh/replaced=true -o name 2>/dev/null | grep -q .; then
  stale_session=0
  while IFS= read -r line; do
    ready="${line%%/*}"
    desired="${line##*/}"
    if [[ "$ready" != "$desired" ]]; then
      stale_session=1
      break
    fi
  done < <(
    kubectl get deployment -n "$WL_NS" -l devspace.sh/replaced=true \
      -o jsonpath='{range .items[*]}{.status.readyReplicas}/{.status.replicas}{"\n"}{end}' 2>/dev/null
  )

  if [[ "$stale_session" -eq 1 ]]; then
    printf '==> Found degraded DevSpace replacement deployments. Purging stale session first.\n'
    (cd "$PROJECT_ROOT" && devspace purge --force-purge --profile "$profile") || true
  else
    printf '==> DevSpace session already active. Use devspace enter/attach/logs.\n'
    exit 0
  fi
fi

printf '==> Using kube context: %s\n' "$(kubectl config current-context 2>/dev/null || echo unknown)"
printf '==> Profile: %s\n' "$profile"

for app in "${ARGO_APPS[@]}"; do
  if kubectl get application "$app" -n "$ARGO_NS" >/dev/null 2>&1; then
    kubectl annotate application "$app" \
      -n "$ARGO_NS" \
      "${SKIP_ANNOTATION}=true" \
      --overwrite >/dev/null 2>&1 || true
  fi
done

cd "$PROJECT_ROOT"
set +e
devspace dev "${args[@]}"
status=$?
set -e

for app in "${ARGO_APPS[@]}"; do
  kubectl annotate application "$app" \
    -n "$ARGO_NS" \
    "${SKIP_ANNOTATION}-" >/dev/null 2>&1 || true
  kubectl annotate application "$app" \
    -n "$ARGO_NS" \
    "${REFRESH_ANNOTATION}=hard" \
    --overwrite >/dev/null 2>&1 || true
done

if [[ "$status" -ne 0 ]]; then
  printf '==> DevSpace exited with status %s. Purging failed replacement session.\n' "$status"
  devspace purge --force-purge --profile "$profile" || true
fi

exit "$status"
