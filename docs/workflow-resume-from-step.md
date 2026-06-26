# Resume a workflow run from the failed step

**Status:** IMPLEMENTED (coding/GAN runs, dev). Lets you fix a failed node and re-run **only
that node onward**, replaying the already-completed steps from history instead of redoing the
expensive early work (clone → plan → design → negotiate). Built on Dapr's native rerun-from-event.

Related: `workflow-lifecycle-termination.md` (stop/terminate/purge), `juicefs-sandbox-storage.md`
(the shared `/sandbox/work`), `gan-harness-workflow.md`.

---

## Why

GAN-harness / coding workflows fail at a *late* node (e.g. `evaluate_ui`) only after ~30–40 min of
expensive earlier work. A normal re-run starts a **new execution from the top on a fresh workspace** —
all that work is redone. Resume-from-step keeps the prior work and re-runs just the failed node.

## How it works (fresh execution + skip-prefix + reuse workspace)

**Why not Dapr's native rerun-from-event.** Dapr ships `RerunWorkflowFromEvent` (durabletask) and we
exposed it, but a verification spike found it **copies the source run's workflow input verbatim and
cannot apply an edited spec** — its `overwriteInput` only retargets the *single activity* at the rerun
event, not the workflow input (confirmed in the proto + by the resumed instance's `ExecutionStarted`
showing the original input). Since both our use cases (fix-the-failed-step, iterate-on-a-revised-step)
require the **current/edited** spec to take effect, rerun-from-event is the wrong primitive. (It also
left workspace reuse + result persistence broken because the original input lacked a stable
workspace key / new dbExecutionId.)

**Does Dapr 1.18 "history propagation" help?** No (researched 2026-06-25). History propagation
(`PropagateLineage()`/`PropagateOwnHistory()`, + history signing) lets a **parent** workflow share its
execution history/context with **child** workflows/activities (audit, chain-of-custody, agent-context
carry via `ContinueAsNew`). It does **not** let you rerun/resume an instance with a **replaced
workflow-level input** — `RerunWorkflowFromEvent` still copies the original input, and `ContinueAsNew`
truncates history + discards incomplete tasks. So it doesn't address this flaw; the application-level
pattern below remains correct. (History propagation could independently help give cross-app `durable/run`
agent children parent context — a separate opportunity.)

**What we do instead.** Resume starts a **fresh execution of the workflow's CURRENT spec** that:
1. **Skips every top-level node before `resumeFromNode`** in the interpreter (`sw_workflow.py` do-loop):
   a skipped node does **not dispatch** (no sandbox spawn) and is marked completed with `{skipped:true}`.
2. **Reuses the source run's retained `/sandbox/work`** by threading a stable `workspaceExecutionId`
   (the root run's id) into the input → the resumed nodes resolve `workspaceRef` to the original
   workspace (cloned repo, SPEC.md, contract.json, edits all present).
3. **Runs from `resumeFromNode` onward with the edited spec** → the fix / revision takes effect.

Net effect matches the goal: the expensive prefix is skipped (no re-dispatch), the workspace is reused,
and edits apply — without re-running from the beginning.

### Node selection
`fromNodeId` is a top-level node id (validated against the current spec). Omitted ⇒ the source run's
`currentNodeId` (the node in-flight when it stopped). The interpreter maps it to its position in the
`do` list and skips everything before it.

### Edits take effect from the resume node onward
Because skipped prefix nodes don't run, **edits to nodes BEFORE the resume point have no effect** (their
prior workspace state is reused as-is). Edit the resume node and later.

### Reusing the workspace (stable workspace key)
The shared `/sandbox/work` is a JuiceFS subPath keyed on `workspaceExecutionId` (Postgres-backed,
`Retain`, survives pod/PVC death). On a normal run `workspaceExecutionId == executionId == the Dapr
instance id`, which **changes per instance** — so a naive rerun would point the resumed node at an empty
workspace. Fix: `runtime.workspaceExecutionId` is a stable key in the expression context (defaults to
`executionId`); resumable fixtures use `${ .runtime.workspaceExecutionId }` for `workspaceRef`, and the
resume caller threads the **root run's** instance id so the resumed node re-mounts the original
`/sandbox/work` (cloned repo, SPEC.md, contract.json, edits).

### Retain-on-terminal
Resumable workflows (`document['x-workflow-builder'].resumable: true`) **skip workspace cleanup on ANY
terminal state** (success *and* failure, `sw_workflow.py`), so the `/sandbox/work` data survives to be
resumed/forked. (A fresh fork needs no Dapr history from the source — only the retained workspace — but the
source row + its lineage stay around as usual.)

> The `workflow-builder-sandbox-gc` CronJob reaps stale Sandbox **CRs/pods**, NOT the JuiceFS workspace
> **data** (Postgres-backed/Retain, pod-independent) — so it does not affect resumability. Follow-up: an
> *abandoned-resumable-workspace* reaper to bound JuiceFS growth for resumable runs that are never resumed.

## Surfaces

- **UI:** run-detail page → on a failed/cancelled run, **"Resume from failed step"** (auto-locates the
  in-flight node) + a **"Resume from: <node>"** dropdown of the run's top-level nodes. (To be extended to
  successful runs for the iteration/fork use case.)
- **BFF:** `POST /api/workflows/executions/[executionId]/resume` `{ fromNodeId? }` (owner/project-scoped;
  benchmark/eval instances 409 `coordinator_owned`). Calls `startWorkflowRun` to launch a **fresh execution
  of the current spec** with `resumeFromNode` + `workspaceExecutionId` (root run's id) + the rerun lineage
  columns (`rerunOfExecutionId` / `rerunSourceInstanceId`). Omitted `fromNodeId` ⇒ the source run's
  `currentNodeId`. 404 if the node isn't a top-level node in the current spec.
- **Orchestrator:** the SW interpreter skips top-level nodes before `resumeFromNode` (input field) and
  threads `workspaceExecutionId` into `runtime.workspaceExecutionId`. (A node-aware
  `POST /api/v2/workflows/{id}/resume` rerun-from-event endpoint also exists but is **not** used by the
  resume path — it cannot apply edited specs; kept only for possible pure-retry use.)

## Constraints / gotchas

- **Edit only the resume node and later.** Prefix nodes are skipped and their prior workspace state is
  reused as-is, so edits to earlier nodes have no effect.
- **File hand-off, not context refs.** Skipped prefix nodes produce no task output, so a resumed node must
  read prior results from the shared `/sandbox/work` (the GAN/coding pattern), not via `${ .priorNode.x }`.
  This is why resume is scoped to the JuiceFS `/sandbox/work` family
  (`gan-harness-{glm-visual-dashboard,dapr-juicefs-pilot,cli-showcase}`); the openshell-shared family
  (`gan-harness-dapr-showcase`) is out of scope.
- **Forks are hermetic (all node types)** — each fork runs on an *isolated copy* of the source workspace,
  so repeated/parallel forks never interfere. The interpreter runs an **orchestrator `seed_workspace`
  step** at the top of a resumed run (before the first resumed node), so it works whether or not the
  resumed node spawns an agent pod. (A copy-if-empty init container in agent session pods stays as a
  redundant fast path — it now rarely runs, since the orchestrator step populates the workspace first.)
  - **CoW clone, not a file copy.** The seed Job ROOT-mounts the JuiceFS volume (source + dest subPaths
    under one mount) and runs **`juicefs clone`** per top-level entry — metadata-only copy-on-write, so a
    repo with thousands of tiny `.git` objects clones in one metadata pass instead of a file-by-file
    `cp`. (Originally `cp -a`; that was metadata-bound on Postgres-backed JuiceFS — a ~2800-file GAN
    workspace took ~17 min. `juicefs clone` is ~7× faster; it becomes near-instant once JuiceFS metadata
    moves off Postgres to Redis — the tracked metadata follow-up.) This mirrors the industry pattern
    (e.g. kagent) of *cloning/snapshotting the environment rather than walking the tree*.
  - **Async + polled** — clone is still O(files) on Postgres meta, so a synchronous wait blew the HTTP /
    Node `requestTimeout` budget (→ 504, fork errored). `/internal/workspace/seed-data` now STARTS the
    Job and returns immediately; the `seed_workspace` activity polls `/seed-data/status` until done
    (bounded by `SEED_WORKSPACE_POLL_TIMEOUT_SECONDS`, default 1500s) and raises on failure/timeout, so a
    fork never runs against an empty workspace, regardless of workspace size.
  - **JuiceFS gotcha:** the copy-if-empty test must ignore JuiceFS's virtual control files
    (`.accesslog`/`.config`/`.stats`, present in every mount/subPath) — a naive `ls -A` never sees a fresh
    subPath as empty, so the seed would be wrongly skipped and the fork would run against an empty
    workspace. Both seed commands (`_seed_clone_cmd` for the clone Job, `_seed_copy_cmd` for the
    init-container fallback) filter those files when testing emptiness and when copying.
  (Point-in-time *per-node* snapshots — state as-of *before* the node, vs the source's end state — remain
  a separate future option.)
- **Retained workspaces are reaped** — the `resumable-workspace-gc` CronJob (every 6h) ages out abandoned
  retained JuiceFS workspaces (terminal + >24h + no active fork) via the sandbox-execution-api
  `purge-data` Job, so retention doesn't leak.
- The forked run is a **fresh execution** with its own row + full node history (no partial-history caveat).

## Verify (dev)

1. Run a resumable GAN workflow (`gan-harness-glm-visual-dashboard`, glm-5.2); let it fail at a late node.
2. Confirm retention: `workflow_workspace_sessions` row present + the Dapr instance not purged.
3. Click **Resume from failed step** → new run: early nodes show cached/replayed (no new sandboxes, fast),
   the failed node re-runs fresh against the reused `/sandbox/work`, completes; total time ≪ full run.
4. Negative: edit an earlier node → resume rejects (replay divergence); resume a purged run → clear error.
