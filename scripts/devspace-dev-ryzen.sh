#!/usr/bin/env bash

set -euo pipefail

APP_NAMESPACE="argocd"
WORKLOAD_NAMESPACE="workflow-builder"
PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_RECONCILE_ANNOTATION="argocd.argoproj.io/skip-reconcile"
REFRESH_ANNOTATION="argocd.argoproj.io/refresh"
DEFAULT_DEVSPACE_PROFILE="openshell-inner-loop"

# Mapping: dev entry name → ArgoCD app name (only entries with ArgoCD apps)
declare -A DEV_TO_ARGO=(
  [app]="workflow-builder"
  [workflow-orchestrator]="workflow-orchestrator"
  [function-router]="function-router"
  [mcp-gateway]="mcp-gateway"
  [fn-system]="fn-system"
)

# Mapping: dev entry name → DevSpace replacement deployment name (for cleanup)
declare -A DEV_TO_REPLACEMENT=(
  [app]="workflow-builder-devspace"
  [workflow-orchestrator]="workflow-orchestrator-devspace"
  [function-router]="function-router-devspace"
  [durable-agent]="durable-agent-devspace"
  [fn-activepieces]="fn-activepieces-devspace"
  [fn-system]="fn-system-devspace"
  [mcp-gateway]="mcp-gateway-devspace"
  [ms-agent-workflow]="ms-agent-workflow-devspace"
  [dapr-agent-runtime]="dapr-agent-runtime-devspace"
  [ai-chatbot]="ai-chatbot-devspace"
)

# Mapping: dev entry name → production deployment name (for rollout status)
declare -A DEV_TO_PRODUCTION=(
  [app]="workflow-builder"
  [workflow-orchestrator]="workflow-orchestrator"
  [function-router]="function-router"
  [fn-activepieces]="fn-activepieces"
  [mcp-gateway]="mcp-gateway"
  [ms-agent-workflow]="ms-agent-workflow"
  [dapr-agent-runtime]="dapr-agent-runtime"
  [ai-chatbot]="ai-chatbot"
)

# Determine which dev entries are active for the selected profile.
# Parses devspace.yaml to find which entries the profile removes.
resolve_active_dev_entries() {
  local profile="$1"

  # All dev entry names defined in devspace.yaml
  local all_entries
  all_entries=$(cd "$PROJECT_ROOT" && grep -E '^\s{2}[a-z]' devspace.yaml | \
    sed -n '/^dev:/,/^[a-z]/{ /^  [a-z]/s/^\s*\([a-z][a-z0-9_-]*\):.*/\1/p }')

  if [[ -z "$all_entries" ]]; then
    # Fallback: hardcoded list of all dev entries
    all_entries="app ai-chatbot ms-agent-workflow dapr-agent-runtime workflow-orchestrator function-router durable-agent fn-activepieces fn-system mcp-gateway"
  fi

  # Find which entries the profile removes
  local removed_entries
  removed_entries=$(cd "$PROJECT_ROOT" && python3 -c "
import yaml, sys
with open('devspace.yaml') as f:
    cfg = yaml.safe_load(f)
for p in cfg.get('profiles', []):
    if p['name'] == '$profile':
        for patch in p.get('patches', []):
            if patch.get('op') == 'remove' and patch.get('path', '').startswith('dev.'):
                print(patch['path'].split('dev.', 1)[1])
        break
" 2>/dev/null || echo "")

  # Return entries not in the removed set
  for entry in $all_entries; do
    if ! echo "$removed_entries" | grep -qx "$entry"; then
      echo "$entry"
    fi
  done
}

ACTIVE_ENTRIES=()
ARGO_APPS=()
DEVSPACE_REPLACEMENT_DEPLOYMENTS=()
PRODUCTION_DEPLOYMENTS=()

populate_arrays() {
  local profile="$1"

  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    ACTIVE_ENTRIES+=("$entry")

    if [[ -n "${DEV_TO_ARGO[$entry]:-}" ]]; then
      # Only add if ArgoCD app exists
      if kubectl get application "${DEV_TO_ARGO[$entry]}" --namespace "$APP_NAMESPACE" >/dev/null 2>&1; then
        ARGO_APPS+=("${DEV_TO_ARGO[$entry]}")
      fi
    fi

    if [[ -n "${DEV_TO_REPLACEMENT[$entry]:-}" ]]; then
      DEVSPACE_REPLACEMENT_DEPLOYMENTS+=("${DEV_TO_REPLACEMENT[$entry]}")
    fi

    if [[ -n "${DEV_TO_PRODUCTION[$entry]:-}" ]]; then
      PRODUCTION_DEPLOYMENTS+=("${DEV_TO_PRODUCTION[$entry]}")
    fi
  done < <(resolve_active_dev_entries "$profile")
}

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

  # Determine profile
  local profile="$DEFAULT_DEVSPACE_PROFILE"
  for i in "${!devspace_args[@]}"; do
    if [[ "${devspace_args[$i]}" == "--profile" || "${devspace_args[$i]}" == "-p" ]]; then
      profile="${devspace_args[$((i + 1))]}"
      break
    fi
  done

  if [[ " ${devspace_args[*]} " != *" --profile "* ]] && [[ " ${devspace_args[*]} " != *" -p "* ]]; then
    devspace_args=(--profile "$profile" "${devspace_args[@]}")
  fi

  populate_arrays "$profile"

  trap 'cleanup "$?"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  printf '==> Using kube context: %s\n' "$(kubectl config current-context 2>/dev/null || echo unknown)"
  printf '==> Profile: %s\n' "$profile"
  printf '==> Active dev entries: %s\n' "${ACTIVE_ENTRIES[*]}"

  for app in "${ARGO_APPS[@]}"; do
    printf '==> Pausing ArgoCD reconciliation for %s\n' "$app"
    kubectl annotate application "$app" \
      --namespace "$APP_NAMESPACE" \
      "${SKIP_RECONCILE_ANNOTATION}=true" \
      --overwrite >/dev/null
  done

  printf '==> Starting DevSpace session\n'
  cd "$PROJECT_ROOT"
  devspace dev "${devspace_args[@]}"
}

main "$@"
