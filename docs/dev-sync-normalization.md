# Dev-Sync Transport And Contract Loop

`dev-sync-sidecar` is the scoped source transport for preview-native services.
The application process remains the reload/HMR engine; the sidecar owns
generation-fenced writes, source read-back, diagnostics, and named command
dispatch into the adopted pod.

For lifecycle operation, start with
[Preview environments](preview-environments.md). For filesystem transaction
details and measured HMR behavior, see
[Dev-sync HMR latency architecture](dev-sync-hmr-latency.md).

## HTTP Surface

Every endpoint is capability-gated with `x-sync-token`.

| Endpoint                 | Purpose                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `POST /__sync`           | Validate and apply one gzip-tar source generation to the exact declared roots.                          |
| `POST /__freeze`         | Freeze a retained receiver so later sync generations are rejected.                                      |
| `GET /__export`          | Stream the current receiver-owned source as a gzip tar for capture or workspace seed.                   |
| `GET /__status`          | Return the accepted generation, source-diff authority, timings, last command result, and command names. |
| `POST /__run?cmd=<name>` | Run one catalog-allowlisted command in the application container.                                       |
| `GET /healthz`           | Sidecar health only; application health remains service-specific.                                       |

The sidecar never accepts a caller-supplied shell command. SEA builds
`DEV_SYNC_COMMANDS_JSON` from the service descriptor: reserved command `deps`
comes from `depsCommand`, and every other name comes from `testCommands`.
Missing or malformed command configuration fails closed.

## Generation Contract

The producer sends a complete snapshot of each catalog-owned source root and
binds it to one generation. The receiver validates archive members, size,
types, service identity, root set, and generation before changing live source.
Replay of the same generation and digest is idempotent; reuse with different
bytes is rejected.

`scripts/dev-sync/sync.sh` serializes one workspace producer, prepares every
service archive before the first write, and applies the same generation to all
selected receivers. Success requires:

```text
APPLIED service=<service> generation=<generation> ...
APPLIED service=<service> generation=<generation> ...
SYNCED generation=<generation> services=<count> convergence=healthy
```

The exact `APPLIED` fields are receiver diagnostics and may grow. The global
`SYNCED` receipt is stable convergence authority. A partial service set, mixed
generation, failed health barrier, or missing receiver status must not be
captured.

Source scope is also receiver-owned. Gate and capture code reads `/__status`
for the accepted generation instead of trusting the helper checkout, which can
be clean or stale independently of live pod source.

## Filesystem Transaction

The receiver stages a complete snapshot in a hidden pod-local transaction area,
computes a deterministic add/replace/delete/mode plan, and atomically replaces
only changed paths. Matching directories and files keep their inodes, avoiding
a tree-wide watcher event for one source edit.

The generation marker is persisted last. A failed commit restores changes in
reverse order and withholds the generation. Changed-path output and phase
timings are bounded. New route files use the explicit restart signal described
below; ordinary edits remain HMR/reload events and must not replace the adopted
pod.

## Application-Container Commands

Node and Python development images include equivalent loopback-only exec
bridges. The sidecar sends only the allowlisted command name to
`127.0.0.1:${DEV_SYNC_EXEC_PORT:-8002}`; the application container enforces its
own copy of the allowlist and runs from `DEV_SYNC_DEST` with its actual
toolchain.

A successful response reports `executedIn: "app"`. Bridge unavailability,
unknown commands, authentication errors, and spawn failures fail closed for
preview-native services. `DEV_SYNC_ALLOW_LOCAL_RUN` exists only for explicitly
configured legacy images; it must not be enabled as a preview-native fallback.
A response that breaks after command acceptance is reported as failure and is
never retried locally because the command may already have run.

This boundary keeps Python, pnpm, migration, and test commands out of the
node-only sidecar image while avoiding pod-exec or Kubernetes authority.

## Catalog Contract

`src/lib/server/workflows/dev-preview-registry.ts` defines each service's:

- repository subdirectory and sync roots;
- source and capture-only mappings;
- development image and reload mode;
- dependency command and named tests;
- health route, Dapr identity, and preview-native workload adoption;
- required environment and secret projections.

The generated cross-repository contract is
`services/shared/dev-preview-service-catalog.json`. Its digest is bound into the
`PreviewEnvironment`, development target, capture, promotion, and teardown
receipts. Regenerate the stacks mirror through the normal catalog/render path;
never maintain a second hand-written service list.

Current preview-native services are `workflow-builder`,
`workflow-orchestrator`, `function-router`, `mcp-gateway`, and
`workflow-mcp-server`. Services without a catalog `testCommands` entry use
health checks only; callers must not invent a `/__run` probe.

## Dependency Changes

After a successful source sync, `sync.sh` hashes dependency manifests present
for each service. The first generation establishes a baseline. A later manifest
change invokes the allowlisted `deps` command in that service's application
container, on its pod-local workdir rather than the shared JuiceFS workspace.

Node services install from `package.json`, `pnpm-lock.yaml`, and `.npmrc` when
present. Python services use their declared requirements, `pyproject.toml`, or
`uv.lock` inputs. Each descriptor owns the exact command and any reload touch;
the producer does not infer package-manager commands.

## Workflow-Data Contract Loop

The shared fixtures in
`services/shared/workflow-data-contract/fixtures` pin the TypeScript/Python wire
boundary.

For a two-service workflow-builder/orchestrator change:

1. edit both implementations and the shared fixture in the seeded checkout;
2. run `/sandbox/work/sync.sh` once;
3. require shared-generation convergence;
4. call each service's catalog `contract` command through `/__run`;
5. require both fixture suites to pass before route smoke or capture.

The Workflow Builder lane runs the focused Vitest contract suite. The
orchestrator lane runs the focused Python migration/contract suite against the
same synced fixtures. An intentionally incompatible fixture should fail both
lanes, proving the boundary catches drift before promotion.

## New Route Restart

A newly added SvelteKit route may arrive while Vite is restarting and miss its
watcher event. The sidecar detects new `src/routes/` members while planning a
generation, writes `.dev-sync-restart-request.json`, and reports
`routesAdded`/`restartSignaled`.

The Workflow Builder Vite adapter polls and consumes that file before one
intentional restart. Existing-route edits do not emit the signal. Python
services continue to use their configured reload process.

## Validation

```bash
node --test services/dev-sync-sidecar/server.test.mjs
node --test services/dev-sync-sidecar/exec-bridge.test.mjs
node --test scripts/dev-sync/sync.test.mjs
pnpm exec vitest run \
  src/lib/server/dev-sync/atomic-sync.test.ts \
  src/lib/server/dev-sync/added-routes.test.ts \
  src/lib/server/dev-sync/capability.test.ts
pnpm catalog:dev-preview:check
```

For a wet proof, keep the adopted pod UID and application-process restart count
stable for an ordinary edit, require one shared generation across every
selected receiver, verify service health and named probes, then capture that
same generation. A build, pod replacement, mixed generation, or helper-only
diff is not HMR proof.
