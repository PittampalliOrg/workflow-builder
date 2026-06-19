#!/usr/bin/env bash
# Outer-loop hook: after Skaffold builds+pushes the prod image (to ghcr.io),
# write the new tag into the stacks-repo kustomization on GitHub `main` and
# git-push. ryzen's local autonomous ArgoCD reconciles
# packages/overlays/ryzen@main directly (selfHeal within ~30s; a hard-refresh
# annotation accelerates the poll).
#
# Wired as a `build.artifacts[].hooks.after` hook in workflow-builder.skaffold.yaml
# (and invoked unconditionally by scripts/skaffold-deploy.sh). Skaffold sets:
#   $SKAFFOLD_IMAGE      = <repo>:<tag>@sha256:<digest>  (full ref with digest)
#   $SKAFFOLD_PUSH_IMAGE = true|false
#
# Usage (from skaffold):  bash commit-pin.sh <service>
# Usage (manual):         SKAFFOLD_IMAGE=ghcr.io/pittampalliorg/workflow-builder:git-abc bash commit-pin.sh workflow-builder
#
# Single-writer invariant: commit-pin is the ONLY pin writer on GitHub `main`
# for the Skaffold-owned services (SKAFFOLD_OWNED_DEFAULT in
# scripts/_modules.sh). The gitea Tekton task `update-ryzen-dev-image-tag` that
# used to also write these was retired; the writer-precedence guard below
# refuses to push a pin for any non-owned service. Every other ryzen workload
# is pinned by the hub outer-loop `update-stacks-image` task. The image newName
# is ghcr.io/pittampalliorg/<svc>, so what changes per run is the tag.
#
# IMPORTANT: this hook maintains a dedicated cache at
# $HOME/.cache/skaffold/stacks-ryzen tracking the remote configured by
# STACKS_REMOTE_URL (GitHub `main` by default). Override the cache dir via
# STACKS_REPO_DIR=/abs/path or the remote via STACKS_REMOTE_URL=<url>.

set -euo pipefail

service="${1:?service name required, e.g. workflow-builder}"

# --- Writer-precedence guard -------------------------------------------------
# On GitHub `main` each workloads/<svc>/manifests/kustomization.yaml image pin
# has a SINGLE authoritative writer. commit-pin owns the Skaffold module set;
# every other ryzen workload is pinned by the hub outer-loop
# `update-stacks-image` task. Refuse (clear error, not a silent skip — so an
# outer-loop deploy surfaces it) to push a pin for an un-owned service.
_modules_sh="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/_modules.sh"
if [ -f "${_modules_sh}" ]; then
  # shellcheck source=../../scripts/_modules.sh
  . "${_modules_sh}"
fi
if [ -n "${SKAFFOLD_OWNED_SERVICES:-}" ]; then
  # shellcheck disable=SC2206  # intentional word-split of the env override
  owned=(${SKAFFOLD_OWNED_SERVICES})
elif declare -p SKAFFOLD_OWNED_DEFAULT >/dev/null 2>&1; then
  owned=("${SKAFFOLD_OWNED_DEFAULT[@]}")
else
  owned=(workflow-builder workflow-orchestrator function-router mcp-gateway swebench-coordinator sandbox-execution-api)
fi
_is_owned=0
for _o in "${owned[@]}"; do
  [ "${_o}" = "${service}" ] && { _is_owned=1; break; }
done
if [ "${_is_owned}" -ne 1 ]; then
  echo "commit-pin: '${service}' is not a Skaffold-owned pin target on GitHub main." >&2
  echo "commit-pin: owned services: ${owned[*]}" >&2
  echo "commit-pin: refusing to push (writer-precedence guard)." >&2
  echo "commit-pin: to own it, add it to SKAFFOLD_OWNED_DEFAULT in scripts/_modules.sh," >&2
  echo "commit-pin: or override: SKAFFOLD_OWNED_SERVICES=\"${service} ...\"" >&2
  exit 66
fi
# -----------------------------------------------------------------------------

: "${SKAFFOLD_IMAGE:?SKAFFOLD_IMAGE env required (Skaffold sets this in build hooks)}"

# Strip any @sha256:... digest suffix.
image_ref="${SKAFFOLD_IMAGE%%@*}"
repo="${image_ref%:*}"
tag="${image_ref##*:}"

if [ -z "${repo}" ] || [ -z "${tag}" ] || [ "${repo}" = "${tag}" ]; then
  echo "commit-pin: could not parse SKAFFOLD_IMAGE='${SKAFFOLD_IMAGE}' into repo:tag" >&2
  exit 1
fi

# Where the dedicated stacks-ryzen checkout lives.
default_cache_dir="${HOME}/.cache/skaffold/stacks-ryzen"
stacks_dir="${STACKS_REPO_DIR:-${default_cache_dir}}"

# Default remote: GitHub `main` (the GitOps source of record that ryzen reads).
# NO embedded credential — GitHub auth resolves via the git credential helper /
# gh / GITHUB_TOKEN. Override via $STACKS_REMOTE_URL.
remote_url="${STACKS_REMOTE_URL:-https://github.com/PittampalliOrg/stacks.git}"
branch="${STACKS_BRANCH:-main}"

# Clone if the cache directory doesn't exist yet. We use `--depth 1` to keep
# the clone small (~30 MB instead of full history); fetch deepens as needed.
if ! git -C "${stacks_dir}" rev-parse --git-dir >/dev/null 2>&1; then
  echo "commit-pin: cloning ${remote_url} → ${stacks_dir}"
  mkdir -p "$(dirname "${stacks_dir}")"
  git clone --depth 1 --branch "${branch}" "${remote_url}" "${stacks_dir}"
fi

# Re-point origin if a warm cache was cloned from a different remote (e.g. the
# old gitea-ryzen URL). Without this, a pre-existing
# $HOME/.cache/skaffold/stacks-ryzen keeps fetching/pushing the OLD remote.
cur_origin="$(git -C "${stacks_dir}" remote get-url origin 2>/dev/null || true)"
if [ -n "${cur_origin}" ] && [ "${cur_origin}" != "${remote_url}" ]; then
  echo "commit-pin: origin changed (${cur_origin} → ${remote_url}); updating remote"
  git -C "${stacks_dir}" remote set-url origin "${remote_url}"
fi

# Configure committer identity if not already set (the remote rejects otherwise).
if ! git -C "${stacks_dir}" config user.email >/dev/null 2>&1; then
  git -C "${stacks_dir}" config user.email "skaffold@workflow-builder.local"
  git -C "${stacks_dir}" config user.name "Skaffold commit-pin"
fi

# Phase 2a moved per-app manifests from active-development to workloads.
# The kustomization.yaml schema is preserved (images: block with name/newName/newTag),
# so only the target path changes.
manifest_dir="${stacks_dir}/packages/components/workloads/${service}/manifests"

# Fetch + hard-reset to the remote tip. We intentionally discard any local
# commits in this cache (it exists solely for pin edits; preserving local
# state is not a goal).
echo "commit-pin: git fetch (depth 50) ${remote_url} ${branch}"
git -C "${stacks_dir}" fetch --depth 50 origin "${branch}" 2>&1 | tail -5
git -C "${stacks_dir}" reset --hard "origin/${branch}"

# --- C1 unification (2026-06-04): workflow-builder + workflow-mcp-server pin via
#     the FLAT ryzen release-pins file, NOT the per-app manifests images block
#     (which was deleted in the C1 cutover). We upsert the flat file AND render the
#     workflow-builder-ryzen-image Component locally (from the fresh hard-reset
#     cache clone) so ryzen — an autonomous argocd-agent with no fast inbound
#     refresh path — reconciles the new image in seconds. The hub CI
#     render-ryzen-image.yml re-renders on push as a drift-correction safety net
#     (no-ops when our local render already matches). Other Skaffold-owned services
#     still pin via their per-app manifests block (the nested-parser path below).
case "${service}" in
  workflow-builder | workflow-mcp-server | sandbox-execution-api)
    ryzen_pins="${stacks_dir}/packages/components/hub-spoke-appsets/release-pins/workflow-builder-images-ryzen.yaml"
    if [ ! -f "${ryzen_pins}" ]; then
      echo "commit-pin: ryzen pins file missing: ${ryzen_pins}" >&2
      exit 1
    fi
    # Recover the @sha256 digest (image_ref stripped it at the top) + the source sha.
    digest="${SKAFFOLD_IMAGE##*@}"
    case "${digest}" in sha256:*) ;; *) digest="" ;; esac
    source_sha="${tag#git-}"
    echo "commit-pin: ${service} → ${repo}:${tag} (flat ryzen pins + local Component render)"
    python3 - "$service" "$repo" "$tag" "$digest" "$source_sha" "${ryzen_pins}" <<'PY'
import sys, re, pathlib
service, repo, tag, digest, source_sha, path = sys.argv[1:7]
p = pathlib.Path(path)
lines = p.read_text().splitlines(keepends=True)

# Flat schema: each top-level section (`images:`, `imageRefs:`, …) holds
# `  <service>: <value>` rows. Upsert the value for this service in each section.
updates = {"images": tag, "imageRefs": f"{repo}:{tag}", "sourceShas": source_sha}
if digest:
    updates["digests"] = digest

def set_in_section(section, value):
    in_s = False
    for i, ln in enumerate(lines):
        if ln.rstrip("\n") == section + ":":
            in_s = True
            continue
        if in_s and ln and not ln[0].isspace() and not ln.startswith("#"):
            in_s = False
        if in_s and re.match(r"^\s+" + re.escape(service) + r":\s*", ln):
            indent = re.match(r"^(\s+)", ln).group(1)
            lines[i] = f"{indent}{service}: {value}\n"
            return True
    return False

missing = [s for s, v in updates.items() if not set_in_section(s, v)]
if missing:
    sys.exit(f"commit-pin: {service} row missing from section(s) {missing} in {path}")
p.write_text("".join(lines))
print(f"commit-pin: upserted {service} → {tag} in {p.name} (flat ryzen pins)")
PY
    # Render the workflow-builder-ryzen-image Component LOCALLY so ryzen reconciles
    # the new image in seconds. ryzen is an autonomous argocd-agent (no
    # argocd-server, and the principal does NOT relay a refresh to autonomous
    # agents on v0.8.1 — verified empirically), so its only fast path is committing
    # the rendered Component here + refreshing the spoke-local app directly. The
    # cache clone was hard-reset to origin/${branch} above, so this is a FRESH (not
    # stale) checkout and the render is deterministic. render-ryzen-image.yml
    # re-renders on push as a drift-correction safety net and no-ops when this
    # local render already matches (it commits only on a diff).
    component="packages/components/workloads/workflow-builder-ryzen-image/kustomization.yaml"
    ( cd "${stacks_dir}" && WFB_RENDER_ENVS=ryzen \
        scripts/gitops/render-workflow-builder-release-overlays.sh \
        packages/components/hub-spoke-appsets/release-pins/workflow-builder-images-ryzen.yaml ) \
      || { echo "commit-pin: local ryzen Component render failed" >&2; exit 1; }
    if git -C "${stacks_dir}" diff --quiet -- "${ryzen_pins}" "${component}"; then
      echo "commit-pin: ${service} already at ${tag} (pins + Component in sync) — no commit needed"
      exit 0
    fi
    git -C "${stacks_dir}" add "${ryzen_pins}" "${component}"
    git -C "${stacks_dir}" commit -m "chore(${service}): pin ryzen image to ${tag}

Flat ryzen release-pins + locally-rendered workflow-builder-ryzen-image Component
(so ryzen reconciles immediately). render-ryzen-image.yml re-renders in CI as a
drift-correction safety net.
Co-Authored-By: Skaffold <noreply@anthropic.com>"
    echo "commit-pin: git push origin ${branch}"
    git -C "${stacks_dir}" push origin "${branch}"
    echo "commit-pin: ✓ pushed ${service} → ${tag} (pins + rendered Component)"
    # Refresh the ryzen SPOKE-local app directly (ns argocd on the ryzen cluster).
    # The autonomous agent honors a local refresh; the hub mirror does NOT relay
    # refresh to autonomous agents (verified on argocd-agent v0.8.1). The Component
    # is committed above, so this refresh picks up the new image immediately.
    for app in "ryzen-${service}" "${service}"; do
      if kubectl get application "${app}" -n argocd >/dev/null 2>&1; then
        kubectl annotate application "${app}" -n argocd \
          "argocd.argoproj.io/refresh=hard" --overwrite >/dev/null 2>&1 || true
        echo "commit-pin: requested hard refresh of argocd/${app}"
        break
      fi
    done
    exit 0
    ;;
esac

if [ ! -f "${manifest_dir}/kustomization.yaml" ]; then
  echo "commit-pin: no kustomization.yaml for ${service} at ${manifest_dir}" >&2
  exit 1
fi

echo "commit-pin: ${service} → ${repo}:${tag}"
echo "commit-pin: stacks repo: ${stacks_dir}"

# Edit the images: block in-place. Matches `kustomize edit set image
# <name>=<repo>:<tag>` for the existing-entry path; appending new entries is
# not implemented (we expect every service in scope to already have a pin).
#
# Two real-world wrinkles this parser handles:
# - The `name:` field can be the short slug (e.g. `workflow-builder`) OR
#   the long form that matches what the Deployment YAML references (e.g.
#   `ghcr.io/pittampalliorg/workflow-orchestrator`). We
#   match either: `name == <service>` OR `name endswith /<service>`.
# - Field order under each entry is inconsistent — some have
#   `newName/newTag`, others have `newTag/newName`. We rewrite only the
#   `newName` and `newTag` lines individually, regardless of order.
python3 - "$service" "$repo" "$tag" "${manifest_dir}/kustomization.yaml" <<'PY'
import sys, re, pathlib
service, repo, tag, path = sys.argv[1:5]
p = pathlib.Path(path)
text = p.read_text()
lines = text.splitlines(keepends=True)

# Find the images: block. Everything indented by 2+ spaces beneath it
# belongs to the block until we hit a top-level key.
start = None
for i, ln in enumerate(lines):
    if ln.startswith('images:'):
        start = i + 1
        break
if start is None:
    sys.exit(f"commit-pin: no `images:` block in {path}")

end = len(lines)
for i in range(start, len(lines)):
    # Top-level key (column 0, non-empty) ends the block.
    if lines[i] and not lines[i][0].isspace() and not lines[i].startswith('#'):
        end = i
        break

# Walk entries — each `  - name: ...` line starts a new entry; subsequent
# `    newName: ...` / `    newTag: ...` lines belong to it until the next
# entry or block end.
entries = []  # list of (entry_start, entry_end, name_value)
cur_start = None
cur_name = None
for i in range(start, end):
    m_name = re.match(r'^  - name:\s*(\S.*)$', lines[i])
    if m_name:
        if cur_start is not None:
            entries.append((cur_start, i, cur_name))
        cur_start = i
        cur_name = m_name.group(1).strip().rstrip('/')
if cur_start is not None:
    entries.append((cur_start, end, cur_name))

# Pick the entry that matches the service slug (short OR long form).
target = None
for s, e, name in entries:
    if name == service or name.endswith('/' + service):
        target = (s, e, name)
        break
if target is None:
    sys.exit(f"commit-pin: no images entry matching `{service}` (or */{service}) in {path}")

s, e, _ = target
n_name = n_tag = 0
for i in range(s, e):
    nn = re.match(r'^(    newName:\s*)\S.*$', lines[i])
    nt = re.match(r'^(    newTag:\s*)\S.*$', lines[i])
    if nn:
        lines[i] = f"{nn.group(1)}{repo}\n"
        n_name += 1
    elif nt:
        lines[i] = f"{nt.group(1)}{tag}\n"
        n_tag += 1

if n_name == 0 or n_tag == 0:
    sys.exit(f"commit-pin: matched entry but missing newName/newTag in {path}")

p.write_text(''.join(lines))
print(f"commit-pin: updated newName + newTag for `{service}` in {p.name}")
PY

if git -C "${stacks_dir}" diff --quiet -- "${manifest_dir}/kustomization.yaml"; then
  echo "commit-pin: ${service} already at ${tag} — no commit needed"
  exit 0
fi

git -C "${stacks_dir}" add "${manifest_dir}/kustomization.yaml"
git -C "${stacks_dir}" commit -m "chore(${service}): pin ryzen dev image to ${tag}

Co-Authored-By: Skaffold <noreply@anthropic.com>"

echo "commit-pin: git push origin ${branch}"
git -C "${stacks_dir}" push origin "${branch}"
echo "commit-pin: ✓ pushed ${service} → ${tag} on ${branch}"

# Nudge ArgoCD to refresh now instead of waiting for the 3-min poll. ryzen's
# autonomous agent names the app `ryzen-${service}`; the bare name no-ops there.
for app in "ryzen-${service}" "${service}"; do
  if kubectl get application "${app}" -n argocd >/dev/null 2>&1; then
    kubectl annotate application "${app}" -n argocd \
      "argocd.argoproj.io/refresh=hard" --overwrite >/dev/null 2>&1 || true
    echo "commit-pin: requested hard refresh of argocd/${app}"
    break
  fi
done
