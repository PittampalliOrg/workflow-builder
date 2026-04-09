#!/usr/bin/env bash
#
# Thin wrapper around `devspace dev` that:
#   1. Injects the default profile (openshell-inner-loop) if none specified
#   2. Guards against duplicate DevSpace sessions
#
# ArgoCD pause/resume and workflow-builder service routing live in devspace.yaml
# (pipelines.dev + hooks). This wrapper should not try to manage them separately.

set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_PROFILE="openshell-inner-loop"
WL_NS="workflow-builder"
TAILSCALE_INGRESS_NAME="workflow-builder-tailscale"
TAILSCALE_HOST_FALLBACK="workflow-builder-ryzen.tail286401.ts.net"
WORKFLOW_BUILDER_SERVICE="workflow-builder"
WORKFLOW_BUILDER_SELECTOR='app=workflow-builder,devspace.sh/replaced=true'
ARGO_NS="argocd"
started_dev_session=0

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
cleanup_workflow_builder_devspace_state() {
  kubectl delete deployment -n "$WL_NS" -l "$WORKFLOW_BUILDER_SELECTOR" --ignore-not-found --wait=true >/dev/null 2>&1 || true
  kubectl delete replicaset -n "$WL_NS" -l "$WORKFLOW_BUILDER_SELECTOR" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete pod -n "$WL_NS" -l "$WORKFLOW_BUILDER_SELECTOR" --ignore-not-found >/dev/null 2>&1 || true
  for _ in $(seq 1 15); do
    if ! kubectl get deployment -n "$WL_NS" -l "$WORKFLOW_BUILDER_SELECTOR" -o name 2>/dev/null | grep -q .; then
      break
    fi
    sleep 1
  done
  kubectl patch service "$WORKFLOW_BUILDER_SERVICE" \
    --namespace "$WL_NS" \
    --type=merge \
    -p='{"spec":{"selector":{"app":"workflow-builder","traffic":"prod","devspace.sh/replaced":"false"}}}' \
    >/dev/null 2>&1 || true
  kubectl scale deployment "$WORKFLOW_BUILDER_SERVICE" --namespace "$WL_NS" --replicas=1 >/dev/null 2>&1 || true
}

restore_workflow_builder_prod_state() {
  kubectl patch service "$WORKFLOW_BUILDER_SERVICE" \
    --namespace "$WL_NS" \
    --type=merge \
    -p='{"spec":{"selector":{"app":"workflow-builder","traffic":"prod","devspace.sh/replaced":"false"}}}' \
    >/dev/null 2>&1 || true
  kubectl scale deployment "$WORKFLOW_BUILDER_SERVICE" --namespace "$WL_NS" --replicas=1 >/dev/null 2>&1 || true
  cleanup_workflow_builder_devspace_state
  kubectl annotate application "$WORKFLOW_BUILDER_SERVICE" \
    --namespace "$ARGO_NS" \
    "argocd.argoproj.io/skip-reconcile-" >/dev/null 2>&1 || true
  kubectl annotate application "$WORKFLOW_BUILDER_SERVICE" \
    --namespace "$ARGO_NS" \
    "argocd.argoproj.io/refresh=hard" --overwrite >/dev/null 2>&1 || true
}

cleanup_on_exit() {
  if [[ "$started_dev_session" -eq 1 ]]; then
    printf '\n==> Restoring workflow-builder cluster state\n'
    restore_workflow_builder_prod_state
  fi
}

trap cleanup_on_exit EXIT INT TERM

if kubectl get deployment -n "$WL_NS" -l devspace.sh/replaced=true -o name 2>/dev/null | grep -q .; then
  selector_replaced="$(
    kubectl get service "$WORKFLOW_BUILDER_SERVICE" -n "$WL_NS" \
      -o jsonpath='{.spec.selector.devspace\.sh/replaced}' 2>/dev/null || true
  )"
  prod_replicas="$(
    kubectl get deployment "$WORKFLOW_BUILDER_SERVICE" -n "$WL_NS" \
      -o jsonpath='{.spec.replicas}' 2>/dev/null || true
  )"
  prod_replicas="${prod_replicas:-1}"

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

  # A valid active session must own traffic and have the prod deployment scaled down.
  if [[ "$selector_replaced" != "true" || "$prod_replicas" != "0" ]]; then
    stale_session=1
  fi

  if [[ "$stale_session" -eq 1 ]]; then
    printf '==> Found stale or partial DevSpace state. Cleaning it before starting a fresh session.\n'
    cleanup_workflow_builder_devspace_state
  else
    printf '==> DevSpace session already active. Attaching to the running dev container.\n'
    cd "$PROJECT_ROOT"
    exec devspace enter --profile "$profile"
  fi
fi

printf '==> Using kube context: %s\n' "$(kubectl config current-context 2>/dev/null || echo unknown)"
printf '==> Profile: %s\n' "$profile"

probe_tailscale_url() {
  local ingress_host url status attempt
  ingress_host="$(
    kubectl get ingress "$TAILSCALE_INGRESS_NAME" -n "$WL_NS" \
      -o jsonpath='{.spec.rules[0].host}' 2>/dev/null || true
  )"
  ingress_host="${ingress_host:-$TAILSCALE_HOST_FALLBACK}"
  url="https://${ingress_host}/"

  for attempt in $(seq 1 60); do
    status="$(
      curl -k -sS -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || true
    )"
    case "$status" in
      200|302|303|307|308)
        printf '==> Tailscale URL ready: %s (HTTP %s)\n' "$url" "$status"
        return 0
        ;;
      502|503|504)
        ;;
      *)
        ;;
    esac
    sleep 2
  done

  printf '==> Tailscale URL not ready yet: %s\n' "$url"
  return 0
}

cd "$PROJECT_ROOT"
probe_tailscale_url &
started_dev_session=1
devspace dev "${args[@]}"
