#!/usr/bin/env bash
# Read-only preflight for the explicit ryzen Skaffold canary loop.
#
# Checks the Skaffold side of the loop: command availability, kubectl context,
# the GHCR default-repo, the stacks worktree + GitHub-main pin cache, per-module
# Argo/Deployment state + pin drift, and Argo skip-reconcile leaks. (The old
# idpbuilder/Gitea/clhot checks were removed when idpbuilder + gitea were
# retired and ryzen moved to reconciling packages/overlays/ryzen@main directly.)

set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"

# Module sets live in the shared library.
# shellcheck source=scripts/_modules.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_modules.sh"

json=false
include_inactive=false

for arg in "$@"; do
  case "${arg}" in
    --)
      ;;
    --json)
      json=true
      ;;
    --all|--include-inactive)
      include_inactive=true
      ;;
    -h|--help)
      cat <<'EOF'
Usage: bash scripts/skaffold-doctor.sh [--json] [--all]

Read-only preflight for the explicit ryzen Skaffold canary loop. Checks command
availability, kubectl context, the GHCR default-repo, the stacks worktree +
GitHub-main pin cache, per-module Argo/Deployment state + pin drift, and Argo
skip-reconcile leaks.

Use this for local hot-loop or autonomous-spoke validation. Automated agentic
development, vCluster previews, and prod-like acceptance should target dev.
EOF
      exit 0
      ;;
    *)
      echo "skaffold-doctor: unknown argument: ${arg}" >&2
      exit 64
      ;;
  esac
done

modules=("${ACTIVE_MODULES[@]}")
if [ "${include_inactive}" = true ]; then
  modules=("${ALL_MODULES[@]}")
fi

stacks_dir="${STACKS_DIR:-/home/vpittamp/repos/PittampalliOrg/stacks/main}"
stacks_cache="${STACKS_REPO_DIR:-${HOME}/.cache/skaffold/stacks-ryzen}"
stacks_remote="${STACKS_REMOTE_URL:-https://github.com/PittampalliOrg/stacks.git}"
stacks_branch="${STACKS_BRANCH:-main}"
workload_ns="${NAMESPACE:-workflow-builder}"
argo_ns="${ARGO_NS:-argocd}"
expected_repo="${SKAFFOLD_DEFAULT_REPO:-ghcr.io/pittampalliorg}"

tmp_json="$(mktemp)"
trap 'rm -f "${tmp_json}"' EXIT

command_status_json() {
  python3 - "$@" <<'PY'
import json, shutil, sys
cmds = sys.argv[1:]
print(json.dumps({cmd: bool(shutil.which(cmd)) for cmd in cmds}))
PY
}

json_string() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))'
}

bootstrap_cache() {
  if git -C "${stacks_cache}" rev-parse --git-dir >/dev/null 2>&1; then
    # Re-point origin if a warm cache was cloned from a different remote
    # (e.g. the old gitea-ryzen URL) so the fetch below hits GitHub.
    local cur
    cur="$(git -C "${stacks_cache}" remote get-url origin 2>/dev/null || true)"
    if [ -n "${cur}" ] && [ "${cur}" != "${stacks_remote}" ]; then
      git -C "${stacks_cache}" remote set-url origin "${stacks_remote}" >/dev/null 2>&1 || true
    fi
    git -C "${stacks_cache}" fetch --depth 50 origin "${stacks_branch}" >/dev/null 2>&1 || true
    return 0
  fi
  mkdir -p "$(dirname "${stacks_cache}")"
  git clone --depth 1 --branch "${stacks_branch}" "${stacks_remote}" "${stacks_cache}" >/dev/null 2>&1
}

get_pinned() {
  local mod="$1"
  local kpath="packages/components/workloads/${mod}/manifests/kustomization.yaml"
  local raw
  if ! raw=$(git -C "${stacks_cache}" show "origin/${stacks_branch}:${kpath}" 2>/dev/null); then
    return 0
  fi
  printf '%s' "${raw}" | python3 -c '
import sys, re
mod = sys.argv[1]
text = sys.stdin.read()
m = re.search(r"(?m)^images:\s*\n((?:[ \t]+.*\n?)+)", text)
if not m:
    sys.exit(0)
for entry in re.split(r"(?m)^  - ", m.group(1)):
    fields = {}
    for line in entry.splitlines():
        kv = re.match(r"\s*(name|newName|newTag):\s*(\S.*)$", line)
        if kv:
            fields[kv.group(1)] = kv.group(2).strip()
    name = fields.get("name", "").rstrip("/")
    if name == mod or name.endswith("/" + mod):
        nn = fields.get("newName", "")
        nt = fields.get("newTag", "")
        if nn and nt:
            print(f"{nn}:{nt}|{name}")
        break
' "${mod}"
}

module_json_lines=()
issue_json_lines=()
warning_json_lines=()

kubectl_context="$(kubectl config current-context 2>/dev/null || true)"
commands_json="$(command_status_json kubectl skaffold git python3)"
for required_cmd in kubectl skaffold git python3; do
  if ! command -v "${required_cmd}" >/dev/null 2>&1; then
    issue_json_lines+=("$(printf '%s not found in PATH' "${required_cmd}" | json_string)")
  fi
done

stacks_repo_ok=false
if git -C "${stacks_dir}" rev-parse --git-dir >/dev/null 2>&1; then
  stacks_repo_ok=true
fi

cache_ok=false
cache_error=""
if bootstrap_cache 2>/tmp/skaffold-doctor-cache.err; then
  cache_ok=true
else
  cache_error="$(cat /tmp/skaffold-doctor-cache.err 2>/dev/null || true)"
fi
rm -f /tmp/skaffold-doctor-cache.err

if [ "${kubectl_context}" != "admin@ryzen" ]; then
  issue_json_lines+=("$(printf 'kubectl context is %s, expected admin@ryzen' "${kubectl_context:-unknown}" | json_string)")
fi
if [ "${expected_repo}" != "ghcr.io/pittampalliorg" ]; then
  issue_json_lines+=("$(printf 'SKAFFOLD_DEFAULT_REPO is %s' "${expected_repo}" | json_string)")
fi
if [ "${stacks_repo_ok}" != true ]; then
  issue_json_lines+=("$(printf 'stacks repo not found at %s' "${stacks_dir}" | json_string)")
fi
if [ "${cache_ok}" != true ]; then
  issue_json_lines+=("$(printf 'could not read GitHub-main stacks cache: %s' "${cache_error}" | json_string)")
fi

for mod in "${modules[@]}"; do
  state="active"
  for inactive in "${INACTIVE_MODULES[@]}"; do
    if [ "${inactive}" = "${mod}" ]; then
      state="inactive"
      break
    fi
  done

  argo_raw=$(kubectl get application "${MODULE_TO_APP[${mod}]:-${mod}}" -n "${argo_ns}" \
    -o jsonpath='{.metadata.annotations.argocd\.argoproj\.io/skip-reconcile}{"|"}{.status.sync.status}{"|"}{.status.health.status}' \
    2>/dev/null || echo "|missing|")
  skip="${argo_raw%%|*}"
  rest="${argo_raw#*|}"
  sync="${rest%%|*}"
  health="${rest##*|}"
  argo_found=true
  if [ "${sync}" = "missing" ] || { [ -z "${sync}" ] && [ -z "${health}" ]; }; then
    argo_found=false
  fi

  live=$(kubectl -n "${workload_ns}" get deploy "${mod}" \
    -o jsonpath="{.spec.template.spec.containers[?(@.name=='${mod}')].image}" \
    2>/dev/null || true)
  if [ -z "${live}" ]; then
    live=$(kubectl -n "${workload_ns}" get deploy "${mod}" \
      -o jsonpath="{.spec.template.spec.containers[0].image}" \
      2>/dev/null || true)
  fi

  pinned_pair=""
  pinned=""
  pin_name=""
  if [ "${cache_ok}" = true ]; then
    pinned_pair="$(get_pinned "${mod}")"
    pinned="${pinned_pair%%|*}"
    if [ -n "${pinned_pair}" ] && [ "${pinned_pair}" != "${pinned}" ]; then
      pin_name="${pinned_pair##*|}"
    fi
  fi

  drift="unknown"
  if [ -z "${live}" ]; then
    drift="missing_deployment"
  elif [[ "${live}" == *"-dev:"* ]] || [[ "${live}" == *"/${mod}-dev:"* ]]; then
    drift="skaffold_dev"
  elif [ -z "${pinned}" ]; then
    drift="missing_pin"
  elif [ "${live}" = "${pinned}" ]; then
    drift="none"
  else
    drift="image_drift"
  fi

  if [ "${state}" = "active" ]; then
    if [ "${argo_found}" != true ]; then
      issue_json_lines+=("$(printf '%s has no Argo Application on ryzen' "${mod}" | json_string)")
    fi
    if [ -z "${live}" ]; then
      issue_json_lines+=("$(printf '%s has no Deployment on ryzen' "${mod}" | json_string)")
    fi
  fi
  if [ "${skip}" = "true" ]; then
    issue_json_lines+=("$(printf '%s has Argo skip-reconcile=true' "${mod}" | json_string)")
  fi

  module_json_lines+=("$(python3 - "$mod" "$state" "$argo_found" "${skip:-false}" "${sync:-}" "${health:-}" "$live" "$pinned" "$pin_name" "$drift" <<'PY'
import json, sys
mod, state, found, skip, sync, health, live, pinned, pin_name, drift = sys.argv[1:]
print(json.dumps({
    "name": mod,
    "state": state,
    "argo": {
        "found": found == "true",
        "skipReconcile": skip == "true",
        "sync": sync or None,
        "health": health or None,
    },
    "liveImage": live or None,
    "pinnedImage": pinned or None,
    "pinName": pin_name or None,
    "drift": drift,
}))
PY
)")
done

python3 - "$tmp_json" "$kubectl_context" "$expected_repo" "$stacks_dir" "$stacks_repo_ok" "$cache_ok" "$commands_json" "${module_json_lines[@]}" --issues "${issue_json_lines[@]}" --warnings "${warning_json_lines[@]}" <<'PY'
import json, sys
out, context, repo, stacks_dir, stacks_ok, cache_ok, commands_json = sys.argv[1:8]
issues_sep = sys.argv.index("--issues")
warnings_sep = sys.argv.index("--warnings")
modules = [json.loads(x) for x in sys.argv[8:issues_sep]]
issues = [json.loads(x) for x in sys.argv[issues_sep + 1:warnings_sep]]
warnings = [json.loads(x) for x in sys.argv[warnings_sep + 1:]]
commands = json.loads(commands_json)
ok = (
    context == "admin@ryzen"
    and repo == "ghcr.io/pittampalliorg"
    and stacks_ok == "true"
    and cache_ok == "true"
    and all(commands.values())
    and all(m["state"] != "active" or (m["argo"]["found"] and m["liveImage"]) for m in modules)
    and not any(m["argo"]["skipReconcile"] for m in modules)
    and not issues
)
data = {
    "ok": ok,
    "issues": issues,
    "warnings": warnings,
    "kubectlContext": context or None,
    "commands": commands,
    "skaffoldDefaultRepo": repo,
    "stacks": {
        "repo": stacks_dir,
        "repoOk": stacks_ok == "true",
        "cacheOk": cache_ok == "true",
    },
    "modules": modules,
}
open(out, "w", encoding="utf-8").write(json.dumps(data, indent=2) + "\n")
PY

if [ "${json}" = true ]; then
  cat "${tmp_json}"
  exit 0
fi

python3 - "$tmp_json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
print()
print(f"  Skaffold doctor: {'ok' if data['ok'] else 'attention needed'}")
print(f"  kubectl context: {data.get('kubectlContext') or 'unknown'}")
print(f"  SKAFFOLD_DEFAULT_REPO/effective: {data['skaffoldDefaultRepo']}")
print(f"  stacks repo: {data['stacks']['repo']} ({'ok' if data['stacks']['repoOk'] else 'missing'})")
print(f"  GitHub-main pin cache: {'ok' if data['stacks']['cacheOk'] else 'unreachable'}")
print()
print("  Modules:")
print("       %-22s %-9s %-8s %-8s %-18s %s" % ("MODULE", "STATE", "SKIP", "SYNC", "DRIFT", "LIVE"))
for mod in data["modules"]:
    live = mod["liveImage"] or "no-deployment"
    if len(live) > 64:
        live = "..." + live[-61:]
    print("       %-22s %-9s %-8s %-8s %-18s %s" % (
        mod["name"],
        mod["state"],
        str(mod["argo"]["skipReconcile"]).lower(),
        mod["argo"]["sync"] or "missing",
        mod["drift"],
        live,
    ))
if data["issues"]:
    print()
    print("  Issues:")
    for issue in data["issues"]:
        print(f"       - {issue}")
if data["warnings"]:
    print()
    print("  Warnings:")
    for warning in data["warnings"]:
        print(f"       - {warning}")
print()
PY
