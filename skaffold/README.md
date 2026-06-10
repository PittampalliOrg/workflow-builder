# Skaffold dev loop

This directory holds the Skaffold-based in-cluster dev loop for the
workflow-builder microservices system on the **ryzen kind cluster**. It
replaces devspace as the going-forward inner+outer loop; `devspace.yaml`
stays in-tree only as a fallback for `fn-system` (Knative) and one-off
parity checks.

There are two loops, plus the existing idpbuilder manifest sync path:

| Loop | Command | What happens |
|---|---|---|
| **Inner** | `pnpm dev:skaffold` | Build a thin dev image (Node 22 / Python 3.12 + baked deps), deploy as the workflow-builder Deployment overlay (Argo paused for the session), then file-sync `src/`/`lib/`/etc. into the running pod on every save. Vite HMRs the browser; uvicorn `--reload` restarts the Python service. |
| **Outer** | `pnpm deploy:skaffold` | Build the prod multi-stage Dockerfile, push to gitea-ryzen, then a wrapper commits the new tag into `stacks/main/.../workloads/<service>/manifests/kustomization.yaml` on **gitea-ryzen** (not GitHub origin). ArgoCD's `automated.selfHeal=true` reconciles within ~30s. |
| **Manifest sync** | `idpbuilder stacks sync` / `clu` | Snapshot the selected local stacks worktree into in-cluster Gitea, compute affected ArgoCD Applications, hard-refresh them, and wait for them to observe the pushed revision. Current idpbuilder preserves workloads image pins by default and locks one mutating sync/watch per cluster/repo/branch. Skaffold does not replace this path. |

The wrappers (`scripts/skaffold-dev.sh`, `scripts/skaffold-deploy.sh`) do
several things that bare `skaffold dev` / `skaffold run` do not. Always use
the wrappers — see *Why the wrappers* below.

## Module set

`fn-system` is excluded — it's a Knative Service (scale-to-0) and
inner-loop file-sync into a transient Knative pod is impractical. Use
the cluster's Argo-managed fn-system as a dependency, or fall back to
devspace for fn-system-specific work.

| Module | Type | Local→Container | Skaffold yaml |
|---|---|---|---|
| `workflow-builder` | SvelteKit BFF (Node 22) | 3002 → 3000 | `workflow-builder.skaffold.yaml` |
| `workflow-orchestrator` | Python/FastAPI Dapr workflow | 3013 → 8080 | `workflow-orchestrator.skaffold.yaml` |
| `function-router` | Node Express | 3014 → 8080 | `function-router.skaffold.yaml` |
| `mcp-gateway` | Node Express | 3018 → 8080 | `mcp-gateway.skaffold.yaml` |
| `swebench-coordinator` | Python/FastAPI | 3019 → 8080 | `swebench-coordinator.skaffold.yaml` |

## Daily commands

```bash
# Inner loop ---------------------------------------------------------------
pnpm dev:skaffold                              # workflow-builder (default)
pnpm dev:skaffold:orchestrator                 # workflow-orchestrator
pnpm dev:skaffold:all                          # active modules
bash scripts/skaffold-dev.sh function-router   # any single module
bash scripts/skaffold-dev.sh workflow-builder workflow-orchestrator  # subset

# Outer loop ---------------------------------------------------------------
pnpm deploy:skaffold                                # workflow-builder
pnpm deploy:skaffold:orchestrator                   # workflow-orchestrator
bash scripts/skaffold-deploy.sh function-router     # any single service
bash scripts/skaffold-deploy.sh workflow-builder workflow-orchestrator

# Status / recovery --------------------------------------------------------
pnpm skaffold:status                                # see cluster vs pinned tag drift
pnpm skaffold:doctor                                # preflight Skaffold + idpbuilder readiness
ARGO_APPS=workflow-builder bash skaffold/hooks/argo-resume.sh   # un-pause
```

## `pnpm skaffold:status`

A one-screen view of every module:

- **ARGO** — whether the gitea-ryzen ArgoCD Application is paused
  (`skip-reconcile=true`) plus its sync/health state
- **LIVE** — the image actually running on the cluster Deployment
- **PINNED** — the image+tag in the gitea-ryzen kustomization (what Argo
  would reconcile to if you un-paused)
- **DRIFT** — short label: `-` (match), `DEV` (Skaffold inner-loop image
  deployed), `DRIFT (live=… pinned=…)`, `NO PIN`, `MISSING`, or
  `NAME-MISMATCH` (kustomization `name:` doesn't match the module slug —
  `commit-pin.sh`'s regex won't match and the outer loop will silently
  no-op for that module)

Read-only. Fetches the gitea-ryzen tip into the cache clone but never
resets it. Safe to run during an active `skaffold dev` session.

## `pnpm skaffold:doctor`

A broader read-only preflight for humans and LLM coding agents. It checks:

- required local commands (`kubectl`, `skaffold`, `idpbuilder`, `git`, `python3`)
- current kubectl context (`admin@ryzen` expected)
- Skaffold module Argo pause state, live Deployment image, and gitea-ryzen pin
- the stacks checkout used by idpbuilder (`STACKS_DIR` or `/home/vpittamp/repos/PittampalliOrg/stacks/main`)
- `idpbuilder stacks status`
- whether the installed idpbuilder exposes the hardened `--seed-images` opt-in flag
- `idpbuilder stacks sync --print-refresh-plan` for the selected stacks worktree
- `clhot --ci-one-shot --check --json`

Use `pnpm --silent skaffold:doctor -- --json` or
`bash scripts/skaffold-doctor.sh --json` when an agent needs a machine-readable
decision point before starting an inner loop, resuming Argo, or asking for a
manifest sync. The doctor is intentionally read-only; it never pushes to Gitea.

## The stacks-repo lineage divergence (important)

The developer's local `stacks/main` checkout typically tracks GitHub
`origin/main`, which has a **fundamentally different lineage** from
`gitea-ryzen/main` (thousands of commits diverged — they share names but
not history). Rebasing across that divergence would replay every
gitea-ryzen commit onto GitHub's lineage and corrupt the source of truth.

The outer-loop commit-pin therefore **never touches the local
`stacks/main` checkout**. It maintains a dedicated clone at:

```
~/.cache/skaffold/stacks-ryzen
```

…tracking gitea-ryzen exclusively. Each commit-pin run:

1. `git fetch --depth 50 origin main` (where `origin` = gitea-ryzen)
2. `git reset --hard origin/main` — any local edits to this cache clone
   are discarded; it exists solely for pin edits
3. Python textual edit of the kustomization's `newName:`/`newTag:` lines
4. `git commit` + `git push origin main`
5. Annotates the ArgoCD app with `refresh=hard` to accelerate the poll

Override the cache dir with `STACKS_REPO_DIR=/abs/path` (for an alternate
checkout) or the remote with `STACKS_REMOTE_URL=…`.

This cache clone is separate from idpbuilder's sync cache. `idpbuilder stacks
sync` snapshots the chosen local stacks worktree into in-cluster Gitea and then
refreshes affected apps. Skaffold's commit-pin is narrower: it writes only the
resolved image tag for a ryzen service into `gitea-ryzen/main`. For manifest
edits, use idpbuilder/`clu`; for live source hot reload, use Skaffold; for
promoted dev/staging releases, use the GHCR release-pins and GitOps Promoter
path.

Current idpbuilder syncs preserve workloads image pins unless
`--seed-images=true` is passed explicitly. Mutating sync and watch mode also
share a nonblocking lock keyed by cluster/repo/branch, so a second mutating sync
should fail fast instead of racing. If a wait reports that sync to one commit
was superseded by another, inspect the newer Gitea tip or active watcher before
retrying.

## Why the wrappers

Bare `skaffold dev` / `skaffold run` violate several of our invariants:

| Concern | Bare skaffold | Wrapper |
|---|---|---|
| ArgoCD pause/resume | Doesn't pause — selfHeal fights Skaffold | Pauses before dev, resumes on EXIT/INT/TERM |
| Registry path | Tries `docker.io/library/<artifact>` → push denied | Exports `SKAFFOLD_DEFAULT_REPO=gitea-ryzen.../giteaadmin` |
| Cleanup on exit | `kubectl delete deployment` → 30+s outage | `--cleanup=false`; Argo's hard-refresh swaps the image back in-place |
| `skaffold run` outer loop | Also redeploys the dev overlay (which Argo immediately reverts → pod restart churn) | Uses `skaffold build` + out-of-band commit-pin |
| Cache hits skip artifact `hooks.after` | Silently misses commit-pin when re-running with the same source | Wrapper parses `build.json` and runs commit-pin unconditionally |
| Stale Argo pause from `kill -9`'d sessions | Stays paused silently for hours | Detector at session start surfaces already-paused apps + recovery hint |

## Argo pause / resume recovery

The wrapper traps `EXIT|INT|TERM` and calls `argo-resume.sh`. If Skaffold
is hard-killed (`kill -9`, terminal closes uncleanly, OOM), the trap
doesn't fire and Argo stays paused. Recovery:

```bash
ARGO_APPS="workflow-builder workflow-orchestrator" bash skaffold/hooks/argo-resume.sh
```

Both `argo-pause.sh` and `argo-resume.sh` are idempotent. After resume,
Argo's `refresh=hard` annotation triggers reconcile within seconds.

`pnpm skaffold:status` will flag any paused apps + the recovery command.

## Dev-overlay shape

Per-module overlays live at `dev/<service>/`:

```
dev/<service>/
├── kustomization.yaml      # extends ../../../../../stacks/main/.../<service>/Deployment-<service>.yaml
├── deployment-dev-patch.yaml   # strategic-merge: image, NODE_ENV, securityContext (runAsUser:0)
└── Dockerfile.dev          # FROM node:22-alpine / python:3.12-slim + baked deps
```

Load-bearing invariants:

- **The overlay extends only the Deployment file**, not the whole prod
  kustomization folder. The Application's inline `spec.source.kustomize.images`
  (docker.io→in-cluster Gitea rewrites) and ExternalSecret remoteRef
  rewrites per cluster are NOT applied by Skaffold; deploying the full
  folder would clobber Argo's render.
- **The postgres init-container image is rewritten** in the overlay's
  `images:` block to mirror the Application-level rewrite — kind-ryzen
  can't reach docker.io for the postgres image.
- **The image swap lives in the strategic-merge patch**, not in the
  overlay's `images:` block, because the parent prod kustomization
  already rewrote `<service>` → `ghcr.io/.../<service>:git-<sha>` before
  our child overlay runs.
- **`runAsUser: 0` + `runAsNonRoot: false`** so `pnpm install` / pip
  install can write under `/app`. Triggers a benign PodSecurity
  `restricted:latest` warning at apply time.
- **`replicas: 1`** during dev — the Application's `ignoreDifferences`
  on `/spec/replicas` already allows this.
- **`--load-restrictor=LoadRestrictionsNone`** is required because the
  overlay's `resources:` references `../../../../../stacks/main/...`;
  the flag is passed via `manifests.kustomize.buildArgs`.

## Gotchas

- **`stacks/main` is a git worktree.** `.git` is a file, not a directory.
  Don't use `[ -d "$stacks_dir/.git" ]` to check repo presence; use
  `git rev-parse --git-dir`.
- **`gitCommit:AbbrevCommitSha` tag policy is intentional.** `inputDigest`
  is the natural fit but Skaffold v2.17 mis-parses repos with
  allowlist-style `.dockerignore` and errors before docker even sees the
  context. The `gitCommit` policy ignores uncommitted changes (`ignoreChanges:
  true`) — the image tag stays stable across a dev session, and file-sync
  picks up the actual edits.
- **`context: .` in a module yaml resolves to `skaffold/`**, not the repo
  root. Each module uses `context: ..` and adjusts `dockerfile:`
  accordingly so the build context = `workflow-builder/main/`.
- **PodSecurity warning at apply time is expected.** Don't try to "fix"
  by going non-root — the dev container needs root for hot-reload.
- **The dev image is push-required even on a local kind cluster.** kind
  nodes have their own containerd image store; `kind load docker-image`
  isn't wired into our Skaffold flow.
- **fn-system is Knative-only.** It appears as
  `deploy/fn-system-00001-deployment` scaled 0/0, not `deploy/fn-system`.
  Treat the Argo-managed fn-system as a stable dependency, or fall back
  to devspace.

## Related docs

- `CLAUDE.md` (repo root) — quick-reference summary of the Skaffold
  module set + service ports + outer-loop wrapper details
- `~/.claude/skills/skaffold-dev-loop/SKILL.md` — operator-facing skill
  for AI-driven dev-loop work
- `~/.claude/skills/skaffold-dev-loop/references/workflow-builder.md` —
  concrete recipes + recovery commands
