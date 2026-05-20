#!/usr/bin/env bash
# Outer-loop: build + push the prod image, then commit the new tag into
# stacks-repo's kustomization and let ArgoCD reconcile.
#
# Why a wrapper instead of `skaffold run`:
#   - `skaffold run -m <svc>` also tries to deploy the dev kustomize overlay
#     (Skaffold v2 doesn't cleanly let a profile suppress deploy when the
#     base config has manifests.kustomize.paths set).
#   - Artifact `hooks.after` only fires when Skaffold actually builds — when
#     the image is cached, the hook is skipped, and we'd silently miss the
#     commit-pin. This wrapper always runs commit-pin against the resolved
#     tag, whether the build was a cache hit or a fresh build.
#
# Usage:
#   bash scripts/skaffold-deploy.sh                          # default: workflow-builder
#   bash scripts/skaffold-deploy.sh workflow-orchestrator
#   bash scripts/skaffold-deploy.sh fn-activepieces mcp-gateway   # multiple in one go

set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"

services=("$@")
if [ "${#services[@]}" -eq 0 ]; then
  services=(workflow-builder)
fi

# Same default registry as the dev wrapper.
if [ -z "${SKAFFOLD_DEFAULT_REPO:-}" ]; then
  export SKAFFOLD_DEFAULT_REPO="gitea-ryzen.tail286401.ts.net/giteaadmin"
fi

# `skaffold build --file-output` writes JSON with the resolved tags. Use one
# file per module to keep tag↔service association unambiguous.
tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

for svc in "${services[@]}"; do
  printf '==> Building + pushing prod image for %s\n' "${svc}"
  build_out="${tmp_dir}/${svc}-build.json"
  skaffold build -m "${svc}" --push --file-output "${build_out}"

  # Parse out the fully-qualified image:tag@digest. Skaffold writes:
  # {"builds":[{"imageName":"...","tag":"...@sha256:..."}],"id":"..."}
  image=$(python3 -c '
import json, sys
data = json.load(open(sys.argv[1]))
builds = data.get("builds") or []
if not builds:
    sys.exit(f"no builds in {sys.argv[1]}")
print(builds[0]["tag"])
' "${build_out}")

  if [ -z "${image}" ]; then
    echo "skaffold-deploy: failed to parse image tag from ${build_out}" >&2
    exit 1
  fi

  printf '==> Pinning %s → %s\n' "${svc}" "${image}"
  SKAFFOLD_IMAGE="${image}" bash skaffold/hooks/commit-pin.sh "${svc}"
done

echo "==> ✓ done"
