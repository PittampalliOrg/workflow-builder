# dapr-agent-py + openshell sandboxes: architecture evaluation

**Status:** evaluation / decision artifact (no code change). **Question:** is dapr-agent-py's
workspace/sandbox architecture a good design, or should we change it?

**TL;DR.** It works and is proven, but it buys its two real benefits — workspace *sharing* and
*durability across pod reschedule* — through the most complex mechanism available (a **remote**
openshell sandbox reached by per-tool **mTLS RPC**, plus a full-image `seed-openshell-config` init
container). The `juicefs-shared` backend already built for the CLI family delivers the **same**
sharing + durability with **pod-local** file semantics — no RPC, no mTLS hop, no stdout truncation.
The three-backend split is the core architectural weakness; it forces `WorkspaceBackendMismatchError`
and blocks per-phase cross-family agent mixing. **Recommendation:** keep `openshell-shared` as the
working default now (browser-use genuinely needs it), and pursue a *phased, low-urgency* convergence
of the **non-browser** durable runtimes onto a single shared-FS backend.

> Related docs (this one is the focused dapr/openshell lens; do not duplicate):
> [`agent-node-and-workflow-sandbox-architecture.md`](./agent-node-and-workflow-sandbox-architecture.md)
> (the `sandbox.scope` + goal-lifecycle-adapter standardization),
> [`interchangeable-agents-and-per-phase-selection.md`](./interchangeable-agents-and-per-phase-selection.md)
> (the cross-family block + phased plan),
> [`juicefs-sandbox-storage.md`](./juicefs-sandbox-storage.md) (JuiceFS data-in-Postgres + fixes),
> [`durable-session-runtime-contract.md`](./durable-session-runtime-contract.md) (the swappable
> runtime contract), [`sandbox-warm-pools.md`](./sandbox-warm-pools.md) (cold-start + warm-pool blocker).

## 1. Current architecture

### The dapr-agent-py data path

`dapr-agent-py` is a **stateless agent pod + a separate, remote openshell sandbox pod**. The agent
holds no workspace state; `/sandbox` lives in the sandbox.

1. A `workspace/profile` workflow node provisions the openshell sandbox (`keepAfterRun: true`,
   `ttlSeconds`), returning `sandboxName` + `workspaceRef`. The sandbox **outlives the agent pod**.
2. The agent pod's `OpenShellRuntime` (`services/dapr-agent-py/src/openshell_runtime.py`) does
   `SandboxClient.from_active_cluster()` → `client.get(sandboxName)` → `wait_ready` → `SandboxSession`.
3. **Every** file read / write / edit / `execute_command` is an **RPC over mTLS** to that remote
   sandbox pod (`SandboxSession.exec()`), piped via stdin to dodge openshell's argv newline limit.
   The agent pod's own filesystem is never the workspace.
4. The agent pod is reaped on session end (per-activity churn is fine — the workspace survives in the
   sandbox); `persist_workspace_session` upserts a `workflow_workspace_sessions` row so the run's
   live-preview proxy can find the retained sandbox.

This is exactly the pattern the GAN harness's dapr variant
([`gan-harness-workflow.md`](./gan-harness-workflow.md)) and `retroforge-showcase.json` use: one
`workspace/profile` sandbox shared by all `durable/run` agents (via `sandboxName`/`workspaceRef`) and
all deterministic `workspace/command` nodes (via `workspaceRef`).

### The three workspace backends (`services/shared/runtime-registry.json`)

Same `/sandbox*` *path*, three different *storage systems* — a shared path name does **not** mean
shared bytes:

| Backend | Runtimes | Where files physically live | Sharable across nodes? | Survives pod reschedule? | Indirection |
|---|---|---|---|---|---|
| **openshell-shared** | dapr-agent-py, browser-use | **Remote openshell sandbox pod**; tools = mTLS RPC | ✅ (agents + `workspace/command`) | ✅ (workspace ≠ agent pod) | **per-tool RPC + mTLS** |
| **juicefs-shared** | claude-code-cli, codex-cli, agy-cli | **Per-execution CSI-mounted JuiceFS** at `/sandbox/work`; **pod-local** file ops | ✅ (all CLI pods + cli-agent-py `cliWorkspace` nodes) | ✅ (CSI network FS remounts) | **none** (local FS) |
| **pod-local** | claude-agent-py, adk-agent-py | **Agent pod's ephemeral FS** | ❌ | ❌ | none |

The mismatch guard (`src/lib/server/agents/resolver.ts` `assertConsistentWorkspaceBackends` /
`WorkspaceBackendMismatchError`) rejects, at dispatch, any set of nodes that share a `workspaceRef`
but resolve to >1 backend — preventing silent data loss. This is *why* the GAN harness needs two
separate fixtures (CLI vs dapr) instead of swapping the agent on one.

## 2. Why the openshell model exists (the real benefits)

- **Workspace sharing.** Multiple agent steps + deterministic `workspace/command` nodes operate on
  one `/sandbox` — the foundation of the plan→negotiate→generate→gate→evaluate handoff.
- **Durability across pod churn.** dapr-agent-py is `per-activity`-durable: its pod can reschedule
  between activities. Because the workspace is the remote sandbox, not the pod FS, no work is lost.
- **A uniform tool surface.** openshell exposes `execute_command`/`read_file`/`write_file`/… as the
  agent's built-in tools, and the same surface backs `workspace/command`. browser-use's chromium /
  vision pipeline is genuinely an openshell sandbox concern.

The honest point: these benefits are real — but only the **third** (browser-use's chromium sandbox)
*requires* the remote-pod model. Sharing + durability are also delivered by `juicefs-shared`.

## 2a. Does the recommended approach keep FULL dapr durability? (hard requirement)

**Yes — and it must, so spell out why.** There are two *separate* durability concerns; only one
depends on the workspace backend:

1. **Dapr Workflow orchestration durability (activity replay).** dapr-agent-py is
   `per-activity`-durable: `session_workflow`'s completed activities + results live in the **actor
   state store** (`workflowstatestore`, Postgres). On a pod crash/reschedule, Dapr replays the
   workflow history and resumes from the last completed activity. **This is entirely orthogonal to
   the workspace backend** — it is the actor state store, not the filesystem. Switching `/sandbox`
   from openshell-RPC to a CSI mount does **not** touch it. ✅ Preserved under *any* backend; never
   at risk.

2. **Workspace-filesystem survival across pod reschedule.** This *does* depend on the backend:
   - `openshell-shared`: ✅ the workspace is a separate pod that outlives the agent; the rescheduled
     agent reconnects by `sandboxName` (durably replayed from workflow input).
   - `juicefs-shared` (**the recommended target**): ✅ the workspace is a **CSI-mounted, RWX,
     network-backed** per-execution volume. It is *external* to the agent pod (survives pod death)
     and **remountable on any node** (RWX, not a node-locked block PV), keyed by `executionId` —
     which is durably replayed. The rescheduled pod re-mounts the same volume and sees every file
     prior activities wrote.
   - `pod-local`: ❌ ephemeral pod FS — lost on reschedule. **This is why the recommendation targets
     the SHARED-FS backend, not pod-local.**

   The crisp framing: `juicefs-shared` keeps the workspace **just as external and durable** as
   openshell, but **accesses it as a local mount instead of a remote RPC**. You keep the durability
   *and* drop the per-tool RPC — they are not in tension. (As a bonus, converging
   claude-agent-py/adk off `pod-local` onto the same shared-FS would *upgrade* them from
   non-durable to durable workspaces.)

**Crash-consistency is equivalent at the activity boundary.** If a pod dies mid-write, the *activity*
that was writing did not complete → Dapr re-runs it → the file is rewritten. Partial files from an
interrupted activity are superseded on replay. This holds for both models (a crashed mid-write RPC to
the openshell sandbox is likewise re-done on activity replay); neither gives intra-activity atomicity,
both give activity-boundary consistency.

**Where the real risk is — and it is NOT durability loss:** it is the *engineering* of the migration:
(a) rewriting dapr-agent-py's `OpenShellRuntime` tool surface (`execute_command`/`read_file`/
`write_file`) to operate on the local mount while preserving tool + security semantics; (b) the **CSI
volume attach/detach lifecycle** on pod start/reschedule introduces a new failure mode (a volume stuck
attaching) that openshell's stateless-pod-reconnect avoids — though it is a once-per-pod-start cost,
not per-activity, comparable to today's seed-config cost. **This must be validated on the per-activity
reschedule path** (kill the agent pod mid-loop, confirm the rescheduled pod remounts and the
deterministic gate still sees the agent's files) before cutting dapr-agent-py over.

## 3. Costs and pain points (with sources)

- **Per-tool RPC + mTLS** on every file op and command — latency and many more failure modes than a
  local FS (`openshell_runtime.py`).
- **Command stdout truncation (~4–8 KiB).** Large build/test logs get cut off; only chunked *file*
  reads are mitigated, not `exec` stdout (`gan-harness-workflow.md`, `openshell_runtime.py`).
- **`seed-openshell-config` init container** pulls the **full** dapr-agent-py image (`imagePullPolicy:
  Always`) just to seed `active_gateway` + mTLS certs → ~7–20 s cold-start and an `active_gateway`
  **ENOENT failure mode that breaks all sessions in the pod** (`sandbox-warm-pools.md`, CLAUDE.md
  troubleshooting). *(First-hand: the dapr GAN dev run sat at `workspace_profile` during sandbox
  provisioning before any agent work began.)*
- **Stale k8s-client / 504 / ws-handshake** on control-plane rollouts; **manual mTLS cert rotation**
  (no cert-manager automation) (`sandbox-warm-pools.md`; RetroForge's openshell-runtime stale-client
  504 noted in project memory).
- **Three-backend fragmentation.** The split is what forces `WorkspaceBackendMismatchError` and
  blocks per-phase cross-family agent mixing (`interchangeable-agents-and-per-phase-selection.md`).
- **(juicefs's own caveat, for fairness)** JuiceFS stores data as rows in Postgres → `node_modules`
  bloat; the fix (data → object store, metadata-only Postgres) is already on the roadmap
  (`juicefs-sandbox-storage.md`).

## 4. Options

### Option A — Status quo (keep openshell-shared for dapr; 3 backends)
- **Pros:** proven (RetroForge + the dapr GAN variant); zero migration; browser-use already fits.
- **Cons:** keeps the RPC indirection + cold-start + truncation + mTLS ops; keeps the cross-family
  block; three "where do files live" stories to reason about.

### Option B — Converge non-browser runtimes onto one shared-FS backend (juicefs-shared) **[recommended]**
- **What:** repoint dapr-agent-py's tool runtime from openshell RPC to a **local-FS runtime** over a
  per-execution CSI mount (the juicefs-shared mechanism). Eventually fold claude-agent-py/adk
  (`pod-local`) onto the same shared-FS so they too can share + persist. browser-use stays on
  openshell.
- **Pros:** removes RPC/mTLS/seed-config for the file path; **pod-local file speed**; no stdout
  truncation; keeps durability (CSI network FS remounts on reschedule); collapses 3 backends → ~2
  (shared-FS + browser-openshell); **removes the cross-family block** (a dapr planner + a CLI
  generator could share one run).
- **Cons:** real, phaseable engineering — rewrite `openshell_runtime.py`'s tool surface against a
  local FS; depends on the juicefs data→object-store fix landing first to avoid Postgres bloat;
  browser-use remains a second backend (acceptable — it genuinely needs chromium).

### Option C — Converge everything onto openshell-shared
- **Pros:** one backend; uniform tool API.
- **Cons:** **wrong direction** — pushes the lean CLI family onto the heavier remote-RPC model,
  inheriting truncation + cold-start + mTLS for runtimes that don't need them. Rejected.

### Option D — Adopt the `sandbox.scope` declarative knob (from the sandbox-architecture doc)
- **Pros:** makes ephemeral-vs-shared *scope* data, not inline control flow; good ergonomics.
- **Cons:** **complementary, not a substitute** — it does NOT by itself remove the remote-sandbox
  indirection or the backend split. Pursue alongside B, not instead of it.

## 5. Comparison

| Axis | openshell-shared (A) | juicefs-shared (B, recommended) | pod-local |
|---|---|---|---|
| File-op indirection | per-tool mTLS RPC | none (local FS) | none |
| Durable across pod reschedule | ✅ | ✅ (CSI) | ❌ |
| Cross-node sharing | ✅ | ✅ | ❌ |
| Enables cross-family mixing | ❌ | ✅ (if dapr joins it) | ❌ |
| Command stdout limit | ~4–8 KiB | pod-native | pod-native |
| Cold-start overhead | high (full-image seed init) | low (CSI mount) | lowest |
| Operational complexity | high (mTLS certs, gateway, stale-client) | medium (JuiceFS metadata; data→objstore pending) | lowest |
| Security isolation | strong (separate pod, mTLS) | per-execution mount scoping | pod boundary |
| Browser/chromium support | ✅ (native) | ✗ | ✗ |

## 6. Recommendation

1. **Now:** keep `openshell-shared` as the working default. It's proven, and **browser-use needs the
   chromium/openshell sandbox** — that backend stays regardless.
2. **Strategic direction (phased, low-urgency):** converge the **non-browser** durable runtimes
   (dapr-agent-py first, then claude-agent-py/adk's `pod-local`) onto a single **shared-FS** backend
   (`juicefs-shared`, after its data→object-store fix). This collapses 3 backends → ~2, removes the
   cross-family block, and eliminates most openshell pain points — while *preserving* the two real
   benefits (sharing + durability) that justified openshell in the first place.
3. **Complementary:** adopt the `sandbox.scope` declarative knob so scope is data, not inline control
   flow — but treat it as ergonomics on top of (2), not a fix for the backend split.
4. **Sequencing dependency:** land the JuiceFS data→object-store migration
   (`juicefs-sandbox-storage.md`) before moving dapr volume onto it, so the convergence doesn't
   inherit the Postgres-bloat problem.

Any convergence work above is a separately-scoped follow-up to be greenlit explicitly; this document
is the decision rationale, not an implementation plan.
