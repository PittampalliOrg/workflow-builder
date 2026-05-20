#!/usr/bin/env bash
# Outer-loop hook: after `skaffold run` builds+pushes the prod image, write the
# new tag into the stacks-repo kustomization (on gitea-ryzen) and git-push.
# ArgoCD selfHeal reconciles within ~30s (hard-refresh annotation accelerates
# the poll).
#
# Wired as a `build.artifacts[].hooks.after` hook in workflow-builder.skaffold.yaml.
# Skaffold sets:
#   $SKAFFOLD_IMAGE      = <repo>:<tag>@sha256:<digest>  (full ref with digest)
#   $SKAFFOLD_PUSH_IMAGE = true|false
#
# Usage (from skaffold):  bash commit-pin.sh <service>
# Usage (manual):         SKAFFOLD_IMAGE=gitea.../workflow-builder:git-abc bash commit-pin.sh workflow-builder
#
# IMPORTANT: this hook does NOT touch the developer's primary stacks/main
# checkout (which typically tracks GitHub origin/main). Instead it maintains a
# dedicated cache at $HOME/.cache/skaffold/stacks-ryzen tracking gitea-ryzen
# exclusively. On the ryzen cluster, gitea-ryzen and GitHub origin have
# divergent histories; merging them is out of scope for this hook.
#
# Override the cache dir via STACKS_REPO_DIR=/abs/path.

set -euo pipefail

service="${1:?service name required, e.g. workflow-builder}"
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

# Default remote (Tailscale-exposed gitea-ryzen). Override via $STACKS_REMOTE_URL.
remote_url="${STACKS_REMOTE_URL:-https://giteaadmin:developer@gitea-ryzen.tail286401.ts.net/giteaadmin/stacks.git}"
branch="${STACKS_BRANCH:-main}"

# Clone if the cache directory doesn't exist yet. We use `--depth 1` to keep
# the clone small (~30 MB instead of full history); fetch deepens as needed.
if ! git -C "${stacks_dir}" rev-parse --git-dir >/dev/null 2>&1; then
  echo "commit-pin: cloning ${remote_url} → ${stacks_dir}"
  mkdir -p "$(dirname "${stacks_dir}")"
  git clone --depth 1 --branch "${branch}" "${remote_url}" "${stacks_dir}"
fi

# Configure committer identity if not already set (Gitea will reject otherwise).
if ! git -C "${stacks_dir}" config user.email >/dev/null 2>&1; then
  git -C "${stacks_dir}" config user.email "skaffold@workflow-builder.local"
  git -C "${stacks_dir}" config user.name "Skaffold commit-pin"
fi

manifest_dir="${stacks_dir}/packages/components/active-development/manifests/${service}"

# Fetch + hard-reset to the remote tip. We intentionally discard any local
# commits in this cache (it exists solely for pin edits; preserving local
# state is not a goal).
echo "commit-pin: git fetch (depth 50) ${remote_url} ${branch}"
git -C "${stacks_dir}" fetch --depth 50 origin "${branch}" 2>&1 | tail -5
git -C "${stacks_dir}" reset --hard "origin/${branch}"

if [ ! -f "${manifest_dir}/kustomization.yaml" ]; then
  echo "commit-pin: no kustomization.yaml for ${service} at ${manifest_dir}" >&2
  exit 1
fi

echo "commit-pin: ${service} → ${repo}:${tag}"
echo "commit-pin: stacks repo: ${stacks_dir}"

# Edit the images: block in-place. Matches `kustomize edit set image
# <name>=<repo>:<tag>` for the existing-entry path; appending new entries is
# not implemented (we expect every service in scope to already have a pin).
python3 - "$service" "$repo" "$tag" "${manifest_dir}/kustomization.yaml" <<'PY'
import sys, re, pathlib
service, repo, tag, path = sys.argv[1:5]
p = pathlib.Path(path)
text = p.read_text()
pattern = re.compile(
    rf'(\n  - name: {re.escape(service)}\n)'
    rf'(    newName: )[^\n]+(\n)'
    rf'(    newTag: )[^\n]+(\n)',
)
new, n = pattern.subn(rf'\g<1>\g<2>{repo}\g<3>\g<4>{tag}\g<5>', text)
if n == 0:
    sys.exit(f"commit-pin: no `- name: {service}` entry in {path}; append-mode not implemented")
p.write_text(new)
print(f"commit-pin: updated {n} image entry in {p.name}")
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

# Nudge ArgoCD to refresh now instead of waiting for the 3-min poll.
if kubectl get application "${service}" -n argocd >/dev/null 2>&1; then
  kubectl annotate application "${service}" -n argocd \
    "argocd.argoproj.io/refresh=hard" --overwrite >/dev/null 2>&1 || true
  echo "commit-pin: requested hard refresh of argocd/${service}"
fi
