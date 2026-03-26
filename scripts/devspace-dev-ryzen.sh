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
  printf '==> DevSpace session already active. Use devspace enter/attach/logs.\n'
  exit 0
fi

printf '==> Using kube context: %s\n' "$(kubectl config current-context 2>/dev/null || echo unknown)"
printf '==> Profile: %s\n' "$profile"

cd "$PROJECT_ROOT"
exec devspace dev "${args[@]}"
