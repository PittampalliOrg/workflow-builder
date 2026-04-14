#!/usr/bin/env bash
#
# Inner-loop development using Kubernetes Agent Sandbox.
#
# Replaces the production workflow-builder pod with a Sandbox dev pod that
# mounts the local source tree via hostPath for zero-latency HMR.
#
# Usage:
#   bash scripts/sandbox-dev.sh                  # Start dev sandbox
#   bash scripts/sandbox-dev.sh --suspend        # Suspend (scale to 0, keep PVCs)
#   bash scripts/sandbox-dev.sh --resume         # Resume suspended sandbox
#   bash scripts/sandbox-dev.sh --status         # Show sandbox status
#
# Prerequisites:
#   - Kind cluster with extraMounts for /mnt/dev-sources/workflow-builder
#   - Agent Sandbox Controller deployed with --extensions
#   - SandboxTemplate 'workflow-builder-dev' in workflow-builder namespace
#   - PVCs wb-dev-node-modules and wb-dev-pnpm-store created

set -euo pipefail

WL_NS="workflow-builder"
ARGO_NS="argocd"
CLAIM_NAME="wb-dev"
SANDBOX_TEMPLATE="workflow-builder-dev"
SERVICE_NAME="workflow-builder"
LOCAL_PORT="3002"
CONTAINER_PORT="3000"
SKIP_ANNOTATION="argocd.argoproj.io/skip-reconcile"

# ── Helpers ──

pause_argocd() {
  local app="$1"
  if kubectl get application "$app" --namespace "$ARGO_NS" >/dev/null 2>&1; then
    echo "==> Pausing ArgoCD reconciliation for $app"
    kubectl patch application "$app" \
      --namespace "$ARGO_NS" \
      --type=json \
      -p='[{"op":"remove","path":"/spec/syncPolicy/automated"}]' \
      >/dev/null 2>&1 || true
    kubectl annotate application "$app" \
      --namespace "$ARGO_NS" \
      "${SKIP_ANNOTATION}=true" \
      --overwrite >/dev/null 2>&1 || true
  fi
}

resume_argocd() {
  local app="$1"
  kubectl patch application "$app" \
    --namespace "$ARGO_NS" \
    --type=merge \
    -p='{"spec":{"syncPolicy":{"automated":{"prune":true,"selfHeal":true}}}}' \
    >/dev/null 2>&1 || true
  kubectl annotate application "$app" \
    --namespace "$ARGO_NS" \
    "${SKIP_ANNOTATION}-" >/dev/null 2>&1 || true
  kubectl annotate application "$app" \
    --namespace "$ARGO_NS" \
    "argocd.argoproj.io/refresh=hard" \
    --overwrite >/dev/null 2>&1 || true
}

route_service_to_sandbox() {
  kubectl patch service "$SERVICE_NAME" \
    --namespace "$WL_NS" \
    --type=merge \
    -p='{"spec":{"selector":{"app":"workflow-builder","dev.sandbox/active":"true"}}}' \
    >/dev/null 2>&1 || true
}

restore_service_to_prod() {
  kubectl patch service "$SERVICE_NAME" \
    --namespace "$WL_NS" \
    --type=merge \
    -p='{"spec":{"selector":{"app":"workflow-builder","traffic":"prod","devspace.sh/replaced":"false"}}}' \
    >/dev/null 2>&1 || true
}

get_sandbox_name() {
  # The SandboxClaim controller creates a Sandbox owned by the claim.
  # Find it by owner reference.
  kubectl get sandbox -n "$WL_NS" \
    -o jsonpath='{.items[?(@.metadata.ownerReferences[*].name=="'"$CLAIM_NAME"'")].metadata.name}' \
    2>/dev/null || true
}

create_sandbox_claim() {
  cat <<CLAIM_EOF | kubectl apply -f -
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxClaim
metadata:
  name: ${CLAIM_NAME}
  namespace: ${WL_NS}
spec:
  sandboxTemplateRef:
    name: ${SANDBOX_TEMPLATE}
  lifecycle:
    shutdownPolicy: Retain
CLAIM_EOF
}

wait_for_sandbox_ready() {
  echo "==> Waiting for sandbox pod to become ready..."
  local attempts=0
  while [ $attempts -lt 120 ]; do
    # Check for a running pod with our label
    local ready
    ready="$(kubectl get pods -n "$WL_NS" -l "dev.sandbox/active=true" \
      -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
    if [ "$ready" = "True" ]; then
      echo "==> Sandbox pod is ready"
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 2
  done
  echo "==> Warning: sandbox not ready after 240s, continuing anyway"
}

get_sandbox_pod() {
  kubectl get pods -n "$WL_NS" -l "dev.sandbox/active=true" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true
}

cleanup() {
  echo ""
  echo "==> Restoring production state..."
  restore_service_to_prod
  kubectl delete sandboxclaim "$CLAIM_NAME" -n "$WL_NS" --ignore-not-found >/dev/null 2>&1 || true
  # Also clean up any sandbox left behind
  local sandbox_name
  sandbox_name="$(get_sandbox_name)"
  if [ -n "$sandbox_name" ]; then
    kubectl delete sandbox "$sandbox_name" -n "$WL_NS" --ignore-not-found >/dev/null 2>&1 || true
  fi
  kubectl scale deployment "$SERVICE_NAME" --namespace "$WL_NS" --replicas=1 >/dev/null 2>&1 || true
  resume_argocd "$SERVICE_NAME"
  echo "==> Waiting for production deployment to recover..."
  kubectl rollout status deployment/"$SERVICE_NAME" --namespace "$WL_NS" --timeout=180s >/dev/null 2>&1 || true
  echo "==> Production restored"
}

# ── Commands ──

cmd_status() {
  echo "=== SandboxClaim ==="
  kubectl get sandboxclaim "$CLAIM_NAME" -n "$WL_NS" -o wide 2>/dev/null || echo "No claim found"
  echo ""
  echo "=== Sandbox ==="
  local sandbox_name
  sandbox_name="$(get_sandbox_name)"
  if [ -n "$sandbox_name" ]; then
    kubectl get sandbox "$sandbox_name" -n "$WL_NS" -o wide 2>/dev/null
  else
    echo "No sandbox found"
  fi
  echo ""
  echo "=== Pod ==="
  kubectl get pods -n "$WL_NS" -l "dev.sandbox/active=true" -o wide 2>/dev/null || echo "No sandbox pod"
  echo ""
  echo "=== Prod Deployment ==="
  kubectl get deployment "$SERVICE_NAME" -n "$WL_NS" -o custom-columns='REPLICAS:.spec.replicas,READY:.status.readyReplicas' 2>/dev/null
}

cmd_suspend() {
  local sandbox_name
  sandbox_name="$(get_sandbox_name)"
  if [ -z "$sandbox_name" ]; then
    echo "No sandbox to suspend"
    return 1
  fi
  echo "==> Suspending sandbox '$sandbox_name' (PVCs preserved)..."
  kubectl patch sandbox "$sandbox_name" -n "$WL_NS" --type=merge -p='{"spec":{"replicas":0}}'
  echo "==> Sandbox suspended. Run 'sandbox-dev.sh --resume' to bring it back."
}

cmd_resume() {
  local sandbox_name
  sandbox_name="$(get_sandbox_name)"
  if [ -z "$sandbox_name" ]; then
    echo "No sandbox to resume. Run 'sandbox-dev.sh' to create one."
    return 1
  fi
  echo "==> Resuming sandbox '$sandbox_name'..."
  kubectl patch sandbox "$sandbox_name" -n "$WL_NS" --type=merge -p='{"spec":{"replicas":1}}'
  wait_for_sandbox_ready
  local pod
  pod="$(get_sandbox_pod)"
  echo "==> Sandbox resumed. Starting port forward..."
  exec kubectl port-forward -n "$WL_NS" "pod/${pod}" "${LOCAL_PORT}:${CONTAINER_PORT}"
}

cmd_dev() {
  # Guard: check for existing claim
  if kubectl get sandboxclaim "$CLAIM_NAME" -n "$WL_NS" >/dev/null 2>&1; then
    local sandbox_name
    sandbox_name="$(get_sandbox_name)"
    if [ -n "$sandbox_name" ]; then
      local replicas
      replicas="$(kubectl get sandbox "$sandbox_name" -n "$WL_NS" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0)"
      if [ "$replicas" = "0" ]; then
        echo "==> Found suspended sandbox. Resuming..."
        cmd_resume
        return
      fi
    fi
    local pod
    pod="$(get_sandbox_pod)"
    if [ -n "$pod" ]; then
      echo "==> Sandbox already running. Attaching port forward..."
      echo "    (Use Ctrl+C to stop port forwarding. Run with --suspend to pause.)"
      route_service_to_sandbox
      exec kubectl port-forward -n "$WL_NS" "pod/${pod}" "${LOCAL_PORT}:${CONTAINER_PORT}"
    fi
  fi

  echo "==> Using kube context: $(kubectl config current-context 2>/dev/null || echo unknown)"

  trap cleanup EXIT INT TERM

  # Step 1: Pause ArgoCD
  pause_argocd "$SERVICE_NAME"
  sleep 2

  # Step 2: Scale prod to 0
  echo "==> Scaling down production deployment"
  kubectl scale deployment "$SERVICE_NAME" --namespace "$WL_NS" --replicas=0 >/dev/null 2>&1 || true

  # Step 3: Create sandbox claim
  echo "==> Creating dev sandbox from template '$SANDBOX_TEMPLATE'"
  create_sandbox_claim

  # Step 4: Route service to sandbox
  echo "==> Routing service to sandbox pod"
  route_service_to_sandbox

  # Step 5: Wait for ready
  wait_for_sandbox_ready

  # Step 6: Port forward
  local pod
  pod="$(get_sandbox_pod)"
  echo "==> Dev session active. Port forwarding ${LOCAL_PORT} -> ${CONTAINER_PORT}"
  echo "    Local:     http://localhost:${LOCAL_PORT}"
  echo "    Tailscale: https://workflow-builder-ryzen.tail286401.ts.net"
  echo "    Press Ctrl+C to restore production."
  echo ""

  kubectl port-forward -n "$WL_NS" "pod/${pod}" "${LOCAL_PORT}:${CONTAINER_PORT}"
}

# ── Main ──

case "${1:-}" in
  --status)  cmd_status ;;
  --suspend) cmd_suspend ;;
  --resume)  cmd_resume ;;
  *)         cmd_dev ;;
esac
