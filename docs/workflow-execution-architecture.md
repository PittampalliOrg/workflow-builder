# Workflow Execution Architecture — Current System & Workflows-as-Code Options

> **Purpose:** Document how workflow-builder currently persists and executes workflow definitions, compare
> it against a Dapr "workflows-as-code" model, and lay out the options explored for adding code-defined
> workflows — with the pros and cons of each — so the team can decide a direction.
>
> **Status:** Reference/decision document. No code or infrastructure has been changed.
>
> **Scope note on the question "can we create workflows at runtime?":** answered per-option in §3; the
> short version is that the current interpreter already does this, and pure Dapr workflows-as-code
> fundamentally cannot (see §2).

---

## 0. Executive summary

**The current system.** Workflow logic is stored as **data** — a CNCF Serverless Workflow (SW) 1.0 document
in Postgres (`workflows.spec`) — and executed by a **single, generic Dapr workflow** (`sw_workflow_v1`)
that interprets that document at runtime. Creating or editing a workflow is a plain database write: no code
change, no image build, no redeploy. The AI assistant and the visual canvas both author specs this way.

**The key constraint that frames everything.** Dapr's SDK (`dapr-ext-workflow 1.17.1`) requires *every*
workflow to be registered **before** `WorkflowRuntime.start()`; you cannot add a workflow to a running
worker (`app.py:1140-1152`). So **pure "workflows-as-code" inherently means code → image build → redeploy,
and can never create workflows at runtime.** The data-driven interpreter exists precisely to sidestep this:
register one generic workflow, feed definitions in as data. A full replacement of the interpreter with pure
code would *lose* runtime creation, multiply deployables, and discard the canvas/AI authoring — so the
real question is what to **add alongside** the interpreter, not what to replace.

**The four options explored (detail + pros/cons in §3):**
- **A — Extend the interpreter (data stays data).** Close the genuine gaps inside the model: real parallel
  fork via `when_all` (it's sequential today — a self-imposed gap, not a Dapr one), the existing
  `code/<slug>` escape hatch for arbitrary logic, and a `workflow_versions` table for fast version listing.
  *Keeps runtime creation; no new infra.* Effort **M**.
- **B — Git-native Dapr code workflows, in a separate deployment.** Engineers hand-write real `@workflow`
  functions in git, registered at startup, listed via a manifest, dispatched by name, coexisting in the UI
  via `engineType`. *Most expressive and best-governed (git PR/blame), but no runtime creation — redeploy
  to ship.* Effort **L**.
- **C1 — DB-stored code, activate-on-reload.** Store source in a `code_workflows` table; register at boot;
  changes go live after a pod restart. *No image build, but a rollout, and weaker governance than git.*
  Effort **L**.
- **C2 — Generic exec-interpreter.** One registered workflow `exec()`s stored code inside the durable
  context — *true* runtime-created code. *But determinism + `exec()` security make it unsafe for arbitrary
  Python; constrained to emitter output it merely re-skins the interpreter.* Effort **L–XL**.

**At a glance:**

| | A: Extend interpreter | B: Git-native code | C1: DB + reload | C2: Generic exec |
|---|---|---|---|---|
| Runtime creation (no redeploy) | ✅ | ❌ | ⚠️ rollout | ✅ (risky) |
| Expressiveness vs interpreter | = (+ real parallel) | **strictly more** | strictly more | code skin |
| Determinism safety | ✅ by construction | ⚠️ per-author | ⚠️ per-author | ❌ / ⚠️ |
| Governance | spec review | **git PR/blame** | weak | weak |
| New infra | none | one isolated deploy | migration + deploy | deploy + sandbox |
| Effort | M | L | L | L–XL |

**Independent of any choice:** raise `workflowstatestore maxConns` (currently **16**) toward the configured
`maxConcurrentWorkflowInvocations=128` / `maxConcurrentActivityInvocations=512` — it throttles fan-out today.

---

## 1. The current system — data-driven CNCF Serverless Workflow (SW) 1.0 interpreter

### 1.1 One-paragraph model
Workflow logic is stored as **data** (a CNCF Serverless Workflow 1.0 document) in Postgres, and executed by
a **single, generic Dapr workflow** that *interprets* that document at runtime. The orchestrator registers
exactly one workflow function (`sw_workflow_v1`) at startup and feeds each workflow's spec in as input. New
or edited workflows are plain database writes — no code change, no image build, no redeploy.

### 1.2 Storage model (SSOT = `workflows.spec`)
`src/lib/server/db/schema.ts:149` — the `workflows` table:
- `spec` (JSONB) — the SW 1.0 document `{document:{dsl:'1.0.0',namespace,name,version}, do:[…tasks], input?}`. **Execution source of truth.**
- `nodes` / `edges` (JSONB) — redundant SvelteFlow canvas state, rebuildable from `spec` via `specToGraph` (`src/lib/utils/spec-graph-adapter.ts`).
- Published versions are append-only snapshots inside `spec.metadata.publishedRuntime.revisions[]` — **no normalized versions table**; `specVersion` column exists but is unused.
- Per run, `workflow_executions` stores `executionIr = {spec, triggerData}` — a *frozen* audit copy (never read back to re-run).

### 1.3 Authoring & lifecycle
- **Create:** `POST /api/workflows`. **Update:** `PUT /api/workflows/[id]` persists `{nodes,edges,spec}`. **Publish:** `POST …/publish` appends a revision into `spec.metadata`. **List:** `GET /api/workflows` (fast, metadata-only — does not load the spec).
- Canvas edits mutate `spec.do` directly (`src/lib/helpers/spec-mutations.ts`); the graph is a *view* of the spec, not a parallel source of truth.

### 1.4 Execution path
`src/routes/api/workflows/[workflowId]/execute/+server.ts`:
1. Read `workflows.spec`, validate `document.dsl==='1.0.0'`, resolve named-agent refs, validate trigger inputs.
2. Insert a `workflow_executions` row.
3. **POST the entire spec inline** to the orchestrator `POST /api/v2/sw-workflows` `{workflow: spec, workflowId, triggerData, dbExecutionId, …}`.
4. Orchestrator (`app.py:1140`) has registered exactly one workflow — `wfr.register_versioned_workflow(sw_workflow, name=SW_WORKFLOW_NAME, version_name='1.0.0')` — then `wfr.start()` (`:1152`). Activities are auto-discovered into `ACTIVITIES` (`activities/__init__.py`).
5. The interpreter `sw_workflow` (`workflows/sw_workflow.py:3178`) walks `spec.do`, classifies each task (all 12 SW 1.0 types: `call/do/emit/for/fork/listen/raise/run/set/switch/try/wait`), and dispatches:
   - `ctx.call_activity(execute_action, …)` → function-router → `fn-system / fn-activepieces / code-runtime / openshell`, **or**
   - `ctx.call_child_workflow('session_workflow', app_id=<runtime>)` for `durable/run` agent steps (`sw_workflow.py:1838`, cross-app-id to a per-session agent runtime).
   - `${…}` jq/CEL expressions resolve against `{input, state, workflow, prior task outputs}`.

### 1.5 Existing "code" surfaces (today)
- **Export-only code-emitter** (`src/lib/server/workflows/code-emitter/`): converts a spec into a TS/Python *script* bound to a hand-written `runtime.{py,ts}` shim (`WorkflowContext.call_activity/sleep/jq`). `GET …/export` downloads it; `POST …/export` snapshots it into a `code_functions` row. **Not an execution path** — a portable artifact. Notably, the shim surface is shaped *exactly* like a durable workflow context (relevant in §3-B/C).
- **Stored-code activities:** `code_functions` + `code_function_revisions` (versioned source, `supporting_files`, `composition_graph`), executed by `services/code-runtime` (Node `execFile`) as `code/<slug>` **activities** — single-shot units, the existing escape hatch to arbitrary logic *inside* an interpreted workflow.

### 1.6 Infrastructure (stacks:main)
- `workflow-orchestrator` Deployment: 2 replicas, `dapr.io/app-id: workflow-orchestrator`, `dapr.io/enable-workflow: true`, `dapr.io/config: workflow-orchestrator-no-tracing`. Has self-restart RBAC (`Role/RoleBinding-workflow-orchestrator-pod-restart`).
- `Configuration-workflow-orchestrator-no-tracing.yaml`: `WorkflowsRemoteActivityReminder=enabled`, `maxConcurrentWorkflowInvocations=128`, `maxConcurrentActivityInvocations=512`, `stateRetentionPolicy=168h`.
- `Component-workflowstatestore.yaml`: Postgres actor state store (`actorStateStore=true`, prefix `wfstate_*`), **unscoped** (any app-id may use it). **`maxConns=16`** — a known bottleneck against the 128/512 concurrency.
- Single `dapr-placement-server` (`replicationFactor=100`); PgBouncer in front of Postgres. Per-session agent runtimes already run as **separate app-ids** dispatched via `call_child_workflow` — the multi-app/multi-task-hub pattern is already in production here.

### 1.7 Properties of this design
**Strengths (and why it's shaped this way):** definitions are data → runtime creation is free (the AI assistant already authors specs; new row = new workflow, zero redeploy); one deployable interprets everything; determinism + safety are guaranteed by construction (no user code in the orchestrator process); listing/versioning are plain DB queries; visual canvas + AI authoring fall out naturally.
**Costs:** expressiveness is bounded by the SW 1.0 task vocabulary + the action catalog + the jq/CEL expression sublanguage; the interpreter is a non-trivial Python codebase to maintain; debugging is "trace the interpreter," not a native stack trace; some primitives are under-built (notably parallel fork — see §3-A).

---

## 2. The Dapr "workflows-as-code" model and its defining constraint

Workflows-as-code = each workflow is a hand-written function using the Dapr Workflow SDK (`@wfr.workflow`,
`ctx.call_activity` / `ctx.call_child_workflow` / `ctx.create_timer` / `when_all` / external events). It
buys full language expressiveness + native control flow, type-checking and unit tests, IDE
tooling/stack-traces, and first-class fan-out/fan-in, timers, and waiters.

**The constraint that dominates the comparison:** `dapr-ext-workflow 1.17.1` (durabletask) requires **all**
workflows registered **before** `WorkflowRuntime.start()`. There is no API to add a workflow to a running
worker (verified: `app.py:1140-1152`; every agent runtime follows the same register-then-`start()`
pattern). **Therefore pure workflows-as-code ⇒ code change → image build → pod redeploy. It cannot create
workflows at runtime.** This is not a workflow-builder limitation — it is *the* reason data-driven workflow
interpreters exist.

**Consequence for "replace the interpreter with pure code":** doing so would *lose* runtime creation,
multiply deployables (every new workflow ⇒ a deploy), and discard the canvas/AI authoring story plus a
working interpreter. So the productive framing is **what to add alongside the interpreter**, not what to
replace.

---

## 3. Options explored (each with pros and cons)

### Option A — Extend the interpreter; everything stays data

**How it works.** Keep the single generic interpreter as the only engine. Close the genuine "we need code"
gaps inside the data model: (1) implement **true parallel fork/fan-in** — `_handle_fork_task`
(`sw_workflow.py:2667`) and `_handle_for_task` run branches *sequentially* today ("parallel TBD"); the fix
is to schedule branch `Task`s and `yield when_all(tasks)`, the SDK-native fan-out primitive (already
exported; only `when_any` is imported at `sw_workflow.py:33`). (2) Use the existing `code/<slug>` →
code-runtime escape hatch for arbitrary/typed logic. (3) Add a normalized `workflow_versions` projection
table so version/lineage queries don't JSON-walk `spec.metadata.publishedRuntime.revisions[]`.

> Correction worth noting: the interpreter's source comment "Dapr doesn't natively support parallel
> activities" is inaccurate — durabletask supports fan-out/fan-in via `when_all`. The sequential fork is a
> self-imposed gap, not a Dapr limitation.

**Storage/listing:** `workflows.spec` unchanged; `GET /api/workflows` unchanged; new `GET /api/workflows/[id]/versions`.
**Runtime creation:** preserved for all definitions; only one-time interpreter *semantic* changes (the fork fix, a new TaskType) need an orchestrator redeploy.
**Stacks:** none structural; recommend raising `workflowstatestore maxConns` before wide fan-out.

**Pros**
- Fewest moving parts: one engine, one app-id; reuses code-runtime + `code_functions` that already exist.
- Preserves runtime creation (no redeploy) for the common case.
- Stays on upstream CNCF SW 1.0 + Dapr `when_all` — no custom controllers.
- Parallel fork is a small, surgical, replay-safe change that closes the headline gap.
- Untrusted/expressive code stays sandboxed in code-runtime, out of the deterministic workflow thread.
- Determinism remains guaranteed by construction.

**Cons**
- Interpreter *semantic* changes still need an image build + rolling redeploy (not per-workflow, but real).
- Logic inside a `code/<slug>` unit is single-shot — **no per-step durable replay** around arbitrary control flow.
- Expressiveness stays bounded by SW 1.0 + jq/CEL; genuinely novel control flow must be decomposed.
- Version listing needs the new `workflow_versions` projection (extra write on publish).

**Effort: M.**

---

### Option B — Git-native Dapr SDK workflows, alongside the interpreter (separate deployment)

**How it works.** Engineers hand-write real Dapr `@workflow` functions in `services/code-workflow-runtime/
code_workflows/*.py`, auto-discovered and `register_versioned_workflow`'d at startup (same pattern as the
orchestrator's activity discovery). A build step (mirroring `scripts/sync-runtime-registry.mjs`) emits a
committed `code_workflows_manifest.json` + a BFF copy `code-workflows.data.json` (drift-tested like the
`runtime_registry.json` twin). Thin pointer rows are seeded into the `workflows` table
(`engineType='dapr'`, `daprWorkflowName=<name>`) so code workflows appear in the same UI list. The
`execute` route branches on `engineType`: instead of posting an inline spec, it posts
`{workflowName, workflowVersion, triggerData}` to a new endpoint that calls `_idempotent_schedule(...)` —
the same scheduler SW uses. Reuses the same `ACTIVITIES`, executions read-model, and child-workflow agent
dispatch. **Homing: a separate `code-workflow-runtime` Deployment (own app-id)** for crash isolation from
the platform-critical interpreter (the cross-app-id child-workflow pattern is already proven at
`sw_workflow.py:1838`; `workflowstatestore` is unscoped so no scope edit is needed).

**Storage:** git (source) + image tag (version) — no DB-stored executable body. **Listing:** orchestrator `GET /api/v2/code-workflows` from the manifest + BFF `GET /api/workflows/code`; pointer rows surface in the main list. **Runtime creation:** **no** — commit → image → GitOps `newTag` bump → rollout.

**Pros**
- Strictly more expressive than the interpreter: native control flow, typed code, `when_all/when_any` over dynamic task lists, sub-orchestrations, external events; debuggable + unit-testable with ordinary Python tooling.
- Git-native versioning is the SSOT for behavior: PR review, blame, rollback = `git revert` + image re-pin. Strongest governance of the four.
- Reuses existing activities, the scheduler, the executions read-model, the `engineType` column, and the unscoped state store — small surface of genuinely new concepts.
- The export emitter has been shadow-targeting a durable-context shim; B makes that the real path and lets you **retire the shim** (full cutover, no back-compat).
- A separate deployment gives clean crash/latency isolation, independent scaling, and independent image cadence.

**Cons**
- **No runtime creation/edit** — every new/changed workflow body is a commit + image build + GitOps bump + rollout. The single biggest regression vs. the interpreter (acceptable only because it's a stated *preference*, not a requirement).
- Determinism becomes each engineer's responsibility (no `now()`/`random`/IO in the workflow fn; never edit a released `version_name` in place) — per-workflow footguns; needs lint/CI guards.
- The workflow fn is trusted in-process code that can crash/CPU-spin and starve the durabletask thread pool — the reason a separate deployment is recommended.
- Two workflow workers now contend for the same `workflowstatestore` (`maxConns=16`) — needs the connection budget raised.
- Bifurcates authoring (visual/data-driven vs. code/PR); the UI must clearly signal which is which.
- A separate Deployment adds a pod, Service, RBAC, PDB, VPA, an image, and a GitOps component to operate.

**Effort: L.**

---

### Option C1 — DB-stored code, activate-on-reload

**How it works.** Add `code_workflows` + `code_workflow_revisions` tables (mirror `code_functions`). The
runtime `_discover`s them at boot and `register_versioned_workflow`s each *before* `start()`. New/edited
workflows go live after a **pod restart** (self-restart RBAC already exists). Storage/listing = DB query.
Runtime creation = "author at runtime, **activate on reload**" — no image build, but a rollout, not truly
zero-redeploy.

**Pros**
- Author code without an image build; activation is a controlled rollout using RBAC that already exists.
- Storage/listing are simple DB queries (like `code_functions`); easy to surface in the UI.
- Still real durabletask workflows (full durability), unlike the single-shot `code/<slug>` activity.

**Cons**
- Not truly zero-redeploy — every change still needs a worker reload (the registration-before-`start()` constraint is unavoidable).
- **Weaker governance than git:** a DB-stored executable body has no inherent PR/review/blame trail and can drift from any source-of-record.
- Same per-author determinism burden as B, plus the drift risk.
- Adds a migration and (recommended) the same separate-deployment isolation as B — i.e., most of B's infra cost without B's git governance.

**Effort: L.**

---

### Option C2 — Generic exec-interpreter (true runtime-created code)

**How it works.** Register one generic durable workflow `code_workflow_v1` that takes a `codeWorkflowId` as
input and **`exec()`s stored code inside the real `ctx`** — reusing the emitter shim surface
(`call_activity/sleep/jq`) backed by `wf.DaprWorkflowContext`. This is the only option besides the
interpreter that yields **true runtime-created code** (a new DB row is immediately runnable), because the
registered workflow is generic and loads code per-instance — structurally identical to how the SW
interpreter loads a spec per-instance.

**Pros**
- True runtime creation of *code* with no redeploy — closest thing to "the interpreter, but you author code."
- Reuses the emitter shim, which is already shaped like a durable context.
- Real durability per instance.

**Cons (these are the decisive ones)**
- **Determinism:** arbitrary Python can call `time`/`random`/direct IO and break durabletask replay. The interpreter avoids this by construction (only `ctx.*`).
- **Async/await ≠ generator-yield:** the emitter produces `async def … asyncio.run(...)` (`emit-py.ts:57,75`), but Dapr Python workflows are generator-`yield` — so a non-trivial async→durable bridge is required.
- **Security:** `exec()` of user source in the orchestrator process inherits its ServiceAccount, secrets, and network — a serious escalation surface.
- **Marginal value:** safe *only* if constrained to emitter-generated, ctx-only code with restricted builtins / an AST allowlist, run in a separate app-id — at which point it largely **re-skins the interpreter** (its only real gain is a code-shaped authoring UX, not new capability).

**Effort: L–XL.**

---

## 4. Side-by-side comparison

| | A: Extend interpreter | B: Git-native code (separate deploy) | C1: DB-stored + reload | C2: Generic exec |
|---|---|---|---|---|
| Runtime creation (no redeploy) | ✅ defs as data | ❌ image + rollout | ⚠️ rollout, no image | ✅ true, but risky |
| Definition storage | `workflows.spec` JSONB | git + image tag | `code_workflows` table | `code_workflows` table |
| Listing | DB query (+ `workflow_versions`) | manifest + pointer rows | DB query | DB query |
| Expressiveness vs interpreter | = (+ real parallel) | **strictly more** | strictly more | more (code skin) |
| Determinism safety | ✅ by construction | ⚠️ per-author | ⚠️ per-author | ❌ arbitrary / ⚠️ constrained |
| Governance | spec review | **git PR/blame** | weak (DB body) | weak (DB body) |
| New infra | none | one isolated deployment | migration (+ deploy) | isolated deploy + sandbox |
| Effort | M | L | L | L–XL |

---

## 5. Considerations for choosing (non-binding)

- The interpreter is **not** a compromise to escape — it is the only option that delivers runtime creation,
  one deployable, and determinism-by-construction. Most reasons people reach for "code" here are really
  (a) true parallelism, (b) an arbitrary-code escape hatch, and (c) typed/versioned units — **all
  addressable inside the data model (Option A)**.
- A real code-workflow home (Option B) earns its keep only for a *small set* of genuinely complex durable
  orchestrations (intricate *dynamic* fan-out/fan-in, sub-orchestrations, external-event choreography, or
  logic that needs per-step durable replay around arbitrary control flow) that the spec + jq/CEL can't
  express cleanly or debug well. It complements the interpreter; it does not replace it.
- Between the code homes, **git (B) beats DB (C1)** on governance for the same durability; and **C2's
  `exec()` of user code in the orchestrator is the one approach to keep out of the critical path** unless a
  runtime code-authoring UX becomes a hard product requirement (and even then, constrain it to
  emitter-generated, ctx-only code in an isolated app-id).
- One change pays off under *every* option: raise `workflowstatestore maxConns` (16) toward the configured
  `128/512` concurrency.

---

## 6. Cross-cutting infrastructure notes (stacks:main)

- **Do regardless of direction:** raise `packages/components/workloads/workflow-builder/manifests/Component-workflowstatestore.yaml` `maxConns` above 16 (it throttles fan-out today and would be worsened by a second workflow worker; PgBouncer fronts it but `maxConns` is the hard ceiling).
- **Option A:** no structural manifest change (the fork fix ships via the normal `workflow-orchestrator` image pin).
- **Options B / C-isolated:** a new `packages/components/workloads/code-workflow-runtime/` component — `Deployment` (clone the orchestrator's; new app-id, `enable-workflow: true`, reuse the existing Dapr `Configuration`, 1 replica to start), `Service`, pod-restart RBAC, PDB, VPA, `kustomization` with an `images[]` pin; register it in the workloads app-of-apps. Reuse the **unscoped** `workflowstatestore` (no scope edit) + a seed `Job` for the UI pointer rows.
- **Already sufficient:** placement (`replicationFactor=100`), the multi-app-id pattern (proven by per-session agent runtimes), and orchestrator self-restart RBAC.

---

## 7. If validating a direction (cheap spikes)
1. **A:** change `_handle_fork_task` to `yield when_all(tasks)`; run a 3-branch fork; confirm wall-clock ≈ slowest branch and replay-safety (terminate + re-hydrate, diff history).
2. **B:** add one hand-written `code_workflows/hello.py`, dispatch by name via `_idempotent_schedule`, confirm it lists via the manifest endpoint and runs end-to-end reusing `execute_action`.
3. **Determinism gate (B/C):** start an instance, force a replay, assert identical history — wired into the existing `tests/` harness (`test_durability.py`); for C2, assert the AST allowlist rejects `time/random/os` imports.
4. **State store:** load-test fan-out at 128/512 before/after raising `maxConns`.
