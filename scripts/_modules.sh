# shellcheck shell=bash
# Shared module metadata for the Skaffold dev/outer loop.
#
# SOURCE this file (do not execute it). It is idempotent — re-sourcing is a
# no-op. Source it cwd-independently from any wrapper:
#
#   . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_modules.sh"
#
# Consumers: scripts/skaffold-dev.sh, scripts/skaffold-status.sh,
# scripts/skaffold-doctor.sh, skaffold/hooks/commit-pin.sh.
[ -n "${_MODULES_SH_LOADED:-}" ] && return 0
_MODULES_SH_LOADED=1

# Skaffold module set — kept in sync with skaffold.yaml's `requires:` list.
#
# fn-activepieces remains wired in Skaffold for recovery/parity work, but the
# current ryzen cluster does not expose it as a regular Argo Application and
# Deployment. Keep it out of normal "all" sessions until that app path is live
# again; set SKAFFOLD_ALLOW_INACTIVE=1 to opt into it deliberately.
ACTIVE_MODULES=(workflow-builder workflow-orchestrator function-router mcp-gateway swebench-coordinator)
INACTIVE_MODULES=(fn-activepieces)
ALL_MODULES=("${ACTIVE_MODULES[@]}" "${INACTIVE_MODULES[@]}")

# Services whose packages/components/workloads/<svc>/manifests/kustomization.yaml
# image pin is OWNED by the Skaffold outer-loop commit-pin on GitHub `main`
# (single-writer invariant: the gitea Tekton dev-pin task
# `update-ryzen-dev-image-tag` that used to also write these was retired). Every
# other ryzen workload's base pin is written by the hub outer-loop
# `update-stacks-image` task — NOT by commit-pin. Narrow this to
# `(workflow-builder)` to hand the other four back to Tekton. Override at
# runtime via SKAFFOLD_OWNED_SERVICES="a b c".
SKAFFOLD_OWNED_DEFAULT=(workflow-builder workflow-orchestrator function-router mcp-gateway swebench-coordinator)

# module → ryzen ArgoCD Application name. ryzen's autonomous-agent `root-ryzen`
# app-of-apps names its child Applications `ryzen-<module>` (in the `argocd` ns),
# while the workload Deployment keeps the bare `<module>` name (in the
# `workflow-builder` ns). Argo operations (pause/resume/status/doctor) use this
# map; Deployment lookups use the bare module name.
declare -gA MODULE_TO_APP=(
  [workflow-builder]=ryzen-workflow-builder
  [workflow-orchestrator]=ryzen-workflow-orchestrator
  [function-router]=ryzen-function-router
  [mcp-gateway]=ryzen-mcp-gateway
  [swebench-coordinator]=ryzen-swebench-coordinator
  [fn-activepieces]=ryzen-fn-activepieces
)

# module → "<localPort>:<containerPort>" for the dev-loop port-forward banner.
# Authoritative source is each skaffold/<module>.skaffold.yaml `portForward`
# stanza; this mirror only exists to print an upfront table without parsing
# yaml. Keep in sync with CLAUDE.md's "Dev Loop" module table.
declare -gA MODULE_PORTS=(
  [workflow-builder]="3002:3000"
  [workflow-orchestrator]="3013:8080"
  [function-router]="3014:8080"
  [mcp-gateway]="3018:8080"
  [swebench-coordinator]="3019:8080"
  [fn-activepieces]="3016:8080"
)
