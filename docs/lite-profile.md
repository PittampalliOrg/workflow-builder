# Lite profile (`APP_PROFILE=lite`)

Status: 2026-07-04.

The lite profile is the innermost dev loop: the full BFF application core running
with **no cluster and no external services**. It is the same hexagonal app as
production — only the outermost adapters change, selected by config.

## What runs

| Family | Full profile | Lite profile |
|---|---|---|
| Persistence | Postgres (postgres-js) | Postgres adapter on embedded **PGlite** (WASM, in-process) |
| Event bus | Dapr pub/sub | `InProcessEventBus` (EventEmitter + ring buffer) |
| Workflow scheduler | Dapr workflow (Python orchestrator) | `LiteStubWorkflowScheduler` (does **not** execute) |
| Artifact store | Postgres | Postgres (unchanged — the driver handles it) |

The ~60 `Postgres*` repositories are **unchanged**: they flow through the `db`/`sql`
pair in `src/lib/server/db/index.ts`, which selects the PGlite driver in lite. See
`src/lib/server/db/pglite-compat.ts`.

Adapter selection lives in `src/lib/server/application/config.ts`: under
`APP_PROFILE=lite` the event-bus and scheduler families default to their in-process
members. An explicit `EVENT_BUS_ADAPTER` / `WORKFLOW_SCHEDULER_ADAPTER` still wins,
and unknown values still throw.

## What lite can and cannot do

- **Can**: sign in, browse workspaces, full CRUD on workflows/agents/settings,
  everything backed by Postgres. Data persists across restarts (on-disk data dir).
- **Cannot**: execute a workflow. Durable SW workflows run in the Python
  orchestrator under Dapr placement, which lite does not run. Starting one returns a
  `lite-`-prefixed instance id and the run surfaces an explicit *"requires a preview
  environment"* terminal state instead of sitting in `running` forever. This is a
  deliberate honest stub — lite never fakes activity execution.

## Schema

Lite owns its schema via `drizzle-kit push` of `schema.ts` head. Drizzle is the
**single schema owner** across all modes: the postgres path applies drizzle
migrations out-of-band via the `db-migrate` init container (`pnpm db:migrate`)
before the app boots, and lite pushes `schema.ts` head. The old in-app
`atlas/migrations` startup pass — a drifted secondary tracker (missing tables/columns
vs head, some files failing even on real Postgres) — has been retired; `atlas/*.sql`
is kept only as history. Boot now runs only idempotent data backfills, never schema.

## Commands

```sh
pnpm dev:lite        # push schema + seed (fresh dir) + vite dev, APP_PROFILE=lite
pnpm db:push-lite    # (re)build the schema from schema.ts into .pglite-data
pnpm seed:lite       # seed a dev user / project / sample workflow
pnpm db:reset-lite   # rm -rf .pglite-data .pglite-keys
pnpm spike:pglite    # driver + LISTEN/NOTIFY compatibility spike
pnpm gate            # the fast pre-preview contract gate (see below)
```

`dev:lite` mints a dev RSA keypair so password sign-in works (seeded user
`dev@workflow-builder.local` / `devpassword`) and sets `OTEL_SDK_DISABLED=true` so
off-cluster boots make no OTLP egress noise. `.pglite-data/` and `.pglite-keys/` are
gitignored. PGlite is single-connection/single-process — do not run two openers
against the same data dir at once.

## `pnpm gate`

`scripts/lite-gate.sh` — the fast contract gate to run before requesting a preview
(warm target < 2 min):

1. TS workflow-data contract fixtures (`vitest`),
2. orchestrator workflow-data contract fixtures (`uv run pytest`, Dapr-free),
3. `dependency-cruiser` boundary check.

`pnpm gate --full` runs the whole unit + orchestrator suites instead (matches CI's
`pr-checks.yml`).
