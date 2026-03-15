#!/usr/bin/env bash

set -euo pipefail

APP_NAMESPACE="argocd"
WORKLOAD_NAMESPACE="workflow-builder"
PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_RECONCILE_ANNOTATION="argocd.argoproj.io/skip-reconcile"
REFRESH_ANNOTATION="argocd.argoproj.io/refresh"
ARGO_APPS=(
  "workflow-builder"
  "ms-agent-workflow"
)
DEVSPACE_REPLACEMENT_DEPLOYMENTS=(
  "workflow-builder-devspace"
  "ms-agent-workflow-devspace"
)
PRODUCTION_DEPLOYMENTS=(
  "workflow-builder"
  "ms-agent-workflow"
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
  devspace dev "$@"
}

main "$@"
