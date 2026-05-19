#!/usr/bin/env bash
#
# Thin wrapper around `devspace dev` that:
#   1. Injects the default profile (openshell-inner-loop) if none specified
#   2. Guards against duplicate DevSpace sessions
#   3. Pins namespace/context and noninteractive variable defaults
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
render_mode=0
filtered_args=()
for i in "${!args[@]}"; do
  case "${args[$i]}" in
    --render)
      render_mode=1
      ;;
    --profile|-p)
      profile="${args[$((i + 1))]:-$DEFAULT_PROFILE}"
      filtered_args+=("${args[$i]}")
      ;;
    --profile=*)
      profile="${args[$i]#--profile=}"
      filtered_args+=("${args[$i]}")
      ;;
    *)
      filtered_args+=("${args[$i]}")
      ;;
  esac
done
args=("${filtered_args[@]}")
if [[ " ${args[*]} " != *" --profile "* ]] && [[ " ${args[*]} " != *" -p "* ]] && [[ " ${args[*]} " != *" --profile="* ]]; then
  args=(--profile "$profile" "${args[@]}")
fi

kube_context="$(kubectl config current-context 2>/dev/null || true)"

has_flag_with_value() {
  local flag="$1"
  for i in "${!args[@]}"; do
    if [[ "${args[$i]}" == "$flag" || "${args[$i]}" == "$flag="* ]]; then
      return 0
    fi
  done
  return 1
}

has_var() {
  local name="$1"
  for i in "${!args[@]}"; do
    if [[ "${args[$i]}" == "--var" && "${args[$((i + 1))]:-}" == "${name}="* ]]; then
      return 0
    fi
    if [[ "${args[$i]}" == "--var=${name}="* ]]; then
      return 0
    fi
  done
  return 1
}

append_var_if_missing() {
  local name="$1"
  local value="$2"
  if ! has_var "$name"; then
    args+=(--var "${name}=${value}")
  fi
}

if ! has_flag_with_value "--namespace" && [[ " ${args[*]} " != *" -n "* ]]; then
  args+=(--namespace "$WL_NS")
fi
if [[ -n "$kube_context" ]] && ! has_flag_with_value "--kube-context"; then
  args+=(--kube-context "$kube_context")
fi

devspace_image_registry="gitea.cnoe.localtest.me:9443/giteaadmin"
node_dev_image_repository="${devspace_image_registry}/nodejs-22-devspace"
python_dev_image_repository="${devspace_image_registry}/python-312-devspace"
current_evaluator_image="$(
  kubectl get deployment swebench-coordinator -n "$WL_NS" \
    -o jsonpath='{range .spec.template.spec.containers[0].env[?(@.name=="SWEBENCH_EVALUATOR_IMAGE")]}{.value}{end}' \
    2>/dev/null || true
)"
current_evaluator_image="${current_evaluator_image:-${devspace_image_registry}/swebench-evaluator:latest}"

append_var_if_missing "APP_NAME" "workflow-builder"
append_var_if_missing "APP_PUBLIC_URL" "https://${TAILSCALE_HOST_FALLBACK}"
append_var_if_missing "GITEA_HOST" "gitea.cnoe.localtest.me"
append_var_if_missing "GITEA_USER" "giteaadmin"
append_var_if_missing "DEVSPACE_IMAGE_REGISTRY" "$devspace_image_registry"
append_var_if_missing "RUN_MIGRATIONS" "false"
append_var_if_missing "OPENSHELL_AGENT_RUNTIME_API_BASE_URL" "http://openshell-agent-runtime.openshell.svc.cluster.local:8083"
append_var_if_missing "SWEBENCH_EVALUATOR_IMAGE" "$current_evaluator_image"
append_var_if_missing "DEV_IMAGE_REPOSITORY" "$node_dev_image_repository"
append_var_if_missing "WORKFLOW_BUILDER_DEV_IMAGE" "${node_dev_image_repository}:latest"
append_var_if_missing "AI_CHATBOT_DEV_IMAGE_REPOSITORY" "$node_dev_image_repository"
append_var_if_missing "FN_ACTIVEPIECES_DEV_IMAGE_REPOSITORY" "$node_dev_image_repository"
append_var_if_missing "FN_SYSTEM_DEV_IMAGE_REPOSITORY" "$node_dev_image_repository"
append_var_if_missing "FUNCTION_ROUTER_DEV_IMAGE_REPOSITORY" "$node_dev_image_repository"
append_var_if_missing "MCP_GATEWAY_DEV_IMAGE_REPOSITORY" "$node_dev_image_repository"
append_var_if_missing "ORCHESTRATOR_DEV_IMAGE_REPOSITORY" "$python_dev_image_repository"
append_var_if_missing "SWEBENCH_COORDINATOR_DEV_IMAGE_REPOSITORY" "$python_dev_image_repository"
append_var_if_missing "DAPR_AGENT_PY_DEV_IMAGE_REPOSITORY" "$python_dev_image_repository"
append_var_if_missing "SWEBENCH_EVALUATOR_DEV_IMAGE" "${devspace_image_registry}/swebench-evaluator:devspace"

selected_deployments_for_profile() {
  case "$profile" in
    workflow-ui-only)
      printf '%s\n' "workflow-builder"
      ;;
    ui-orchestrator)
      printf '%s\n' "workflow-builder workflow-orchestrator"
      ;;
    ai-chatbot-dev)
      printf '%s\n' "workflow-builder ai-chatbot workflow-orchestrator function-router"
      ;;
    function-stack)
      printf '%s\n' "workflow-builder workflow-orchestrator function-router fn-activepieces"
      ;;
    sw-workflow-dev|openshell-inner-loop)
      printf '%s\n' "workflow-builder workflow-orchestrator function-router"
      ;;
    swebench-dev)
      printf '%s\n' "workflow-builder workflow-orchestrator function-router swebench-coordinator"
      ;;
    swebench-dev-with-dapr-agent-py)
      printf '%s\n' "workflow-builder workflow-orchestrator function-router swebench-coordinator dapr-agent-py"
      ;;
    full-agent-stack)
      printf '%s\n' "workflow-builder ai-chatbot workflow-orchestrator function-router fn-activepieces mcp-gateway swebench-coordinator dapr-agent-py"
      ;;
    *)
      printf '%s\n' "workflow-builder"
      ;;
  esac
}

selected_deployments="$(selected_deployments_for_profile)"
append_var_if_missing "ARGO_APPS" "$selected_deployments"
append_var_if_missing "PRODUCTION_DEPLOYMENTS" "$selected_deployments"

kubectl_current_context_args=()
if [[ -n "$kube_context" ]]; then
  kubectl_current_context_args=(--context "$kube_context")
fi

preflight_selected_deployments() {
  local deployments missing dep ready desired
  deployments="$(selected_deployments_for_profile)"
  missing=""
  printf '==> Preflight: selected production deployments: %s\n' "$deployments"
  for dep in $deployments; do
    if kubectl "${kubectl_current_context_args[@]}" get deployment "$dep" --namespace "$WL_NS" >/dev/null 2>&1; then
      ready="$(kubectl "${kubectl_current_context_args[@]}" get deployment "$dep" --namespace "$WL_NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)"
      desired="$(kubectl "${kubectl_current_context_args[@]}" get deployment "$dep" --namespace "$WL_NS" -o jsonpath='{.spec.replicas}' 2>/dev/null || true)"
      printf '    found deployment/%s (%s/%s ready)\n' "$dep" "${ready:-0}" "${desired:-0}"
    else
      missing="${missing} ${dep}"
    fi
  done
  if [[ -n "$missing" ]]; then
    printf 'Missing required deployment(s):%s\n' "$missing" >&2
    printf 'No DevSpace session was started.\n' >&2
    exit 1
  fi
}

if [[ "$render_mode" -eq 1 ]]; then
  cd "$PROJECT_ROOT"
  exec devspace print "${args[@]}" --skip-info
fi

# Guard: if replacement deployments already exist, session is running
cleanup_workflow_builder_devspace_state() {
  local app
  for app in $selected_deployments; do
    kubectl delete deployment -n "$WL_NS" -l "app=${app},devspace.sh/replaced=true" --ignore-not-found --wait=true >/dev/null 2>&1 || true
    kubectl delete replicaset -n "$WL_NS" -l "app=${app},devspace.sh/replaced=true" --ignore-not-found >/dev/null 2>&1 || true
    kubectl delete pod -n "$WL_NS" -l "app=${app},devspace.sh/replaced=true" --ignore-not-found >/dev/null 2>&1 || true
  done
  for _ in $(seq 1 15); do
    if ! kubectl get deployment -n "$WL_NS" -l devspace.sh/replaced=true -o name 2>/dev/null | grep -q .; then
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
  local app
  kubectl patch service "$WORKFLOW_BUILDER_SERVICE" \
    --namespace "$WL_NS" \
    --type=merge \
    -p='{"spec":{"selector":{"app":"workflow-builder","traffic":"prod","devspace.sh/replaced":"false"}}}' \
    >/dev/null 2>&1 || true
  for app in $selected_deployments; do
    kubectl scale deployment "$app" --namespace "$WL_NS" --replicas=1 >/dev/null 2>&1 || true
    kubectl annotate deployment "$app" \
      --namespace "$WL_NS" \
      "devspace.sh/original-replicas-" \
      "devspace.sh/original-workflow-builder-replicas-" >/dev/null 2>&1 || true
  done
  cleanup_workflow_builder_devspace_state
  for app in $selected_deployments; do
    kubectl annotate application "$app" \
      --namespace "$ARGO_NS" \
      "argocd.argoproj.io/skip-reconcile-" >/dev/null 2>&1 || true
    kubectl annotate application "$app" \
      --namespace "$ARGO_NS" \
      "argocd.argoproj.io/refresh=hard" --overwrite >/dev/null 2>&1 || true
  done
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
    enter_args=(--profile "$profile" --namespace "$WL_NS")
    if [[ -n "$kube_context" ]]; then
      enter_args+=(--kube-context "$kube_context")
    fi
    exec devspace enter "${enter_args[@]}"
  fi
fi

printf '==> Using kube context: %s\n' "${kube_context:-unknown}"
printf '==> Profile: %s\n' "$profile"
preflight_selected_deployments

probe_tailscale_url() {
  local ingress_host url status attempt
  ingress_host="$(
    kubectl get ingress "$TAILSCALE_INGRESS_NAME" -n "$WL_NS" \
      -o jsonpath='{.spec.rules[0].host}' 2>/dev/null || true
  )"
  ingress_host="${ingress_host:-$TAILSCALE_HOST_FALLBACK}"
  if [[ "$ingress_host" != *.* ]]; then
    ingress_host="$TAILSCALE_HOST_FALLBACK"
  fi
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
