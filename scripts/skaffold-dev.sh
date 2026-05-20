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

# Known module set — kept in sync with skaffold.yaml's `requires:` list.
ALL_MODULES=(workflow-builder workflow-orchestrator function-router fn-activepieces mcp-gateway swebench-coordinator)

modules=("$@")
if [ "${#modules[@]}" -eq 0 ]; then
  modules=(workflow-builder)
elif [ "${modules[0]}" = "ALL" ] || [ "${modules[0]}" = "all" ]; then
  modules=("${ALL_MODULES[@]}")
fi

# Argo apps default to the same names as the skaffold module list (matches our
# convention: one module = one Argo app). Override via $ARGO_APPS.
if [ -z "${ARGO_APPS:-}" ]; then
  ARGO_APPS="${modules[*]}"
fi
export ARGO_APPS

ns="${ARGO_NS:-argocd}"
export ARGO_NS="${ns}"

# Default image registry: kind-on-ryzen pulls dev images from gitea-ryzen.
# Without this, Skaffold prepends docker.io/library/ to bare artifact names
# (e.g. `workflow-builder-dev`) and the push to Docker Hub fails. Same
# registry path devspace.yaml uses (DEVSPACE_IMAGE_REGISTRY).
# Override via env var for other clusters / mirrors.
if [ -z "${SKAFFOLD_DEFAULT_REPO:-}" ]; then
  SKAFFOLD_DEFAULT_REPO="gitea-ryzen.tail286401.ts.net/giteaadmin"
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

# EXIT fires on normal exit, INT/TERM, and `set -e` errors. INT/TERM go
# through the shell's default handler which exits — which fires EXIT, which
# calls resume_argo once (guarded by `resumed` flag).
trap resume_argo EXIT

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
# Parse each module's portForward.{port,localPort} so we can show a single
# upfront table — saves the developer from scrolling Skaffold's verbose log
# to find "where did the BFF land". Parser is regex-only on purpose: avoids
# a yaml dependency, and our modules only ever have one portForward entry.
printf '\n  Port forwards (active during this session):\n'
printf '       %-22s %-10s %-10s %s\n' MODULE LOCAL CONTAINER URL
for mod in "${modules[@]}"; do
  yaml="skaffold/${mod}.skaffold.yaml"
  [ -f "${yaml}" ] || continue
  parsed=$(python3 -c '
import sys, re
text = open(sys.argv[1]).read()
m = re.search(r"(?m)^portForward:\s*\n((?:[ \t]+.*\n?)+)", text)
if not m:
    sys.exit(0)
block = m.group(1)
local = re.search(r"(?m)^\s+localPort:\s*(\d+)", block)
port  = re.search(r"(?m)^\s+port:\s*(\d+)",      block)
if local and port:
    print(local.group(1), port.group(1))
' "${yaml}" 2>/dev/null || true)
  if [ -n "${parsed}" ]; then
    local_port="${parsed%% *}"
    cont_port="${parsed##* }"
    printf '       %-22s %-10s %-10s http://localhost:%s\n' \
      "${mod}" "${local_port}" "${cont_port}" "${local_port}"
  fi
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
skaffold dev -m "${mod_csv}" --cleanup=false "${extra_args[@]}"
