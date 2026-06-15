# Long-Running Session Durability — Hardening Plan (dapr-agent-py + CLI/JuiceFS family)

> **Status:** PLAN (kickoff). Goal: run **multi-hour, goal-driven agent sessions** on the
> **in-scope** runtimes that, when disrupted (pod death, worker/daprd restart, node failure,
> image-pin rollout), **resume a large portion of the run instead of starting over**.
> Grounded in the 2026-06-15 durability audit (per-gap `file:line` evidence inline).
>
> **Companion docs:** `cli-conversation-durability.md` (CLI transcript JuiceFS store — now
> SHIPPED/live, not a prototype), `durable-session-runtime-contract.md`,
> `workflow-lifecycle-termination.md`, `goal-loop.md` (the *workflow-builder* goal loop — distinct
> from Claude Code's native `/goal`).

## Scope

**IN SCOPE (this project):**
- **`dapr-agent-py`** — per-activity durable runtime (Dapr Workflow + Postgres actor statestore).
- **CLI / JuiceFS family** — `claude-code-cli` / `codex-cli` / `agy-cli` (per-session transcript on
  Postgres-backed JuiceFS, `claude --continue` resume).
- **The shared Postgres substrate** — because BOTH in-scope runtimes (and the JuiceFS blobs) durably
  persist into the same single Postgres instance, hardening it is in scope.

**OUT OF SCOPE (parked for future work — do not modify in this project):**
- `claude-agent-py` (whole-turn single-activity model; loses an in-flight turn on any disruption).
- `adk-agent-py` (per-activity via Diagrid, but gemini-only; registry mislabel noted, deferred).
- The *workflow-builder* goal-loop driver (`src/lib/server/goals/*`) — separate, already crash-safe.

## Durability today — the two in-scope runtimes (verified at HEAD)

| | **dapr-agent-py** | **CLI / JuiceFS family** |
|---|---|---|
| Durable record | Dapr workflow history + `entry.messages` in `dapr-agent-py-statestore` (Postgres actor store, `agent_py_*`) | CLI's own append-only transcript JSONL on a per-session **JuiceFS-on-Postgres** subtree (`jfs_blob`), reclaim=Retain |
| Granularity | **per-activity** (each `call_llm` + `run_tool` checkpointed; 8 retries) | **per-message** (each JSONL line synced ~2–4ms) |
| Mid-turn pod death | replays completed activities; only in-flight one re-runs | synced lines kept; un-flushed tail lost |
| Resume | automatic (Dapr replay) | **user-initiated** `claude --continue` after session reaches `terminated` |
| Substrate | single Postgres (no backup/HA) | same single Postgres (sole copy of every transcript) |

**Both are genuinely durable at the orchestration layer.** The work below closes the remaining
edges that matter specifically for *hours-long* runs and removes the single foundation risk.

---

## Phase 1 — dapr-agent-py + interactive-class quick wins (locally verifiable, low risk)

These are code/config changes validatable in a Claude Code session (unit tests, `kustomize build`,
type-check). No cluster deploy required to land + prove them.

**1a. Pre-save byte-size guard on the actor state (16 MiB cliff).**
Compaction is **token-triggered only** (`compaction/engine.py` threshold check ~`:389-398`); a 1M-token
model does not auto-compact until ~967K tokens, while the durabletask gRPC channel is 16 MiB
(`main.py:34-48`). Tool args + results are already clamped to 12 KiB each (`compaction/payloads.py`),
but assistant prose is unbounded. **Add** a byte check before `save_state`: if serialized
`entry.messages` exceeds a configurable budget (e.g. 10 MiB), force a compaction pass and/or offload
oldest message bodies to the Files-API with an `artifactRef` (reuse the function-router >4 MiB
offload precedent, `docs/activepieces-integration-architecture.md:110`). Emit a `state_size`
telemetry field so the cliff is observable.
- *Acceptance:* new unit test exercises the over-budget path (forces compaction/offload, asserts the
  persisted document is under budget) and passes; `state_size` is emitted.

**1b. Enable `continue_as_new` for long interactive dapr-agent-py sessions (config-only).**
`continue_as_new_turn_threshold` defaults `None` = disabled (`compaction/config.py:52-54`,
`session_native.py:96-104`); an hours-long non-auto-terminate session accretes unbounded durabletask
history → every post-disruption replay gets slower. The mechanism is fully plumbed
(`main.py:5457-5497`) and the CLI sibling already does this unconditionally
(`cli-agent-py/src/session_workflow.py:37,682-683`). **Set**
`DAPR_AGENT_PY_CONTINUE_AS_NEW_TURN_THRESHOLD` (e.g. 50) in the dapr-agent-py Deployment/ConfigMap
(`stacks: packages/components/workloads/dapr-agent-py/manifests/*` AND
`openshell-agent-runtime/manifests/Deployment-dapr-agent-py.yaml` + `ConfigMap-dapr-agent-py-sandbox.yaml`).
- *Acceptance:* `kustomize build` of the changed overlay(s) renders the env var.

**1c. `run_tool` idempotency cache (at-least-once → effectively once for replayed tools).**
`run_tool` is retried 8× and is not idempotent (`main.py:1774`, exec at `~:2995`); a pod death
mid-tool can double-execute a side effect. **Add** a tool-result cache keyed on
`(instance_id, tool_call_id)`: short-circuit-return a recorded result on replay (mirror the
compaction boundary-sentinel idempotency pattern).
- *Acceptance:* unit test proves a replayed `tool_call_id` returns the cached result without
  re-executing.

**1d. Interactive/goal classes: `NONTERMINAL_TIMEOUT_ACTION=warn` (not `terminate`).**
`Deployment-sandbox-execution-api.yaml:93-94` sets the base env to `terminate`; the in-pod monitor's
900s idle window (`app.py:1216-1221`) can hard-terminate a slow-but-live turn whose Dapr progress
marker hasn't advanced. The code default is `warn` (`session_host_monitor.py:35-39`) and per-class
overrides exist (`agentHostNonterminalTimeoutAction`, `app.py:179,1252-1257`). **Set** `warn` (and/or
a higher idle timeout) for the `interactive-agent` / `interactive-cli` / `interactive-cli-agy`
classes via `SANDBOX_EXECUTION_CLASSES_JSON`; keep `terminate` for benchmark classes.
- *Acceptance:* rendered `SANDBOX_EXECUTION_CLASSES_JSON` shows `warn` for interactive classes only.

**1e. Wire / assert the dapr-agent-py workspace checkpoint remote.**
`code_checkpoint.py:126-201` gates the workspace git-checkpoint push on
`WORKFLOW_CHECKPOINT_GIT_REMOTE_URL` (+ creds), which is **not set in any manifest** — so mid-run
workspace recovery is silently unavailable. **Inject** it per-session (or add a startup
assertion/telemetry that logs whether the checkpoint remote is active for long-running coding
sessions).
- *Acceptance:* startup logs/telemetry surface checkpoint-remote active/inactive; if wired, a unit
  or integration check shows a ref is pushable.

---

## Phase 2 — CLI/JuiceFS family resume hardening

**2a. Automatic resume reconciler (the headline CLI gap).**
Resume is strictly **user-initiated** and gated on `status==='terminated'`
(`src/routes/api/v1/sessions/+server.ts:129-131`; UI `[id]/+page.svelte:1070`). The transcript bytes
are safe in Postgres and the downstream resume path already works
(`agent-workflow-host.ts:316-399` re-mounts the same CSI subPath → `claude --continue` /
`codex resume --last`), and a SIGKILLed session **does** converge to `terminated` (in-workflow
liveness probe `cli-agent-py/src/session_workflow.py:697-724` + `lifecycle-terminal-reaper` CronJob) —
but only after ~10–75 min, and a human must then click Resume. **Add** an auto-resume reconciler:
when the lifecycle controller observes a non-graceful sandbox exit for a session still active,
auto-spawn a continuation pod with `resumeFromSessionId=self` + `continueSession=true`, behind a
per-agent `auto-resume` flag and a max-restart budget.
- *Acceptance:* a simulated/forced pod exit on an in-scope CLI session results in an automatically
  spawned continuation session re-mounting the same subPath (proven via test or a scripted dev check);
  resume precondition relaxed to allow resuming a crashed (not only gracefully-terminated) session.

**2b. Transcript backup + footprint monitoring (Postgres is the sole copy).**
`juicefs format --storage postgres` puts both metadata and `jfs_blob` data in the same Postgres
(`Job-juicefs-store-bootstrap.yaml`); no object store, 10Gi/PV, no monitoring. **Add** `jfs_blob`
growth + per-subtree size monitoring/alerting; verify Postgres PITR (Phase 3) covers the `juicefs`
DB; optionally periodically offload completed transcripts as a cold backup
(`session_outputs.py` `/outputs/ingest` infra already exists).
- *Acceptance:* a metric/alert exists for `jfs_blob` growth; PITR coverage of the juicefs DB is
  documented/verified.

**2c. Graceful degradation if CSI is unavailable.**
If a cluster lacks `transcriptStoreCsiDriver`, `link_transcript_subtree` no-ops and the transcript
reverts to ephemeral `emptyDir` (no resume), with **no fallback** (the documented
`persist_cli_transcript`/`restore_cli_transcript` statestore path was never built — `cancellation.py`
holds only cancel flags). **Add** a hard startup assertion/alert if an interactive-cli class is
configured without `transcriptStoreCsiDriver` (fail loud rather than silently lose durability), or
implement the statestore+Files-API fallback.
- *Acceptance:* launching an interactive-cli class without a transcript store raises a clear startup
  error/alert.

---

## Phase 3 — Foundation: protect the Postgres substrate (highest-value outcome)

> **Risk posture (per house preference): parallel deployment, never in-place replacement.** This is a
> risky infra rewrite — stand the new DB up alongside the existing one, cut over behind a flag, prove
> byte-parity, then retire the old. Needs its own `/goal` + cluster validation; not part of the local
> kickoff.

**3a. Migrate workflow-builder Postgres to CloudNativePG (HA + PITR).**
Today: one unreplicated `postgres:15.3-alpine` (`StatefulSet-postgresql.yaml:11,40,54-62`), no backup,
no PITR, no WAL archiving — the substrate for Dapr workflow checkpoints + agent message lists + app DB
+ JuiceFS transcript blobs. A single PVC corruption / accidental delete / (on ryzen) node-disk loss
destroys every hour of every concurrent run. **Migrate** to CloudNativePG: `instances: 3` (sync
replica + automatic failover), continuous WAL archiving + scheduled base backups to object storage
(PITR), a real (replicated/network) storageClass.
- *Acceptance:* HA failover validated (kill primary → standby promotes, workflows resume); a PITR
  restore to a timestamp is demonstrated in a non-prod target.
- *Stop-gap if deferred:* scheduled `pg_dump` of `workflow_builder` + `juicefs` DBs to object storage
  + a VolumeSnapshot schedule on the data PVC.

**3b. PgBouncer pooler redundancy + `maxConns`.**
Pooler is `replicas:1` (`Deployment-postgresql-pooler.yaml:11`) on the Dapr-state write path; raise
to 2+ with a real PDB. Raise `workflowstatestore maxConns` (16, `Component-workflowstatestore.yaml`)
toward the pool size / configured 128/512 concurrency. Add state-store write-latency alerting.

**3c. Remove the hardcoded `password` literal** — source from the existing `workflow-builder-secrets`
ExternalSecret everywhere; pairs with backup to make destructive state surgery recoverable.

---

## Phase 4 — Long-run lifecycle (don't wrongly kill a healthy hours-long run)

**4a. Decouple "abandoned" deadline from "active-work" deadline.**
`timeoutSeconds` is capped at 86400 (24h) and stamps a wall-clock `activeDeadlineSeconds` that ignores
liveness (`app.py:221,1404-1405,1527-1530`). Interactive UI sessions are exempt (pass `null`), but
workflow/goal/benchmark-class and timeout-configured runs are killed at the deadline regardless of
activity. **Refresh** `shutdownTime`/`activeDeadline` via a heartbeat-extended lease while the
workflow shows liveness; make the 24h cap class-specific for long autonomous classes. Persist the
volatile `_session_idle_waiting` flag (`main.py:6152`) into durable `customStatus` so a benign restart
isn't misread as a mid-turn stall.

**4b. Kueue preemption protection.** Long autonomous runs admitted on borrowed/lower-priority quota
can be reclaimed (cohort `agent-platform`, `reclaimWithinCohort: LowerPriority`). Pin genuinely
long-running autonomous work to `interactive-agent` priority (1000) or a dedicated higher-value
`WorkloadPriorityClass`, or set `borrowingLimit: 0` for the long-run queue.

---

## Sequencing & how `/goal` is used

- **Kickoff goal (this plan, Phase 1):** land 1a–1e with local validation (unit tests, `kustomize
  build`, type-check) — all provable in a single Claude Code session transcript.
- **Follow-up goals:** Phase 2 (CLI auto-resume), then Phase 3 (CloudNativePG — its own goal + cluster
  validation), then Phase 4.

Each gap's *acceptance criterion* is written so Claude's own surfaced output (a passing test, a
`kustomize build`, a `git status`) demonstrates completion to the `/goal` evaluator, which reads only
the conversation.

## Invariants (must hold in every phase)

- Do **not** modify `claude-agent-py`, `adk-agent-py`, or `src/lib/server/goals/*` (workflow-builder
  goal-loop).
- Per-activity (dapr-agent-py) and per-message (CLI) durability granularity must not regress.
- No plaintext secrets added; no in-place destructive DB migration.

---

## Appendix — `/goal` prompts per phase (Claude Code native `/goal`)

Each condition is written so Claude's own surfaced output (a passing test, a `kustomize build`, a
`kubectl get`) demonstrates completion — the `/goal` evaluator (Haiku) reads only the conversation.
Pair with **auto mode** so each turn runs unattended.

### Phase 1 (kickoff — local, no cluster needed)

```
/goal Phase 1 of docs/long-running-session-durability-plan.md is complete for the IN-SCOPE runtimes ONLY — dapr-agent-py and the CLI/JuiceFS family. Repos: ~/repos/PittampalliOrg/workflow-builder/main (code) and ~/repos/PittampalliOrg/stacks/main (GitOps manifests). HARD CONSTRAINTS: do NOT modify services/claude-agent-py, services/adk-agent-py, or src/lib/server/goals/* (the workflow-builder goal-loop); add no plaintext secrets; do not change per-activity or per-message durability semantics. Read the plan doc first and follow its Phase 1 acceptance criteria.

The goal is met ONLY when ALL of the following are demonstrated in THIS conversation by showing the actual command output:

1. dapr-agent-py 16 MiB guard (plan 1a): a pre-save byte-size guard forces compaction/offload when serialized entry.messages exceeds a configurable budget before save_state, and emits a state_size telemetry field. Show a NEW unit test that exercises the over-budget path and the test command exiting 0.

2. dapr-agent-py continue_as_new (plan 1b): DAPR_AGENT_PY_CONTINUE_AS_NEW_TURN_THRESHOLD is set in BOTH the dapr-agent-py Deployment/ConfigMap and the openshell-agent-runtime dapr-agent-py manifests. Show `kubectl kustomize` (or `kustomize build`) of each changed overlay rendering the env var.

3. dapr-agent-py run_tool idempotency (plan 1c): a (instance_id, tool_call_id) result cache short-circuits a replayed tool. Show a NEW unit test proving a replayed tool_call_id returns the cached result without re-executing, exiting 0.

4. Interactive-class timeout safety (plan 1d): NONTERMINAL_TIMEOUT_ACTION=warn for the interactive-agent / interactive-cli / interactive-cli-agy classes only (benchmark classes stay terminate). Show the rendered SANDBOX_EXECUTION_CLASSES_JSON.

5. Workspace checkpoint visibility (plan 1e): startup logs/telemetry surface whether WORKFLOW_CHECKPOINT_GIT_REMOTE_URL is active for dapr-agent-py. Show the code path and a test or log line proving it.

6. Everything is green and SHOWN here: workflow-builder type-check / the changed Python services' tests pass, AND `kustomize build` of every changed stacks overlay succeeds, AND `git status` in both repos shows only in-scope files changed (zero files under services/claude-agent-py, services/adk-agent-py, or src/lib/server/goals).

Report progress against these six items every turn. Stop after 40 turns if not all are met and summarize exactly what remains.
```

### Phase 2 (CLI/JuiceFS resume hardening — mostly local)

```
/goal Phase 2 of docs/long-running-session-durability-plan.md is complete — CLI/JuiceFS family resume hardening. IN-SCOPE: services/cli-agent-py, the BFF session/lifecycle code (src/lib/server/sessions/*, src/lib/server/lifecycle/*), and stacks monitoring manifests. HARD CONSTRAINTS: do NOT modify services/claude-agent-py, services/adk-agent-py, or src/lib/server/goals/*; preserve per-message transcript durability; the JuiceFS-on-Postgres transcript store is ALREADY LIVE — build ON it, do not replace it.

Met ONLY when ALL are demonstrated in THIS conversation by actual command output:
1. Auto-resume reconciler (plan 2a): when the lifecycle controller observes a non-graceful sandbox exit for a still-active in-scope CLI session, it auto-spawns a continuation with resumeFromSessionId=self + continueSession=true, behind a per-agent auto-resume flag and a max-restart budget. Show NEW unit tests for the reconciler decision (fires on crash, respects the flag, respects the restart budget) passing, exit 0.
2. Resume precondition relaxed (plan 2a): a crashed/failed CLI session (not only gracefully terminated) can be resumed and its transcript subPath is re-mounted. Show the changed precondition + a test proving a non-graceful-exit session is resumable.
3. jfs_blob monitoring (plan 2b): a metric/alert for jfs_blob growth + per-subtree size exists; PITR coverage of the juicefs DB is documented. Show the manifest/code.
4. Fail-loud on missing CSI (plan 2c): launching an interactive-cli class without transcriptStoreCsiDriver raises a clear startup error/alert. Show a test or the assertion path.
5. Green + shown: type-check passes, new tests pass, `kustomize build` of changed overlays succeeds, `git status` shows only in-scope files (zero under services/claude-agent-py, services/adk-agent-py, src/lib/server/goals).
Report progress each turn. Stop after 40 turns and summarize what remains.
```

### Phase 3 (Postgres foundation — CloudNativePG, PARALLEL, needs cluster access)

```
/goal Phase 3 of docs/long-running-session-durability-plan.md is complete in a NON-PROD target (ryzen or dev) — the workflow-builder Postgres is protected by an HA, backed-up CloudNativePG cluster, deployed in PARALLEL. The existing single Postgres keeps running: NO in-place replacement, NO prod cutover in this goal. Requires cluster access (kubectl). HARD CONSTRAINTS: do not delete or repoint the existing postgresql StatefulSet; do not cut workflow-builder traffic to the new cluster in this goal; add no plaintext secrets (source the DB password from workflow-builder-secrets).

Met ONLY when ALL are demonstrated in THIS conversation by actual kubectl/command output:
1. A CloudNativePG operator + an `instances: 3` Cluster (sync replica) are deployed in the target namespace ALONGSIDE the existing Postgres. Show `kubectl get cluster,pods` healthy (1 primary + 2 standbys Ready).
2. Continuous WAL archiving + scheduled base backups to object storage (PITR) are configured. Show the Backup/ScheduledBackup objects and a completed backup.
3. HA failover validated: delete the primary pod, a standby is promoted, the cluster returns healthy. Show before/after `kubectl` primary role.
4. PITR validated: a point-in-time restore into a throwaway cluster succeeds. Show the restore Cluster reaching healthy and a row/timestamp check.
5. A real (replicated/network) storageClass is used for the new cluster (not node-pinned local-path). Show the PVC storageClass.
6. The cutover PLAN (flag-gated repoint of workflowstatestore + app DB + JuiceFS metaurl, byte-parity check, rollback) is appended to the plan doc; the existing Postgres is still Running and unmodified — show `kubectl get statefulset postgresql`.
Report progress each turn. Stop after 60 turns and summarize what remains. This is the highest-risk phase — if any destructive step would be required, STOP and surface it instead of proceeding.
```

