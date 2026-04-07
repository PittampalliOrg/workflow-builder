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
  selector_replaced="$(
    kubectl get service "$WORKFLOW_BUILDER_SERVICE" -n "$WL_NS" \
      -o jsonpath='{.spec.selector.devspace\.sh/replaced}' 2>/dev/null || true
  )"
  if [[ "$selector_replaced" != "true" ]]; then
    printf '==> Repairing workflow-builder service selector to target the active DevSpace pod.\n'
    kubectl patch service "$WORKFLOW_BUILDER_SERVICE" \
      --namespace "$WL_NS" \
      --type=json \
      -p='[{"op":"replace","path":"/spec/selector/devspace.sh~1replaced","value":"true"}]' \
      >/dev/null 2>&1 || true
  fi

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
exec devspace dev "${args[@]}"
