#!/usr/bin/env bash
# Read-only preflight for the ryzen Skaffold dev loop.
#
# This deliberately checks both sides of the hybrid loop:
# - Skaffold: local dev images, Argo pause state, live Deployment drift.
# - idpbuilder/GitOps: local stacks snapshot path, affected-app planner, and
#   hot-loop readiness. Skaffold must not hide a broken Gitea/Argo sync path.

set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"

ACTIVE_MODULES=(workflow-builder workflow-orchestrator function-router mcp-gateway swebench-coordinator)
INACTIVE_MODULES=(fn-activepieces)
ALL_MODULES=("${ACTIVE_MODULES[@]}" "${INACTIVE_MODULES[@]}")

json=false
include_inactive=false
skip_clhot=false
skip_refresh_plan=false

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
    --skip-clhot)
      skip_clhot=true
      ;;
    --skip-refresh-plan)
      skip_refresh_plan=true
      ;;
    -h|--help)
      cat <<'EOF'
Usage: bash scripts/skaffold-doctor.sh [--json] [--all] [--skip-clhot] [--skip-refresh-plan]

Read-only preflight for the ryzen Skaffold loop. Checks command availability,
kubectl context, module Argo/Deployment state, gitea-ryzen pin drift, idpbuilder
stack status, hardened sync flag availability, and the read-only idpbuilder
affected-app refresh plan.
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
stacks_remote="${STACKS_REMOTE_URL:-https://giteaadmin:developer@gitea-ryzen.tail286401.ts.net/giteaadmin/stacks.git}"
stacks_branch="${STACKS_BRANCH:-main}"
workload_ns="${NAMESPACE:-workflow-builder}"
argo_ns="${ARGO_NS:-argocd}"
expected_repo="${SKAFFOLD_DEFAULT_REPO:-gitea-ryzen.tail286401.ts.net/giteaadmin}"

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

summarize_clhot_failure() {
  python3 -c '
import json, sys
text = sys.stdin.read()
try:
    data = json.loads(text)
except Exception:
    print(text.splitlines()[0] if text.splitlines() else "unknown failure")
    raise SystemExit
reasons = data.get("overall", {}).get("degradedReasons") or []
bits = []
for reason in reasons[:3]:
    section = reason.get("section", "unknown")
    message = reason.get("message", "")
    bits.append(f"{section}: {message}" if message else section)
print("; ".join(bits) or data.get("operatorState") or "degraded")
'
}

shorten() {
  local value="$1"
  if [ "${#value}" -gt 70 ]; then
    printf '...%s' "${value: -67}"
  else
    printf '%s' "${value}"
  fi
}

bootstrap_cache() {
  if git -C "${stacks_cache}" rev-parse --git-dir >/dev/null 2>&1; then
    git -C "${stacks_cache}" fetch --depth 50 origin "${stacks_branch}" >/dev/null 2>&1 || true
    return 0
  fi
  mkdir -p "$(dirname "${stacks_cache}")"
  git clone --depth 1 --branch "${stacks_branch}" "${stacks_remote}" "${stacks_cache}" >/dev/null 2>&1
}

get_pinned() {
  local mod="$1"
  local kpath="packages/components/active-development/manifests/${mod}/kustomization.yaml"
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

get_local_pinned() {
  local mod="$1"
  local path="${stacks_dir}/packages/components/active-development/manifests/${mod}/kustomization.yaml"
  if [ ! -f "${path}" ]; then
    return 0
  fi
  python3 - "${mod}" "${path}" <<'PY'
import pathlib, re, sys
mod, path = sys.argv[1:]
text = pathlib.Path(path).read_text(encoding="utf-8")
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
PY
}

module_json_lines=()
issue_json_lines=()
warning_json_lines=()

kubectl_context="$(kubectl config current-context 2>/dev/null || true)"
commands_json="$(command_status_json kubectl skaffold git python3 idpbuilder jq)"
for required_cmd in kubectl skaffold git python3 idpbuilder jq; do
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
if [ "${expected_repo}" != "gitea-ryzen.tail286401.ts.net/giteaadmin" ]; then
  issue_json_lines+=("$(printf 'SKAFFOLD_DEFAULT_REPO is %s' "${expected_repo}" | json_string)")
fi
if [ "${stacks_repo_ok}" != true ]; then
  issue_json_lines+=("$(printf 'stacks repo not found at %s' "${stacks_dir}" | json_string)")
fi
if [ "${cache_ok}" != true ]; then
  issue_json_lines+=("$(printf 'could not read gitea-ryzen stacks cache: %s' "${cache_error}" | json_string)")
fi
idpbuilder_sync_seed_flag=false
if command -v idpbuilder >/dev/null 2>&1; then
  if idpbuilder stacks sync --help 2>/dev/null | rg -q -- '--seed-images'; then
    idpbuilder_sync_seed_flag=true
  else
    warning_json_lines+=("$(printf 'installed idpbuilder does not expose --seed-images; upgrade before mutating ryzen syncs so active-development image pins are preserved by default' | json_string)")
  fi
fi

for mod in "${modules[@]}"; do
  state="active"
  for inactive in "${INACTIVE_MODULES[@]}"; do
    if [ "${inactive}" = "${mod}" ]; then
      state="inactive"
      break
    fi
  done

  argo_raw=$(kubectl get application "${mod}" -n "${argo_ns}" \
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
  local_pinned_pair="$(get_local_pinned "${mod}")"
  local_pinned="${local_pinned_pair%%|*}"
  if [ -z "${local_pinned_pair}" ]; then
    local_pinned=""
  fi
  local_pin_differs=false
  if [ -n "${pinned}" ] && [ -n "${local_pinned}" ] && [ "${pinned}" != "${local_pinned}" ]; then
    local_pin_differs=true
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
  if [ "${state}" = "active" ] && [ "${local_pin_differs}" = true ]; then
    warning_json_lines+=("$(printf '%s gitea-ryzen pin differs from local stacks pin; next idpbuilder sync can overwrite the Skaffold pin' "${mod}" | json_string)")
  fi

  module_json_lines+=("$(python3 - "$mod" "$state" "$argo_found" "${skip:-false}" "${sync:-}" "${health:-}" "$live" "$pinned" "$pin_name" "$local_pinned" "$local_pin_differs" "$drift" <<'PY'
import json, sys
mod, state, found, skip, sync, health, live, pinned, pin_name, local_pinned, local_pin_differs, drift = sys.argv[1:]
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
    "localStacksPinnedImage": local_pinned or None,
    "localStacksPinDiffers": local_pin_differs == "true",
    "drift": drift,
}))
PY
)")
done

idpbuilder_status_text=""
idpbuilder_status_ok=false
if command -v idpbuilder >/dev/null 2>&1; then
  if idpbuilder_status_text="$(idpbuilder stacks status --stacks-repo "${stacks_dir}" 2>&1)"; then
    idpbuilder_status_ok=true
  else
    issue_json_lines+=("$(printf 'idpbuilder stacks status failed: %s' "${idpbuilder_status_text}" | json_string)")
  fi
else
  issue_json_lines+=("$(printf 'idpbuilder not found in PATH' | json_string)")
fi

refresh_plan_text=""
refresh_plan_ok=false
if [ "${skip_refresh_plan}" = false ] && command -v idpbuilder >/dev/null 2>&1; then
  if refresh_plan_text="$(idpbuilder stacks sync --stacks-repo "${stacks_dir}" --print-refresh-plan 2>&1)"; then
    refresh_plan_ok=true
  else
    issue_json_lines+=("$(printf 'idpbuilder print-refresh-plan failed: %s' "${refresh_plan_text}" | json_string)")
  fi
fi

clhot_text=""
clhot_ok=false
if [ "${skip_clhot}" = false ] && [ -f "${stacks_dir}/deployment/scripts/cluster-menu.sh" ]; then
  if clhot_text="$(bash -lc "source '${stacks_dir}/deployment/scripts/cluster-menu.sh' >/dev/null 2>&1; clhot --ci-one-shot --check --json" 2>&1)"; then
    clhot_ok=true
  else
    clhot_summary="$(printf '%s' "${clhot_text}" | summarize_clhot_failure 2>/dev/null || true)"
    issue_json_lines+=("$(printf 'clhot --ci-one-shot --check failed: %s' "${clhot_summary:-unknown failure}" | json_string)")
  fi
fi

python3 - "$tmp_json" "$kubectl_context" "$expected_repo" "$stacks_dir" "$stacks_repo_ok" "$cache_ok" "$idpbuilder_status_ok" "$refresh_plan_ok" "$clhot_ok" "$commands_json" "$idpbuilder_sync_seed_flag" "$idpbuilder_status_text" "$refresh_plan_text" "$clhot_text" "${module_json_lines[@]}" --issues "${issue_json_lines[@]}" --warnings "${warning_json_lines[@]}" <<'PY'
import json, sys
out, context, repo, stacks_dir, stacks_ok, cache_ok, idp_ok, plan_ok, clhot_ok, commands_json, seed_flag, idp_text, plan_text, clhot_text = sys.argv[1:15]
issues_sep = sys.argv.index("--issues")
warnings_sep = sys.argv.index("--warnings")
modules = [json.loads(x) for x in sys.argv[15:issues_sep]]
issues = [json.loads(x) for x in sys.argv[issues_sep + 1:warnings_sep]]
warnings = [json.loads(x) for x in sys.argv[warnings_sep + 1:]]
commands = json.loads(commands_json)
ok = (
    context == "admin@ryzen"
    and repo == "gitea-ryzen.tail286401.ts.net/giteaadmin"
    and stacks_ok == "true"
    and cache_ok == "true"
    and idp_ok == "true"
    and plan_ok == "true"
    and clhot_ok == "true"
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
    "idpbuilder": {
        "statusOk": idp_ok == "true",
        "statusText": idp_text,
        "refreshPlanOk": plan_ok == "true",
        "refreshPlanText": plan_text,
        "supportsSeedImagesFlag": seed_flag == "true",
    },
    "clhot": {
        "ok": clhot_ok == "true",
        "text": clhot_text,
    },
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
print()
print(f"  idpbuilder stacks status: {'ok' if data['idpbuilder']['statusOk'] else 'failed'}")
print(f"  idpbuilder seed-images flag: {'available' if data['idpbuilder']['supportsSeedImagesFlag'] else 'missing'}")
print(f"  idpbuilder refresh plan: {'ok' if data['idpbuilder']['refreshPlanOk'] else 'skipped/failed'}")
print(f"  clhot one-shot: {'ok' if data['clhot']['ok'] else 'skipped/failed'}")
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
