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

## How it works (Dapr-native rerun-from-event)

Dapr Workflow has **no in-place rewind of a terminal instance**, but it ships
`RerunWorkflowFromEvent` (durabletask; `dapr-ext-workflow==1.18.0`) — and we already exposed it at
orchestrator `POST /api/v2/workflows/{instance_id}/rerun`. It:

1. Creates a **new** Dapr instance.
2. **Replays the source history `0..(eventID-1)` as cached results** — completed activities AND completed
   `durable/run` **sub-orchestrations** are returned from the *parent* history, **not re-executed**.
   (Spike-verified 2026-06-25: reran a 7-agent-node GAN run from a late event → `ExecutionCompleted
   success:true` with **zero** new `agent-host-*` session pods. Child agents replay from cache, not
   re-dispatch.)
3. **Re-executes from `eventID` onward** with the (optionally overwritten) input.

Resume is a **node-aware** wrapper on top of this: you pick a *node*, not a raw history event.

### Node → event mapping
The SW interpreter schedules an `update_execution_node` activity at the **start of every top-level
node**, carrying the node id in its input. `_resolve_resume_event` (orchestrator `app.py`) finds that
event and reruns from it. `fromNodeId` omitted / `"__failed__"` ⇒ the **last** node that started (the
node in-flight when the run stopped).

### Applying the fix (overwriteInput)
The workflow **spec travels as the workflow input** and replay must be deterministic, so the rerun
passes **`overwriteInput=true` + the current (edited) spec**. The replayed prefix uses cached results,
so **edits to earlier nodes are ignored** — only edits to the resume node and later take effect. If an
earlier node's *structure* (task scheduling) changed, replay would diverge.

### Reusing the workspace (stable workspace key)
The shared `/sandbox/work` is a JuiceFS subPath keyed on `workspaceExecutionId` (Postgres-backed,
`Retain`, survives pod/PVC death). On a normal run `workspaceExecutionId == executionId == the Dapr
instance id`, which **changes per instance** — so a naive rerun would point the resumed node at an empty
workspace. Fix: `runtime.workspaceExecutionId` is a stable key in the expression context (defaults to
`executionId`); resumable fixtures use `${ .runtime.workspaceExecutionId }` for `workspaceRef`, and the
resume caller threads the **root run's** instance id so the resumed node re-mounts the original
`/sandbox/work` (cloned repo, SPEC.md, contract.json, edits).

### Retain-on-failure
Resumable workflows (`document['x-workflow-builder'].resumable: true`) **skip workspace cleanup on
failure** (`sw_workflow.py`), so the data survives to be resumed. The Dapr **history** is retained by the
existing `stateRetentionPolicy=168h` (failures aren't purged — only an explicit Stop purges), so **7
days** is the resume window.

> The `workflow-builder-sandbox-gc` CronJob reaps stale Sandbox **CRs/pods**, NOT the JuiceFS workspace
> **data** — so it does not affect resumability. (Follow-up: an *abandoned-resumable-workspace* reaper to
> bound JuiceFS growth for resumable failed runs that are never resumed.)

## Surfaces

- **UI:** run-detail page → on a failed/cancelled run, **"Resume from failed step"** (auto-locates the
  failed node) + a **"Resume from: <node>"** dropdown of the run's top-level nodes.
- **BFF:** `POST /api/workflows/executions/[executionId]/resume` `{ fromNodeId? }` (owner/project-scoped;
  benchmark/eval instances 409 `coordinator_owned`). Creates a **new** `workflow_executions` row linked to
  the source via the existing `rerunOfExecutionId` / `rerunSourceInstanceId` / `rerunFromEventId` columns.
- **Orchestrator:** `POST /api/v2/workflows/{instance_id}/resume` `{ fromNodeId?, input?, reason? }` →
  node→event map + `RerunWorkflowFromEvent`. 404 if the node never started; 409 if the run has no node
  boundaries.

## Constraints / gotchas

- **Edit only the failed node and later.** Earlier nodes replay from cache; structural edits to them break
  deterministic replay (the resume rejects-by-divergence). Content edits to earlier nodes are silently
  ignored (cached).
- **Resumable scope:** the JuiceFS `/sandbox/work` family (`gan-harness-{glm-visual-dashboard,
  dapr-juicefs-pilot,cli-showcase}`). The openshell-shared family (`gan-harness-dapr-showcase`) is out of
  scope (different, remote workspace).
- **Resume window = 168h** (Dapr history retention). After that, do a full re-run.
- **Partial node history on the resumed run:** the replayed prefix doesn't re-write node-status to the new
  run's row, so the resumed run's UI shows only the resume-node-onward progress; the source run has the
  full prefix (linked via the rerun lineage columns).
- A run that was explicitly **Stop&Reset/purged** loses its Dapr history → cannot be resumed.

## Verify (dev)

1. Run a resumable GAN workflow (`gan-harness-glm-visual-dashboard`, glm-5.2); let it fail at a late node.
2. Confirm retention: `workflow_workspace_sessions` row present + the Dapr instance not purged.
3. Click **Resume from failed step** → new run: early nodes show cached/replayed (no new sandboxes, fast),
   the failed node re-runs fresh against the reused `/sandbox/work`, completes; total time ≪ full run.
4. Negative: edit an earlier node → resume rejects (replay divergence); resume a purged run → clear error.
