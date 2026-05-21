#!/usr/bin/env bash
# Print a one-screen status table for every active Skaffold-managed module.
#
# For each module shows:
#   - ARGO    Whether the gitea-ryzen ArgoCD Application is paused
#             (argocd.argoproj.io/skip-reconcile=true) + sync/health state.
#   - LIVE    The image currently running on the cluster Deployment.
#   - PINNED  The image+tag in stacks-ryzen kustomization (i.e. what Argo
#             *would* reconcile to if you un-paused).
#   - DRIFT   Short label: "-" (match), "DEV" (Skaffold inner-loop image
#             deployed), "BEHIND" (cluster running an older tag than pinned),
#             "AHEAD" (cluster running a newer tag than pinned — manual
#             kubectl patch?), "NO PIN" (no images entry), "NAME MISMATCH"
#             (kustomization name field doesn't match module slug — commit-pin
#             would fail), "MISSING" (Deployment not found).
#
# Usage:
#   bash scripts/skaffold-status.sh                       # active modules
#   bash scripts/skaffold-status.sh --all                 # active + inactive modules
#   bash scripts/skaffold-status.sh workflow-builder      # single module
#   pnpm skaffold:status                                  # via package.json
#
# Read-only — fetches the gitea-ryzen tip into the cache clone but never
# resets or modifies it. Safe to run during an active `skaffold dev` session.

set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"

# Keep in sync with scripts/skaffold-dev.sh's module sets.
ACTIVE_MODULES=(workflow-builder workflow-orchestrator function-router mcp-gateway swebench-coordinator)
INACTIVE_MODULES=(fn-activepieces)
ALL_MODULES=("${ACTIVE_MODULES[@]}" "${INACTIVE_MODULES[@]}")

modules=("$@")
if [ "${#modules[@]}" -eq 0 ] \
   || [ "${modules[0]}" = "ACTIVE" ] \
   || [ "${modules[0]}" = "active" ]; then
  modules=("${ACTIVE_MODULES[@]}")
elif [ "${modules[0]}" = "ALL" ] \
   || [ "${modules[0]}" = "all" ] \
   || [ "${modules[0]}" = "--all" ]; then
  modules=("${ALL_MODULES[@]}")
fi

stacks_dir="${STACKS_REPO_DIR:-${HOME}/.cache/skaffold/stacks-ryzen}"
remote_url="${STACKS_REMOTE_URL:-https://giteaadmin:developer@gitea-ryzen.tail286401.ts.net/giteaadmin/stacks.git}"
branch="${STACKS_BRANCH:-main}"
ns="${NAMESPACE:-workflow-builder}"
argo_ns="${ARGO_NS:-argocd}"

# Bootstrap the cache clone if it doesn't exist. Same shape as commit-pin.sh.
if ! git -C "${stacks_dir}" rev-parse --git-dir >/dev/null 2>&1; then
  printf 'skaffold-status: cloning %s → %s (first run)\n' "${remote_url}" "${stacks_dir}" >&2
  mkdir -p "$(dirname "${stacks_dir}")"
  git clone --depth 1 --branch "${branch}" "${remote_url}" "${stacks_dir}" >/dev/null
fi

# Non-destructive fetch — we only read `origin/<branch>:<path>` via `git show`.
# Tolerate transient network failures; status is still useful with stale data.
git -C "${stacks_dir}" fetch --depth 50 origin "${branch}" >/dev/null 2>&1 || \
  echo "skaffold-status: warning — fetch failed; showing last-known pinned tags" >&2

# --- helpers ----------------------------------------------------------------

# Truncate a long image string for table display.
shorten_image() {
  local img="$1"
  # Show last 60 chars with a leading ellipsis if too long.
  if [ "${#img}" -gt 60 ]; then
    printf '…%s' "${img: -59}"
  else
    printf '%s' "${img}"
  fi
}

# Parse the pinned image entry for $1 (module) from the kustomization at
# origin/<branch>. Returns "<newName>:<newTag>|<nameField>" or "" if missing.
# The kustomization text is passed via stdin so the Python program stays in
# argv (no heredoc/stdin collision).
get_pinned() {
  local mod="$1"
  local kpath="packages/components/active-development/manifests/${mod}/kustomization.yaml"
  local raw
  if ! raw=$(git -C "${stacks_dir}" show "origin/${branch}:${kpath}" 2>/dev/null); then
    return 0
  fi
  printf '%s' "${raw}" | python3 -c '
import sys, re
mod = sys.argv[1]
text = sys.stdin.read()

m = re.search(r"(?m)^images:\s*\n((?:[ \t]+.*\n?)+)", text)
if not m:
    sys.exit(0)
block = m.group(1)
# Split on lines that begin a list entry ("  - "). Keeps key order flexible
# (some entries have newTag before newName).
entries = re.split(r"(?m)^  - ", block)
for entry in entries:
    entry = entry.strip()
    if not entry:
        continue
    fields = {}
    for line in entry.splitlines():
        kv = re.match(r"\s*(name|newName|newTag):\s*(\S.*)$", line)
        if kv:
            fields[kv.group(1)] = kv.group(2).strip()
    name = fields.get("name", "").rstrip("/")
    if not name:
        continue
    if name == mod or name.endswith("/" + mod):
        nn = fields.get("newName", "")
        nt = fields.get("newTag", "")
        print(f"{nn}:{nt}|{name}")
        break
' "${mod}"
}

# Print one row. Args: module argo_state live pinned drift
print_row() {
  printf '  %-22s %-22s %-60s %-50s %s\n' "$@"
}

# --- query argocd + cluster -------------------------------------------------

declare -i paused_count=0
declare -i drift_count=0
declare -i name_mismatch_count=0
declare -i inactive_count=0

printf '\n'
printf '  %-22s %-9s %-22s %-60s %-50s %s\n' MODULE STATE ARGO LIVE PINNED DRIFT
printf '  %-22s %-9s %-22s %-60s %-50s %s\n' "$(printf -- '-%.0s' {1..22})" \
  "$(printf -- '-%.0s' {1..9})" "$(printf -- '-%.0s' {1..22})" \
  "$(printf -- '-%.0s' {1..60})" "$(printf -- '-%.0s' {1..50})" "-----"

for mod in "${modules[@]}"; do
  module_state="active"
  for inactive in "${INACTIVE_MODULES[@]}"; do
    if [ "${inactive}" = "${mod}" ]; then
      module_state="inactive"
      inactive_count=$((inactive_count + 1))
      break
    fi
  done

  # Argo state: skip-reconcile + sync + health
  argo_raw=$(kubectl get application "${mod}" -n "${argo_ns}" \
    -o jsonpath='{.metadata.annotations.argocd\.argoproj\.io/skip-reconcile}{"|"}{.status.sync.status}{"|"}{.status.health.status}' \
    2>/dev/null || echo "|missing|")
  skip="${argo_raw%%|*}"
  rest="${argo_raw#*|}"
  sync="${rest%%|*}"
  health="${rest##*|}"

  if [ "${sync}" = "missing" ] || [ -z "${sync}" ] && [ -z "${health}" ]; then
    argo_state="not-found"
  elif [ "${skip}" = "true" ]; then
    argo_state="paused (${sync:-?}/${health:-?})"
    paused_count=$((paused_count + 1))
  else
    argo_state="active (${sync:-?}/${health:-?})"
  fi

  # Live image: pull the named container's image, falling back to container[0].
  live_raw=$(kubectl -n "${ns}" get deploy "${mod}" \
    -o jsonpath="{.spec.template.spec.containers[?(@.name=='${mod}')].image}" \
    2>/dev/null || true)
  if [ -z "${live_raw}" ]; then
    live_raw=$(kubectl -n "${ns}" get deploy "${mod}" \
      -o jsonpath="{.spec.template.spec.containers[0].image}" \
      2>/dev/null || true)
  fi
  if [ -z "${live_raw}" ]; then
    live_display="(no Deployment)"
  else
    live_display="$(shorten_image "${live_raw}")"
  fi

  # Pinned tag from gitea-ryzen kustomization.
  pinned_pair="$(get_pinned "${mod}")"
  if [ -z "${pinned_pair}" ]; then
    pinned_display="(no images: entry)"
    pinned_full=""
    pinned_name_field=""
  else
    pinned_full="${pinned_pair%%|*}"
    pinned_name_field="${pinned_pair##*|}"
    pinned_display="$(shorten_image "${pinned_full}")"
  fi

  # Compute drift.
  if [ -z "${live_raw}" ]; then
    drift="MISSING"
  elif [[ "${live_raw}" == *"-dev:"* ]] || [[ "${live_raw}" == *"/${mod}-dev:"* ]]; then
    drift="DEV (Skaffold inner-loop active)"
  elif [ -z "${pinned_full}" ]; then
    drift="NO PIN"
  elif [ "${live_raw}" = "${pinned_full}" ]; then
    drift="-"
  else
    # Tag-only drift vs full-image drift. Compare just the tag suffix.
    live_tag="${live_raw##*:}"
    pinned_tag="${pinned_full##*:}"
    if [ "${live_tag}" = "${pinned_tag}" ]; then
      drift="repo-only drift (same tag, different newName)"
    else
      drift="DRIFT (live=${live_tag:0:11}.. pinned=${pinned_tag:0:11}..)"
      drift_count=$((drift_count + 1))
    fi
  fi

  # Surface name-field mismatches that would break commit-pin's regex.
  if [ -n "${pinned_name_field}" ] && [ "${pinned_name_field}" != "${mod}" ]; then
    drift="${drift} | NAME-MISMATCH (${pinned_name_field})"
    name_mismatch_count=$((name_mismatch_count + 1))
  fi

  printf '  %-22s %-9s %-22s %-60s %-50s %s\n' \
    "${mod}" "${module_state}" "${argo_state}" "${live_display}" "${pinned_display}" "${drift}"
done

# --- summary + hints --------------------------------------------------------

printf '\n'
if [ "${paused_count}" -gt 0 ]; then
  printf '  ⚠  %d app(s) paused — resume with:\n' "${paused_count}"
  printf '       ARGO_APPS="<apps>" bash skaffold/hooks/argo-resume.sh\n'
fi
if [ "${drift_count}" -gt 0 ]; then
  printf '  ⚠  %d module(s) running an image different from the gitea-ryzen pin.\n' "${drift_count}"
  printf '       If you paused Argo via skaffold-dev.sh, this is expected.\n'
  printf '       Otherwise: check the ArgoCD app status + last sync result.\n'
fi
if [ "${name_mismatch_count}" -gt 0 ]; then
  printf '  ℹ  %d kustomization entry(ies) use a long-form `name:` (e.g. gitea-ryzen.../<svc>) instead of\n' "${name_mismatch_count}"
  printf '       the short slug. This is necessary when the underlying Deployment references the long\n'
  printf '       form (kustomize matches images by exact `name`). commit-pin.sh handles both shapes —\n'
  printf '       informational only; no fix needed.\n'
fi
if [ "${inactive_count}" -gt 0 ]; then
  printf '  ℹ  %d inactive module(s) shown. Inactive modules are excluded from default status and\n' "${inactive_count}"
  printf '       from `skaffold-dev.sh ALL`; run them only with SKAFFOLD_ALLOW_INACTIVE=1.\n'
fi
if [ "${paused_count}" -eq 0 ] && [ "${drift_count}" -eq 0 ] && [ "${name_mismatch_count}" -eq 0 ] && [ "${inactive_count}" -eq 0 ]; then
  printf '  ✓  All modules are active, in sync with the gitea-ryzen pin, and have well-formed name fields.\n'
fi
printf '\n'
printf '  stacks-ryzen cache: %s @ %s\n' "${stacks_dir}" \
  "$(git -C "${stacks_dir}" rev-parse --short origin/"${branch}" 2>/dev/null || echo unknown)"
printf '\n'
