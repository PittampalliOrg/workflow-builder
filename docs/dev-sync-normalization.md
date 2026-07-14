# Dev-sync normalization + contract loop (B2 / B4)

For the current end-to-end agent workflow, strict multi-service capture,
GitHub promotion, and immutable acceptance replay, start with
[`preview-environment-agent-development.md`](preview-environment-agent-development.md).
This document remains the detailed transport and contract-loop reference.
For the HMR filesystem transaction, measured latency, and follow-up thresholds,
see [`dev-sync-hmr-latency.md`](dev-sync-hmr-latency.md).

Extends the agentic dev loop (`docs/agentic-deploy-inspect-loop.md`) so the
`dev-sync-sidecar` — not the BFF's in-process Vite plugin — is THE dev-loop
transport for every microservice, and so a TS↔Python **workflow-data contract**
change can be edited and re-checked inside a live preview in seconds.

## The sidecar is the mechanism

`services/dev-sync-sidecar/server.mjs` is a language-agnostic sidecar that shares
an `emptyDir` at the dev pod's workdir. It now serves the full surface the Vite
plugin only gave the BFF (all token-gated with `x-sync-token`, like `/__sync`; no
new trust boundary — `/__sync` already delivers code the dev server executes):

| Endpoint                 | Purpose                                                                                                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /__sync`           | untar an uploaded `tar.gz` into the workdir → inotify → HMR (unchanged)                                                                                                                                                                                                                       |
| `GET /__export?paths=…`  | stream a `tar.gz` of the live workdir source — **version capture parity** (`captureDevPreviewSource` guards on the gzip magic bytes, so the wire format matches the plugin: `tar -czf -`, busybox-relative; non-existent paths are filtered first)                                            |
| `GET /__status`          | `{lastSyncAt, lastSyncBytes, lastSyncTimingsMs, lastRun, commands}` diagnostics (`lastSyncTimingsMs` reports receiver validation/staging/planning/commit/total; `lastRun.executedIn` says where the last `/__run` executed)                                                                         |
| `POST /__run?cmd=<name>` | run an **allowlisted** named command in the workdir; output capped, exit code returned. The allowlist is `DEV_SYNC_COMMANDS_JSON` (parsed once at boot); an unknown name 404s, a malformed allowlist fails closed. Executes in the **app container** via the exec bridge when present (below) |

`DEV_SYNC_COMMANDS_JSON` is stamped by `sandbox-execution-api` from the dev-preview
registry: the reserved name `deps` = `depsCommand`, plus each `testCommands` entry
under its own name. The sidecar never runs an arbitrary command string from a
request.

For workflow-builder, `cmd=migrate` runs the allowlisted
`node scripts/db-migrate-runtime.mjs` against the preview-local `DATABASE_URL`.
This is the explicit follow-up to hot-syncing `drizzle/`; the migration ledger
and PostgreSQL advisory lock make repeated or concurrent calls idempotent.

## `/__run` executes in the APP container — the exec bridge (#40)

**The problem (live repro 2026-07-05):** the sidecar image is node-only, so a
`/__run` executed _in the sidecar container_ runs in the wrong runtime — the
orchestrator's `cmd=contract` exited 127 (`sh: python: not found`); the node
services' `deps` (`pnpm install`) had the same class of problem (no pnpm in the
sidecar). The commands belong in the **app container**, where the service's
real toolchain (python/pytest, pnpm + the pod's `node_modules`) lives.

**The mechanism:** every dev image (`skaffold/dev/<svc>/Dockerfile.dev`) now
bakes a ~150-line stdlib-only **exec bridge** at `/devtools/` —
`services/dev-sync-sidecar/exec-bridge.mjs` for node images,
`exec_bridge.py` for python images (twin contracts, shared tests) — and starts
it as a **background child of the entrypoint** (`bridge & exec <dev server>`;
the dev server stays PID 1, a bridge crash never takes it down). The bridge:

- listens on **127.0.0.1:8002** ONLY (`DEV_SYNC_EXEC_PORT`) — pod-local by
  construction, never reachable from outside the pod;
- requires the shared sync token (`x-sync-token` = `DEV_SYNC_TOKEN`) when set;
- runs ONLY the named entries of **its own** `DEV_SYNC_COMMANDS_JSON` copy,
  cwd = `DEV_SYNC_DEST` — absent/malformed env → every `/__exec` 404s
  (fail-closed, so plain `skaffold dev` pods are unaffected);
- `POST /__exec?cmd=<name>` answers the same shape as `/__run`:
  `{ok, cmd, exitCode, durationMs, truncated, output}`.

SEA (`build_dev_preview_sandbox_manifest`) stamps `DEV_SYNC_EXEC_PORT`,
`DEV_SYNC_DEST`, `DEV_SYNC_TOKEN`, and `DEV_SYNC_COMMANDS_JSON` into the **app
container** in sidecar mode (previously only the sidecar got them), plus
`DEV_SYNC_EXEC_PORT` into the sidecar (the proxy target).

**Proxy + fallback semantics (`executedIn`):** the sidecar's `/__run` first
POSTs the command **name** to the bridge over pod-localhost.

- Bridge answers 200 → that IS the result; response carries
  `"executedIn": "app"`.
- Bridge unreachable (image predates the bridge) or refuses with a non-200
  (401/404/500-spawn — the command provably did NOT run) → the sidecar runs the
  command locally as before and says so: `"executedIn": "sidecar"` plus a
  `bridge: "<why>"` note.
- Bridge accepted (200) but the response broke mid-body → reported as an error
  with NO local fallback: the command may already have run, and double-running
  a `deps` install or test lane is worse than a surfaced broken response.

Callers (BFF `runSidecarCommand`, the dev-environments run route) pass
`executedIn` through; treat `"sidecar"` on a python service as the
old-image signature.

**Rollout (lead actions — pin bumps are manual for the sidecar):**

1. The **dev-sync-sidecar image is NOT rebuilt by any lane** — rebuild via a
   one-off hub TaskRun (precedent: git-d6d13218, stacks#3555) and bump the pin
   sites in stacks for the `/__run` proxy + restart-signal writer to go live.
2. The **dev images** need one manual `outer-loop-dev-images` PipelineRun fire
   (workspaces: `shared-workspace` emptyDir + `dockerconfig`
   ghcr-push-credentials) — it auto-commits the dev-preview pins.
3. The **SEA image** rolls via the normal outer loop (the app-container env
   stamping rides it).

Mixed versions degrade cleanly: old sidecar + new images = old behavior
(bridge idle); new sidecar + old images = fallback to `executedIn:"sidecar"`;
new sidecar + old SEA = the bridge has no allowlist env → 404 → fallback.

## Route-add restart signal (#41, sidecar side)

A `/__sync` that ADDS files under `src/routes/` while the dev server is
mid-restart lands on disk but never registers (the replaced watcher misses the
`add` event — verified live: even `touch` fired nothing afterwards). The
sidecar can't restart the dev server in another container (and killing PID 1 in
a vcluster-synced pod wedges the container ready=false), so:

- the sidecar pre-lists each sync tar (`tar -tzf`) and, when it added new
  `src/routes/` files, writes **`.dev-sync-restart-request.json`** into the
  workdir (`{requestedAt, addedRoutes}`) and reports
  `routesAdded`/`restartSignaled` in the `/__sync` response;
- the BFF's Vite plugin **polls** that file every 2s (`fs.stat`, not a watcher —
  watchers are exactly what the restart window breaks), **deletes it first**
  (consume-then-restart → no loop), then calls `server.restart()`. The poll is
  armed by `WFB_DEV_SYNC_RESTART_SIGNAL` (stamped by SEA in sidecar mode);
  plugin-mode syncs restart in-process without the file (see
  `docs/pr-previews.md`).
- Python dev servers ignore the signal file (uvicorn's new-file gap is a
  separate, milder issue — `--reload` picks up edits to existing files).

The detection helper is `src/lib/server/dev-sync/added-routes.ts` (unit-tested;
the sidecar keeps an inline twin covered by its node:test e2e).

## Registry additions (`src/lib/server/workflows/dev-preview-registry.ts`)

- `language: "node" | "python"` + **default syncPaths** (`DEFAULT_SYNC_PATHS`) applied
  when a descriptor omits `syncPaths` (node `["src","config"]`, python
  `["app.py","src","core","activities","workflows","tests"]`). Safe: sync + export
  filter non-existent paths, so a superset default is harmless.
- `depsCommand`, `testCommands`, `extraSync` (see below), resolved by
  `devPreviewSyncPaths()` / `devPreviewCommands()`.
- **Sidecar-transport flag**: `WFB_DEV_SYNC_MODE=sidecar` flips a plugin-mode service
  (the BFF) to sidecar transport in `resolveDevPreviewDescriptor()` — the dev image's
  own Vite server stays the HMR engine; the sidecar becomes the `/__sync` + `/__export`
  transport into the shared `emptyDir`. Default (unset) keeps today's plugin path
  (parallel rollout). NOTE the boot cost: BFF sidecar mode seeds the baked `/app`
  (incl. `node_modules`, ~1–2 GiB) into the `emptyDir` via the existing `seed-workdir`
  init — size the preview class `ephemeral-storage` accordingly (a live-pass item).
- New services: `mcp-gateway` (dev image exists) and `workflow-mcp-server` (new
  `skaffold/dev/workflow-mcp-server/Dockerfile.dev`), both sidecar mode, node, no
  stacks pin yet (`:latest` fallback like `swebench-coordinator`).

### Adopt-path notes (not wired tonight)

- **mcp-gateway** prod manifests DO exist in stacks
  (`packages/components/workloads/mcp-gateway/manifests/Deployment-mcp-gateway.yaml`,
  referenced by `skaffold/dev/mcp-gateway/kustomization.yaml`), so a future
  preview-native adopt path is available — no new app-overlay resources were added
  tonight.
- **workflow-mcp-server** needs `DATABASE_URL` to boot; the registry entry is a
  plain sidecar dev pod (no `functional`/`envFrom`), so a functional/adopt preview
  must wire the prod secret via `envFrom` — a live-pass item.
- **sandbox-execution-api self-adopt** (SEA developing itself in a preview) is a
  proven pattern BUT SEA _is_ the provisioner: if its dev pod dies mid-session
  there is no restorer, and `vcluster delete` is the only backstop. Not added to
  the registry tonight — document + decide before enabling.
- **fn-system** is Knative (immutable revisions), not adoptable by the dev-pod
  replace model — skip; it stays on the outer loop.

## The dependency-change lane (B3a)

`scripts/dev-sync/sync.sh` (committed, shellcheck/unit-tested; the workflow copies it
into `/sandbox/work/sync.sh`) hashes the present dep manifests
(`package.json`/`pnpm-lock.yaml`/`.npmrc` for node; `requirements.txt`/`pyproject.toml`/`uv.lock`
for python) after each sync. On a change it POSTs `/__run?cmd=deps`; the sidecar runs
the install in the **pod-local workdir** (`emptyDir`/image FS) — **never** on the
JuiceFS shared workspace (small-file installs there are ~11 min). The first sync
records a baseline without installing (a main-clone matches the baked image); a PR-head
with new deps needs one explicit `/__run?cmd=deps` (wired by D1 later).

deps commands: BFF `pnpm install --no-frozen-lockfile`; orchestrator
`pip install -r requirements.txt && touch /app/app.py`; function-router / mcp-gateway /
workflow-mcp-server `pnpm install --no-frozen-lockfile && touch src/index.ts`.

## The contract-change loop (B4 — the hexagonal payoff)

The shared `services/shared/workflow-data-contract/fixtures` pin the workflow-data wire
boundary. The dev images now bake them and both sides can re-check a fixture edit in
seconds:

- **BFF** dev image bakes `services/shared/workflow-data-contract`; registry
  `syncPaths += services/shared/workflow-data-contract` re-syncs live edits to
  `/app/...` (where the contract vitest reads them via `process.cwd()`).
- **Orchestrator** dev image bakes the fixtures at `/app/.contract-fixtures` + installs
  `pytest` + sets `WORKFLOW_DATA_CONTRACT_FIXTURE_DIR=/app/.contract-fixtures/fixtures`
  (the migration pytest reads that env override); registry
  `extraSync: [{from:"../shared/workflow-data-contract", to:".contract-fixtures"}]` so
  the sync client stages a live fixture edit into the same dir.
- `testCommands.contract`: BFF
  `node_modules/.bin/vitest run src/routes/api/internal/workflow-data/workflow-data-contract.test.ts`;
  orchestrator `python -m pytest tests/test_workflow_data_activity_migration.py -q`.

### Agent loop

1. In a multi-service `microservice-dev-session` (BFF + orchestrator adopted), edit
   BOTH sides of the boundary AND the shared fixture under
   `services/shared/workflow-data-contract/fixtures`.
2. `/sandbox/work/sync.sh` — pushes source + stages the contract fixtures into each pod
   (and auto-installs deps if a manifest changed).
3. Run the fast contract check on BOTH pods (seconds):
   `curl -X POST "<syncUrl-with-/__sync→/__run>?cmd=contract"` — the BFF vitest and the
   orchestrator pytest each replay the shared fixtures.
4. e2e via the preview's deterministic data-plane smoke webhook.

## Live-validation runbooks

### A. Sidecar-transport flip (BFF) + ephemeral-storage sizing

1. Provision a `workflow-builder` preview-native adopt with `WFB_DEV_SYNC_MODE=sidecar`
   on the dev BFF (set the env on the standing dev `workflow-builder` deployment, or
   pass it in the provision path). Confirm the dev pod comes up with a `dev-sync`
   container + the `seed-workdir` init that copies the baked `/app` (incl.
   `node_modules`) into the `emptyDir`.
2. Measure the **boot delta** vs plugin mode (the seed copy of ~1–2 GiB) and watch
   `kubectl describe pod` for `ephemeral-storage` pressure / eviction. If evicted,
   raise the dev-preview class `serviceEphemeralStorage` (currently ~2Gi) in the
   preview `CLASSES_JSON` and re-provision.
3. Edit `src/…` in the agent workspace → `sync.sh` → confirm HMR still lands via the
   sidecar (`/__sync` on 8001) and the tailnet URL serves the edit. Confirm
   `GET /__export` returns a gzip tar and `captureDevPreviewSource` stores a promotable
   version.

### B. Contract loop on a preview

1. Multi-service provision (`services: ["workflow-builder","workflow-orchestrator"]`,
   `mode: preview-native`) so both prods scale to 0 behind their dev pods.
2. Edit a fixture under `services/shared/workflow-data-contract/fixtures` plus the BFF
   route and the orchestrator activity that consume it.
3. `sync.sh` → then on each pod:
   `curl -X POST "http://<podIP>:8001/__run?cmd=contract"` (orchestrator) and the BFF's
   `/__run?cmd=contract`. Both should return `{ok:true, exitCode:0}` in seconds.
4. Mutate the fixture to an incompatible shape → both `contract` runs should go
   `ok:false` (the boundary catches the drift before promotion).
5. e2e: fire the preview's deterministic data-plane smoke webhook and confirm the run
   completes through the adopted strict-mode stack.
