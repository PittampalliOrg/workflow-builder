#!/usr/bin/env bash
# Wrapper for `skaffold dev` that pauses + resumes ArgoCD for the target apps.
#
# Why a wrapper instead of Skaffold lifecycle hooks: Skaffold's deploy.hooks
# fire per-deploy-cycle (one pause per file save), and there is no first-class
# "cleanup on Ctrl-C" event we can rely on across versions. A shell `trap` is
# version-agnostic and matches the devspace-dev-ryzen.sh pattern.
#
# Usage:
#   bash scripts/skaffold-dev.sh                          # default: workflow-builder
#   bash scripts/skaffold-dev.sh workflow-builder         # explicit
#   bash scripts/skaffold-dev.sh workflow-builder workflow-orchestrator
#
# Recovery if `kill -9` skips the trap:
#   ARGO_APPS="<apps>" bash skaffold/hooks/argo-resume.sh

set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"

# Module sets (ACTIVE_MODULES / INACTIVE_MODULES / ALL_MODULES), the
# Skaffold-owned pin set, and per-module ports live in the shared library.
# shellcheck source=scripts/_modules.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_modules.sh"

contains_module() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    if [ "${item}" = "${needle}" ]; then
      return 0
    fi
  done
  return 1
}

modules=("$@")
if [ "${#modules[@]}" -eq 0 ]; then
  modules=(workflow-builder)
elif [ "${modules[0]}" = "ALL" ] || [ "${modules[0]}" = "all" ]; then
  modules=("${ACTIVE_MODULES[@]}")
fi

for mod in "${modules[@]}"; do
  if ! contains_module "${mod}" "${ALL_MODULES[@]}"; then
    echo "skaffold-dev: unknown module '${mod}'" >&2
    echo "skaffold-dev: active modules: ${ACTIVE_MODULES[*]}" >&2
    echo "skaffold-dev: inactive modules: ${INACTIVE_MODULES[*]}" >&2
    exit 64
  fi
  if contains_module "${mod}" "${INACTIVE_MODULES[@]}" && [ "${SKAFFOLD_ALLOW_INACTIVE:-0}" != "1" ]; then
    echo "skaffold-dev: '${mod}' is configured but currently inactive on ryzen" >&2
    echo "skaffold-dev: set SKAFFOLD_ALLOW_INACTIVE=1 to run it deliberately" >&2
    exit 65
  fi
done

# Argo apps default to the same names as the skaffold module list (matches our
# convention: one module = one Argo app). Override via $ARGO_APPS.
if [ -z "${ARGO_APPS:-}" ]; then
  ARGO_APPS="${modules[*]}"
fi
export ARGO_APPS

ns="${ARGO_NS:-argocd}"
export ARGO_NS="${ns}"

# Default image registry: ryzen pulls dev images from GHCR via the
# authenticated ghcr.io/hosts.toml containerd mirror (+ Spegel P2P). Without
# this, Skaffold prepends docker.io/library/ to bare artifact names (e.g.
# `workflow-builder-dev`) and the push to Docker Hub fails. The host running
# `skaffold dev` needs GHCR push creds (`docker login ghcr.io`). Override via
# env var for other clusters / mirrors.
if [ -z "${SKAFFOLD_DEFAULT_REPO:-}" ]; then
  SKAFFOLD_DEFAULT_REPO="ghcr.io/pittampalliorg"
fi
export SKAFFOLD_DEFAULT_REPO

resumed=0
resume_argo() {
  if [ "${resumed}" -ne 0 ]; then
    return 0
  fi
  resumed=1
  printf '\n==> Resuming ArgoCD for: %s\n' "${ARGO_APPS}"
  bash skaffold/hooks/argo-resume.sh ${ARGO_APPS} || true
}

print_resume_summary() {
  printf '\n  Post-session ArgoCD summary:\n'
  printf '       %-22s %-8s %-8s %-8s %s\n' APP SKIP SYNC HEALTH LIVE
  local app skip sync health live argo_raw rest
  for app in ${ARGO_APPS}; do
    argo_raw=$(kubectl get application "${app}" -n "${ns}" \
      -o jsonpath='{.metadata.annotations.argocd\.argoproj\.io/skip-reconcile}{"|"}{.status.sync.status}{"|"}{.status.health.status}' \
      2>/dev/null || echo "|missing|")
    skip="${argo_raw%%|*}"
    rest="${argo_raw#*|}"
    sync="${rest%%|*}"
    health="${rest##*|}"
    live=$(kubectl -n "${NAMESPACE:-workflow-builder}" get deploy "${app}" \
      -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "no-deployment")
    printf '       %-22s %-8s %-8s %-8s %s\n' \
      "${app}" "${skip:-false}" "${sync:-unknown}" "${health:-unknown}" "${live}"
  done
}

# EXIT fires on normal exit, INT/TERM, and `set -e` errors. INT/TERM go
# through the shell's default handler which exits — which fires EXIT, which
# calls resume_argo once (guarded by `resumed` flag).
trap 'status=$?; resume_argo; exit ${status}' EXIT

# --- Stale-pause detector ---------------------------------------------------
# Surface (don't block) apps that are already paused, almost always the
# fingerprint of a prior `skaffold dev` session that was kill -9'd or that
# crashed before its EXIT trap could fire. The pause itself is idempotent and
# the EXIT trap will resume on clean Ctrl-C, so we don't prompt — but we do
# want to make this visible at session start so it stops being a silent hours-
# long Argo outage.
already_paused=()
for app in ${ARGO_APPS}; do
  cur=$(kubectl get application "${app}" -n "${ns}" \
    -o jsonpath='{.metadata.annotations.argocd\.argoproj\.io/skip-reconcile}' \
    2>/dev/null || true)
  if [ "${cur}" = "true" ]; then
    already_paused+=("${app}")
  fi
done

if [ ${#already_paused[@]} -gt 0 ]; then
  workload_ns="${NAMESPACE:-workflow-builder}"
  printf '\n  ⚠  Already paused (prior skaffold-dev session likely didn'\''t clean up):\n'
  for app in "${already_paused[@]}"; do
    img=$(kubectl -n "${workload_ns}" get deploy "${app}" \
      -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo unknown)
    printf '       %-22s live=%s\n' "${app}" "${img}"
  done
  printf '       Continuing — pause is idempotent, and this trap will resume on Ctrl-C.\n'
  printf '       If you do NOT want to take over this pause, Ctrl-C now and run:\n'
  printf '         ARGO_APPS="%s" bash skaffold/hooks/argo-resume.sh\n\n' "${already_paused[*]}"
fi

printf '==> Pausing ArgoCD for: %s\n' "${ARGO_APPS}"
bash skaffold/hooks/argo-pause.sh ${ARGO_APPS}

# --- Port-forward banner ----------------------------------------------------
# Upfront table of where each module's BFF/API lands, so the developer doesn't
# scroll Skaffold's verbose log to find it. Ports come from the shared
# MODULE_PORTS map (authoritative source: each skaffold/<module>.skaffold.yaml
# `portForward` stanza). No yaml parsing — just a lookup.
printf '\n  Port forwards (active during this session):\n'
printf '       %-22s %-10s %-10s %s\n' MODULE LOCAL CONTAINER URL
for mod in "${modules[@]}"; do
  pair="${MODULE_PORTS[${mod}]:-}"
  [ -n "${pair}" ] || continue
  local_port="${pair%%:*}"
  cont_port="${pair##*:}"
  printf '       %-22s %-10s %-10s http://localhost:%s\n' \
    "${mod}" "${local_port}" "${cont_port}" "${local_port}"
done
printf '\n'

# Comma-separated for `skaffold -m`.
mod_csv="$(IFS=,; echo "${modules[*]}")"

# Split SKAFFOLD_DEV_EXTRA_ARGS on whitespace into an array. An empty/unset
# var must NOT become an empty positional arg — skaffold parses that as an
# unknown subcommand.
extra_args=()
if [ -n "${SKAFFOLD_DEV_EXTRA_ARGS:-}" ]; then
  # shellcheck disable=SC2206  # intentional word-split
  extra_args=(${SKAFFOLD_DEV_EXTRA_ARGS})
fi

# --cleanup=false: don't `kubectl delete deployment workflow-builder` on exit.
# Without this, Skaffold deletes the dev Deployment on Ctrl-C, and there's a
# 10-60s window with no workflow-builder until Argo's selfHeal reconciles.
# With cleanup off, the dev Deployment stays put; Argo's `refresh=hard`
# annotation (set by argo-resume.sh) makes Argo swap the image back to the
# prod tag in-place.
printf '==> skaffold dev -m %s --cleanup=false %s\n' "${mod_csv}" "${SKAFFOLD_DEV_EXTRA_ARGS:-}"
# Don't `exec` — that replaces the bash process and skips the EXIT trap.
set +e
skaffold dev -m "${mod_csv}" --cleanup=false "${extra_args[@]}"
skaffold_status=$?
set -e

trap - EXIT
resume_argo
print_resume_summary
exit "${skaffold_status}"
