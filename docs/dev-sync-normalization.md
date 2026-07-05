# Dev-sync normalization + contract loop (B2 / B4)

Extends the agentic dev loop (`docs/agentic-deploy-inspect-loop.md`) so the
`dev-sync-sidecar` — not the BFF's in-process Vite plugin — is THE dev-loop
transport for every microservice, and so a TS↔Python **workflow-data contract**
change can be edited and re-checked inside a live preview in seconds.

## The sidecar is the mechanism

`services/dev-sync-sidecar/server.mjs` is a language-agnostic sidecar that shares
an `emptyDir` at the dev pod's workdir. It now serves the full surface the Vite
plugin only gave the BFF (all token-gated with `x-sync-token`, like `/__sync`; no
new trust boundary — `/__sync` already delivers code the dev server executes):

| Endpoint | Purpose |
|---|---|
| `POST /__sync` | untar an uploaded `tar.gz` into the workdir → inotify → HMR (unchanged) |
| `GET /__export?paths=…` | stream a `tar.gz` of the live workdir source — **version capture parity** (`captureDevPreviewSource` guards on the gzip magic bytes, so the wire format matches the plugin: `tar -czf -`, busybox-relative; non-existent paths are filtered first) |
| `GET /__status` | `{lastSyncAt, lastSyncBytes, lastRun, commands}` diagnostics |
| `POST /__run?cmd=<name>` | run an **allowlisted** named command in the workdir; output capped, exit code returned. The allowlist is `DEV_SYNC_COMMANDS_JSON` (parsed once at boot); an unknown name 404s, a malformed allowlist fails closed |

`DEV_SYNC_COMMANDS_JSON` is stamped by `sandbox-execution-api` from the dev-preview
registry: the reserved name `deps` = `depsCommand`, plus each `testCommands` entry
under its own name. The sidecar never runs an arbitrary command string from a
request.

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
  proven pattern BUT SEA *is* the provisioner: if its dev pod dies mid-session
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
