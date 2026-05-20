#!/usr/bin/env bash
# Outer-loop hook: after `skaffold run` builds+pushes the prod image, write the
# new tag into the stacks-repo kustomization and git-push. ArgoCD selfHeal
# reconciles within ~30s (hard-refresh annotation accelerates the poll).
#
# Wired as a `build.artifacts[].hooks.after` hook in workflow-builder.skaffold.yaml.
# Skaffold sets:
#   $SKAFFOLD_IMAGE      = <repo>:<tag>@sha256:<digest>  (full ref with digest)
#   $SKAFFOLD_PUSH_IMAGE = true|false
#
# Usage (from skaffold):  bash commit-pin.sh <service>
# Usage (manual):         SKAFFOLD_IMAGE=gitea.../workflow-builder:git-abc bash commit-pin.sh workflow-builder
#
# Mutates: <stacks>/packages/components/active-development/manifests/<service>/kustomization.yaml

set -euo pipefail

service="${1:?service name required, e.g. workflow-builder}"
: "${SKAFFOLD_IMAGE:?SKAFFOLD_IMAGE env required (Skaffold sets this in build hooks)}"

# Strip any @sha256:... digest suffix; kustomize edit set image takes repo:tag.
image_ref="${SKAFFOLD_IMAGE%%@*}"
repo="${image_ref%:*}"
tag="${image_ref##*:}"

if [ -z "${repo}" ] || [ -z "${tag}" ] || [ "${repo}" = "${tag}" ]; then
  echo "commit-pin: could not parse SKAFFOLD_IMAGE='${SKAFFOLD_IMAGE}' into repo:tag" >&2
  exit 1
fi

# Locate the stacks repo. Default assumes the canonical layout
# /home/$USER/repos/PittampalliOrg/{workflow-builder,stacks}/main.
# Override via $STACKS_REPO_DIR if your checkout lives elsewhere.
hook_dir="$(cd "$(dirname "$0")" && pwd)"
stacks_dir="${STACKS_REPO_DIR:-$(cd "${hook_dir}/../../../../stacks/main" 2>/dev/null && pwd || true)}"

if [ -z "${stacks_dir}" ] || [ ! -d "${stacks_dir}/.git" ]; then
  echo "commit-pin: stacks repo not found (looked for ${hook_dir}/../../../../stacks/main)" >&2
  echo "commit-pin: set STACKS_REPO_DIR=/path/to/stacks/main to override" >&2
  exit 1
fi

manifest_dir="${stacks_dir}/packages/components/active-development/manifests/${service}"
if [ ! -f "${manifest_dir}/kustomization.yaml" ]; then
  echo "commit-pin: no kustomization.yaml for ${service} at ${manifest_dir}" >&2
  exit 1
fi

echo "commit-pin: ${service} → ${repo}:${tag}"
echo "commit-pin: stacks repo: ${stacks_dir}"

# Edit the images: block in-place. `kustomize edit set image <name>=<repo>:<tag>`
# handles both pre-existing entries and net-new ones.
( cd "${manifest_dir}" && kustomize edit set image "${service}=${repo}:${tag}" )

# Nothing to commit? Skip the git work.
if git -C "${stacks_dir}" diff --quiet -- "${manifest_dir}/kustomization.yaml"; then
  echo "commit-pin: ${service} already at ${tag} — no commit needed"
  exit 0
fi

git -C "${stacks_dir}" add "${manifest_dir}/kustomization.yaml"
git -C "${stacks_dir}" commit -m "chore(${service}): pin ryzen dev image to ${tag}

Co-Authored-By: Skaffold <noreply@anthropic.com>"

# Push to the Gitea remote that ArgoCD on ryzen actually reads from.
# Default: `gitea-ryzen` (or fall back to `gitea`, then `origin`). Override
# via $STACKS_REMOTE.
#
# NOTE: pushing to gitea-ryzen does NOT propagate to GitHub `origin`. For
# dev iterations on ryzen this is by design — the kustomize pin reflects an
# in-progress dev image, not a release-quality SHA. A separate PR / Tekton
# pipeline path handles GitHub origin/main.
branch="$(git -C "${stacks_dir}" rev-parse --abbrev-ref HEAD)"
remote="${STACKS_REMOTE:-}"
if [ -z "${remote}" ]; then
  for candidate in gitea-ryzen gitea origin; do
    if git -C "${stacks_dir}" remote get-url "${candidate}" >/dev/null 2>&1; then
      remote="${candidate}"
      break
    fi
  done
fi
if [ -z "${remote}" ]; then
  echo "commit-pin: no git remote found (looked for gitea-ryzen/gitea/origin); set STACKS_REMOTE=" >&2
  exit 1
fi
echo "commit-pin: pushing to remote: ${remote}"
git -C "${stacks_dir}" push "${remote}" "${branch}"

echo "commit-pin: ✓ pushed ${service} → ${tag} on ${branch}"

# Optional: nudge ArgoCD to refresh now instead of waiting for the 3-min poll.
# Failures are non-fatal — selfHeal still picks it up on the next interval.
if kubectl get application "${service}" -n argocd >/dev/null 2>&1; then
  kubectl annotate application "${service}" -n argocd \
    "argocd.argoproj.io/refresh=hard" --overwrite >/dev/null 2>&1 || true
  echo "commit-pin: requested hard refresh of argocd/${service}"
fi
