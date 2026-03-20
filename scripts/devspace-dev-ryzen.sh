#!/usr/bin/env bash

set -euo pipefail

APP_NAMESPACE="argocd"
WORKLOAD_NAMESPACE="workflow-builder"
PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_RECONCILE_ANNOTATION="argocd.argoproj.io/skip-reconcile"
REFRESH_ANNOTATION="argocd.argoproj.io/refresh"
DEFAULT_DEVSPACE_PROFILE="openshell-inner-loop"
ARGO_APPS=(
  "workflow-builder"
  "function-router"
  "workflow-orchestrator"
)
DEVSPACE_REPLACEMENT_DEPLOYMENTS=(
  "workflow-builder-devspace"
  "function-router-devspace"
  "workflow-orchestrator-devspace"
)
PRODUCTION_DEPLOYMENTS=(
  "workflow-builder"
  "function-router"
  "workflow-orchestrator"
)

cleanup() {
  local exit_code="$1"

  set +e

  printf '\n==> Resetting DevSpace pods\n'
  (
    cd "$PROJECT_ROOT"
    devspace reset pods --silent --force
  )

  for deployment in "${DEVSPACE_REPLACEMENT_DEPLOYMENTS[@]}"; do
    printf '==> Waiting for %s to disappear\n' "$deployment"
    kubectl wait \
      --namespace "$WORKLOAD_NAMESPACE" \
      --for=delete "deployment/${deployment}" \
      --timeout=180s >/dev/null 2>&1 || true
  done

  for app in "${ARGO_APPS[@]}"; do
    printf '==> Resuming ArgoCD reconciliation for %s\n' "$app"
    kubectl annotate application "$app" \
      --namespace "$APP_NAMESPACE" \
      "${SKIP_RECONCILE_ANNOTATION}-" >/dev/null 2>&1 || true
    kubectl annotate application "$app" \
      --namespace "$APP_NAMESPACE" \
      "${REFRESH_ANNOTATION}=hard" \
      --overwrite >/dev/null 2>&1 || true
  done

  for deployment in "${PRODUCTION_DEPLOYMENTS[@]}"; do
    printf '==> Waiting for the production deployment %s to be ready again\n' "$deployment"
    kubectl rollout status \
      --namespace "$WORKLOAD_NAMESPACE" \
      "deployment/${deployment}" \
      --timeout=180s >/dev/null 2>&1 || true
  done

  exit "$exit_code"
}

main() {
  local devspace_args=("$@")

  trap 'cleanup "$?"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  printf '==> Using kube context: %s\n' "$(kubectl config current-context 2>/dev/null || echo unknown)"
  for app in "${ARGO_APPS[@]}"; do
    printf '==> Verifying ArgoCD application %s exists\n' "$app"
    kubectl get application "$app" --namespace "$APP_NAMESPACE" >/dev/null

    printf '==> Pausing ArgoCD reconciliation for %s\n' "$app"
    kubectl annotate application "$app" \
      --namespace "$APP_NAMESPACE" \
      "${SKIP_RECONCILE_ANNOTATION}=true" \
      --overwrite >/dev/null
  done

  printf '==> Starting DevSpace session\n'
  cd "$PROJECT_ROOT"
  if [[ " ${devspace_args[*]} " != *" --profile "* ]] && [[ " ${devspace_args[*]} " != *" -p "* ]]; then
    devspace_args=(--profile "$DEFAULT_DEVSPACE_PROFILE" "${devspace_args[@]}")
  fi

  devspace dev "${devspace_args[@]}"
}

main "$@"
