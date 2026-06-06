# Workflow-Builder System Review — Dapr Workflows, Durable Agents, Kueue

*Lead author review for the system's senior engineer. Grounded in the deployed manifests (PittampalliOrg/stacks @ main), the service code (PittampalliOrg/workflow-builder @ main), live cluster state on `admin@ryzen`, and 2025–2026 upstream research on Dapr 1.17.9, Kueue 0.17.3, and the official dapr-agents 1.0.x framework.*

---

## 1. Executive Summary

**What the system is.** Workflow-builder is a SvelteKit BFF over a three-pillar Dapr-on-Kubernetes execution layer, all colocated in the `workflow-builder` namespace:

1. **Workflow engine** — `workflow-orchestrator` (Python, Dapr Workflow SDK 1.17.1) runs a single registered Dapr workflow, `sw_workflow_v1@1.0.0`, that interprets an in-house "SW 1.0" (CNCF Serverless-Workflow-flavored) document at runtime. `durable/run` steps dispatch via `ctx.call_child_workflow` into per-agent runtime pods; every other slug goes orchestrator → Dapr service-invoke → `function-router` → `{fn-system | fn-activepieces | openshell-agent-runtime | code-runtime | crawl4ai-adapter}`.
2. **Durable agents** — `dapr-agent-py` is built **on the official dapr-agents framework (pinned 1.0.3, version-guarded at boot)**, wrapped in a ~7,700-line `OpenShellDurableAgent` that adds a multi-turn `session_workflow` with `continue_as_new` rollover, a strict-sequential tool loop, nine LLM adapters, and CallAgent multi-agent delegation. Agents are materialized one Deployment-per-published-agent by a Kopf operator, scaling 0↔1 on a wake annotation (idleTtl 1800s).
3. **Kueue capacity** — chart 0.17.3 (`v1beta2` ClusterQueues), one cohort `agent-platform` with five ClusterQueues bound to a single `dev-benchmark` ResourceFlavor, all gated through a bespoke PSI-memory-pressure AdmissionCheck. Gates SWE-bench sandbox pods, the browserstation elastic RayCluster, and eval TaskRuns.

Control plane is Dapr 1.17.9 throughout. The whole stack is GitOps-delivered via ArgoCD (autonomous on ryzen; gated on dev/staging/hub).

**What's strong.** This is a mature, opinionated system, not a prototype. The SW 1.0 → Dapr-primitive mapping is idiomatic and uniformly observable (every hop is a span). Determinism hygiene in the orchestrator body is real (`is_replaying` guards, `current_utc_datetime`, `_freeze` input normalization). The durable-agent layer correctly stands on the GA dapr-agents framework rather than reinventing it, hard-guards the version, and event-sources every LLM/tool/delegation boundary. The Kueue capacity layer is unusually thoughtful — quota pinned to the physical Docker memory wall (incident-driven, documented in `RATIONALE.md`), a promote-only PSI check that never evicts running work, and a clean interactive-vs-batch priority cohort. W3C trace context is propagated end-to-end into ClickHouse + a curated MLflow view. Idempotency discipline (deterministic instance/artifact IDs → UPSERTs) is exactly right for a replay engine.

**The 3–5 highest-leverage improvements** (full detail in §3):

1. **Resolve the PSI AdmissionCheck fail-open/fail-closed contradiction (P1, effort S).** The code default, the docstring, and every ClusterQueue comment say *fail-open*; the deployed env is `PSI_FAIL_CLOSED=true` + `PSI_REQUIRE_COMPLETE_COVERAGE=true` at `replicas: 1`. On the single-node ryzen kubelet-stats-over-apiserver-proxy path (documented-fragile), one observer blip or one missing worker's PSI feed wedges **all new admission across all five queues**. Kueue has no native fail-open. This is a one-line env flip plus a comment fix — the single best risk/effort ratio in the report.

2. **Adopt Dapr 1.17 workflow versioning *before* the next interpreter shape change (P1, effort M).** The interpreter is pinned to a constant `version_name="1.0.0"` and control flow lives in live code, not the instance-pinned version. Any change to the yield sequence is a `NonDeterminismError` hazard for in-flight instances during an ArgoCD rolling restart. The versioning plumbing is half-wired already (`register_versioned_workflow` + per-instance version pin); finish it with named versions + `is_patched` guards.

3. **Close the durable-turn-timer and orphaned-child gaps that feed the "stuck workflow" pain (two P1 items, effort S–M).** The documented 600s in-workflow session-turn timer was *removed* (commit `72154581`) and never replaced — a hung turn inside a successful activity is now unbounded. Separately, on child-workflow timeout the orchestrator raises `TimeoutError` but never terminates the orphaned child agent session. Both are root sources the `DELETE FROM wfstate_state` watchdog exists to reap; fixing them demotes that blunt watchdog (which rollout-restarts the whole 2-replica Deployment) to break-glass.

4. **Stand up alerting/SLOs on telemetry you already collect (P1, effort M).** There is *zero* alerting fleet-wide — no PrometheusRule, ServiceMonitor, Alertmanager, or Grafana alert rule. Dapr workflow metrics, watchdog "stuck workflow detected" lines, and circuit-breaker trips are emitted only as logs nothing consumes; detection latency for a stuck workflow is up to 30 min and notification is human-poll. The hub Grafana already has a ClickHouse datasource and the metrics already land in `otel_metrics_*` — this is incremental.

5. **Bound durable-state payload growth (P1, effort M).** `task_outputs` accumulates every task's full output envelope, is threaded as `nodeOutputs` into *every* `execute_action` activity (quadratic), and is returned as durable workflow output with no cap — colliding with the 16 MiB gRPC ceiling and the `GetWorkItems` tear-down storm (`dapr/dapr#9070`). Claim-check large outputs by reference; add a loud pre-limit guard.

---

## 2. As-Built Assessment

### 2.1 Workflow engine (`workflow-orchestrator`)

**Strengths.** The dispatcher (`sw_workflow.py:3211`) maps SW 1.0 task types cleanly onto Dapr primitives: `call` → `call_activity(execute_action)`; `durable/run` → `call_child_workflow`; `wait` → `create_timer`; `listen` → `wait_for_external_event` (approval gates); `run(workflow)` → child workflow. Timeouts are durable via `when_any(child, timer)`, and benchmark runs deliberately swap to a cancel-event listener to avoid reminders outliving the child — evidence of real awareness of reminder-leak failure modes. Scheduling is idempotent (`OrchestrationIdReusePolicy.IGNORE` + deterministic instance IDs + purge-and-reschedule for terminal). Operationally hardened: a zero-worker watchdog replaces the pod on a dead durabletask worker, an init container gates startup on the read-model schema, gRPC limits raised to 16 MiB, PDB + topology spread on the 2 replicas.

**The real weaknesses.**

- **Versioning is a latent replay landmine.** One interpreter function under a constant `1.0.0`; the actual task graph is the embedded spec, and control flow is live code. A rolling deploy that alters the yield shape throws `NonDeterminismError` on replay of any RUNNING instance. The schedule-time version pin exists (`app.py:854-855, 3161`) but never advances. *(→ Rec 3.1-A)*
- **Zero retry policy.** `grep retry_policy` across the entire orchestrator = **0** hits. Internal activities (`persist_results_to_db`, `log_node_*`, `finalize_mlflow_trace`, `spawn_session_for_workflow`) and child `CreateInstance` have no durable retry. `log_node_start` is even *outside* the per-task try/except, so a DB-pool 503 there fails the whole workflow. CLAUDE.md's advertised `max_attempts=8` lives only in the agent callee, not here. *(→ Rec 3.1-C)*
- **Unbounded durable state.** `task_outputs` accumulates full envelopes, threads them into every activity (`sw_workflow.py:2361`), and returns them as workflow output (`:3574/:3627`). No size guard (`_json_size_chars` is MLflow telemetry only). On Postgres the real ceiling is the **16 MiB gRPC `max-body-size`**, not the oft-cited 2 MB Cosmos record cap — but the quadratic growth and the `#9070` `GetWorkItems` tear-down storm are real either way. *(→ Rec 3.1-D)*
- **Orphaned children on timeout.** `_child_workflow_result_with_timeout` (`:129-148`) raises `TimeoutError` and never terminates the child instance; the orphaned agent session keeps running and replaying, consuming statestore + scheduler reminders. Dapr's parent-child cascade only fires on *explicit* terminate, not on parent *failure*, so the orphan is real on the non-benchmark timeout path. *(→ Rec 3.1-E)*
- **Config drift on concurrency.** Three places disagree: the dead dev-local `workflow-runtime-config.yaml` (32/128, unreferenced), the bound `workflow-orchestrator-no-tracing` Configuration (**128/512**), and the Deployment env / SDK worker limits (128/192/64). The 512 activity ceiling is an outlier relative to the Postgres `maxConns 16`. *(→ Rec 3.4)*
- **Minor:** jq expressions evaluated in the workflow body expose non-deterministic builtins (`now`, `env`) with no allowlist; `then:`-jumps have no cycle/step bound; a 2s `tp.force_flush` runs on the first-execution hot path.

### 2.2 Durable agents (`dapr-agent-py`)

**Strengths.** The single most important architectural fact: this is **not** a from-scratch agent — it subclasses the GA dapr-agents `DurableAgent`, reuses `DaprChatClient`/`AgentRunner`/`MCPClient`/`@workflow_entry`, and hard-guards `dapr-agents==1.0.3` at boot. Every turn boundary (LLM call, each tool, CallAgent delegation, peer session) is a Dapr event-sourced activity, so pod restarts replay deterministically. Memory growth is actively bounded by `continue_as_new` rollover + inline compaction. Anthropic prompt caching is live with extended-cache-ttl and full `cache_read`/`cache_creation` accounting. CallAgent returns the peer's answer inline as a tool_result (no polling round-trip). Conversation state and workflow/actor history are deliberately partitioned into two stores to satisfy Dapr's single-`actorStateStore` constraint.

**The real weaknesses.**

- **The documented 600s session-turn timer is gone.** `grep SESSION_TURN_TIMEOUT|create_timer|when_any` in `dapr-agent-py/src` = **0**. Git proves it: commit `b5f5b0e8` added it; `72154581` ("switch to session-native agent loop") deleted the `when_any` race; `docs/per-agent-runtime.md:259-279` still documents the dead mechanism. The only live timeout is an out-of-band host-monitor thread whose default action is `"warn"`, not terminate. A turn hung inside a *successful* activity (MCP stall, placement stall) is unbounded — the exact stuck class needing manual SQL surgery. *(→ Rec 3.2-A)*
- **`call_llm` is billable, state-mutating, and retried up to 8×.** `WorkflowRetryPolicy(max_attempts=8)` wraps a call that does `generate()` (billable) → append assistant message → `save_state`. A worker death after `generate()` but before Dapr records the result re-runs the whole body on replay → duplicate billing + double-appended message. The existing `_save_assistant_message` dedup is inert here (messages carry no `id`). *(→ Rec 3.2-B)*
- **No cross-provider failover.** Nine adapters are wired (re-patched onto `self.llm` every call, each `try/except: pass`), but `grep failover` = 0. Persistent 5xx/429 from the primary degrades to same-provider retry → empty-response circuit breaker → total turn failure, never a fallback. *(→ Rec 3.2-C — but see the important mechanism correction there.)*
- **Prompt caching is Anthropic-only — but this is mostly a non-issue.** DeepSeek (automatic disk caching) and Kimi K2 (automatic prefix caching) already cache stable prefixes server-side with no client action; the "accounting-only" handling is *correct*, not a gap. The real residual is the Anthropic server-side context-editing modernization. *(→ Rec 3.2-D, P3.)*
- **Session-event delivery is lossy but not blocking.** `_post_ingest` is fire-and-forget on a **daemon thread** (`event_publisher.py:406-408`) — so the "5s LLM hot-path stall" framing is false. The real residual is that events drop on a BFF outage with no buffer/retry. *(folded into Rec 3.1-G; severity reduced.)*
- **Shared blast radius:** one `dapr-agent-py-secrets` (all LLM keys + internal token) per namespace, readable by any agent running arbitrary sandboxed code; statestore Postgres password committed as plaintext `password`. **Maintainability:** `main.py` is ~7,700 lines mixing deterministic workflow bodies, side-effecting activities, telemetry, and HTTP handlers — a real non-determinism audit hazard.

### 2.3 Kueue capacity & scheduling

**Strengths.** Quota right-sizing is incident-driven and documented: the ryzen patch pins `nominalQuota` to the Docker `--cpus/--memory` wall, not kubelet's inflated host-cgroup allocatable, with a `RATIONALE.md` that explicitly warns against naive "size to allocatable." The PSI AdmissionCheck is a genuinely thoughtful adaptive complement to that static budget — **promote-only** (never evicts running work; `controller.py:347` never demotes), 5s poll for low interactive latency, self-marks `Active=True` to avoid the "CQ inactive → all admission blocked" foot-gun, and uses SSA with a stable field manager. Clean priority cohort: `interactive-agent` (1000) reclaims/borrows over `swebench-cohort` (100) and `background-warm` (10). Two-layer defense (PSI admission + `psi-node-guard` taint). **Importantly, the `pod` framework integration IS enabled** — it's on by default in chart 0.17.3 (verified in live `kueue-manager-config` on ryzen and hub, and via a live `pod-`prefixed Workload), so the SWE-bench sandbox quota and PSI check are *not* no-ops. *(This refutes a tempting-but-wrong "gating is silently off" hypothesis — see §6.)*

**The real weaknesses.**

- **The fail-open/fail-closed contradiction (the headline Kueue defect).** Documented fail-open, deployed fail-closed, `replicas: 1`, on a fragile kubelet-proxy path, in front of all five queues. `capacity-observer` is *also* `replicas: 1`, so the chain has two single points of failure. The controller emits only `Pending`/`Ready` — never `Retry`, so a data outage wedges queued work indefinitely rather than releasing quota. *(→ Rec 3.3-A — highest-leverage in the report.)*
- **API-version split (migration debt).** ClusterQueues are `v1beta2`; ResourceFlavor, the AdmissionCheck, all five LocalQueues, and three WorkloadPriorityClasses are still `v1beta1`. Live CRDs confirm `v1beta1 served=true, storage=FALSE`; objects already persist as `v1beta2`. The conversion webhook makes the mix work today, but a future chart that drops `v1beta1` breaks those manifests at apply time — exactly the recreate-time landmine class this fleet has hit. Source-manifest-only fix. *(→ Rec 3.3-B.)*
- **One patch line behind on quota-leak fixes.** Pinned `0.17.3`; `0.17.4` (2026-05-29) fixes are quota-leak / race / MultiKueue reliability — and several target `ElasticJobsViaWorkloadSlices` (which this cluster *enables* for the browserstation RayCluster) and the head-of-line preemption race. Directly relevant to high-churn SWE-bench fan-out. *(→ Rec 3.3-C.)*
- **No gang scheduling for multi-pod units.** `waitForPodsReady` is unset; SWE-bench fan-out and the elastic RayCluster admit pods independently. (Single-pod SWE-bench instances correctly don't need it; this matters only for the Ray case — see §5.)
- **Fairness primitives partly inert on the primary cluster.** `sharePercent` *is* consumed by the renderer to compute `nominalQuota` (it is **not** dead config — see §6), but on ryzen the queues already partition nearly the whole budget with tiny borrow limits and a single flavor, so `flavorFungibility`/`reclaimWithinCohort` have little headroom. No `fairSharing` weights configured.

### 2.4 Cross-cutting: reliability & observability

Observability-rich, alerting-poor, retry-thin. Spans, Dapr metrics, and cAdvisor flow to ClickHouse + a curated MLflow pipeline; W3C context is propagated end-to-end. But there is **no alerting anywhere** (§3.1-F), the orchestrator daprd runs the `no-tracing` Configuration so the most failure-prone hop is blind at the sidecar layer (§3.4), and the JetStream pubsub has `maxDeliver:3` with no DLQ (§3.1-G).

---

## 3. Recommendations

*Only verified, applicable, not-already-implemented recommendations are included. Each is ordered P0→P3 within its theme. Effort S/M/L; Risk and Impact as noted. All file paths are repo-relative; orchestrator/agent paths are in `PittampalliOrg/workflow-builder`, manifests in `PittampalliOrg/stacks`.*

### 3.1 Dapr Workflow engine

#### 3.1-A — Adopt named workflow versions / `IsPatched` so a rolling deploy can't `NonDeterminismError` in-flight instances · **P1** · M / medium-risk / high-impact

- **Problem.** The interpreter is registered once under a constant `version_name="1.0.0"` (`app.py:1111-1116`) with instances pinned to that constant (`:3161`). Control flow is live code (`sw_workflow.py:3211` dispatch + per-task-type handlers). Any change to handler ordering, an inserted activity, or a new yield alters the replay shape → `durabletask.NonDeterminismError` on replay of RUNNING instances during an ArgoCD rolling restart, with old/new code coexisting on the two replicas mid-rollout. No version gate keys interpreter behavior off the instance's pinned version.
- **Recommendation.** Use the versioning capability the pinned SDK already ships: register the interpreter as named versions (V1 non-current + V2 `is_latest`) for structural refactors, and `ctx.is_patched("<id>")` patch guards for additive changes; bump the version constant through the GitOps image-pin flow. Retire old versions only when no in-flight instances reference them; never reuse/rename/reorder a patch id.
- **Why it helps (grounding).** `dapr-ext-workflow==1.17.1` exposes `register_versioned_workflow` and `is_patched`; the underlying `durabletask` `_Registry` keys multiple functions per version and replays each instance against its pinned `version.name` from `orchestratorStarted` history. Confirmed against the Dapr v1.17 release (2026-02-27) and `docs.dapr.io` workflow-versioning. The schedule-time pin plumbing already exists, so this is incremental, not a rewrite.
- **Validate.** Start a long-running V1 instance, deploy a structurally-changed V2 via rolling restart, confirm the V1 instance completes on V1 logic with zero `NonDeterminismError` while new instances run V2 (visible in MLflow/ClickHouse traces + Dapr logs).
- **Note.** SDK is 1.17.1, runtime 1.17.9 — both above the 1.17 threshold.

#### 3.1-D — Bound durable-state payload growth: claim-check large outputs · **P1** · M / medium-risk / high-impact

- **Problem.** `_store_task_output` writes each task's full envelope into `task_outputs` (`sw_workflow.py:759`); the entire map is threaded as `nodeOutputs` into every `execute_action` (`:2361`, quadratic) and returned as durable output (`:3574/:3627/:3658/:3706`). No size guard. This drives `dapr/dapr#9070`-class instability (large accumulated payloads → gRPC `RESOURCE_EXHAUSTED` / `GetWorkItems` stream tear-down) — a concrete contributor to the "stuck workflow" pain.
- **Recommendation.** Apply claim-check: store large agent/crawl/diff outputs by reference (reuse the existing `persist_workflow_artifact` / files store) and pass only a pointer through activity inputs; pass only the *referenced* upstream outputs into each activity, not the whole accumulated map. Add a guard that **fails loudly before the 16 MiB gRPC ceiling** rather than letting Dapr stall silently.
- **Why it helps (grounding).** `dapr.io/max-body-size: 16Mi` is set on the orchestrator Deployment (`:38`); pass-by-reference/claim-check is the recognized Dapr-workflow best practice. The existing artifacts mechanism (`output_summary.py` `SUMMARY_OUTPUT_KEYS` incl. `artifactRef`/`patchRef`) is UI-only and does **not** offload what's threaded into `nodeOutputs` — so the store is reusable but the offload is genuinely unimplemented. `dapr/dapr#6014` (built-in size limit) is still OPEN, so the app-side guard is necessary.
- **Accuracy caveat (important).** The "~2 MB per record" figure is **Cosmos-specific**. The actor/workflow store is PostgreSQL (`Component-statestore.yaml: state.postgresql, actorStateStore=true`), which has no 2 MB row cap (TOAST ≈1 GB/field). Implement the guard against the **16 MiB gRPC ceiling**, not 2 MB.
- **Validate.** Run a many-step workflow with large agent outputs; confirm per-checkpoint durable state stays flat (not quadratic) and the pre-limit guard raises a clear error instead of a silent stall.
- **Sequencing.** Changing `nodeOutputs` shape is replay-affecting — ship the cheap loud guard first; sequence the claim-check offload behind the versioning work (3.1-A).

#### 3.1-E — Terminate orphaned child workflows on parent-side timeout · **P1** · S / low-risk / medium-impact

- **Problem.** On child-timeout, `_child_workflow_result_with_timeout` (`sw_workflow.py:129-148`) raises `TimeoutError` but never terminates the child instance. The orphaned `session_workflow` (own daprd-wake + actor reminders) keeps RUNNING after the parent fails, consuming statestore + scheduler reminders. This is the orphan source the watchdog later reaps via broad `DELETE FROM wfstate_state LIKE` + whole-Deployment rollout-restart (`replicas: 2`, bouncing all healthy in-flight work).
- **Recommendation.** On parent-side timeout, invoke Dapr's terminate/purge (recursive) for `child_instance_id` **via a side-effecting activity** (never inline in the orchestrator body) *before* raising `TimeoutError`. Cover **both** the Dapr `session_workflow` child instance **and** the existing durable agent run (`terminate_durable_agent_run`, `call_agent_service.py:519`).
- **Why it helps (grounding).** Dapr's cascade fires only on *explicit* terminate, not parent failure (confirmed via docs + `dapr#6393`/`#8323` orphan reports); purge deletes associated reminders — the supported alternative to raw `wfstate_state` SQL surgery. `DaprWorkflowClient.terminate_workflow`/`purge_workflow` are already used in `app.py` (`923/965/2030/3450`), so this is idiomatic. Demotes the watchdog from primary recovery to break-glass and reduces MLflow `CardinalityViolation` churn.
- **Validate.** Force a child timeout; confirm the child → TERMINATED (not lingering RUNNING), its scheduler reminders disappear, and the watchdog finds nothing to reap.
- **Scope note.** The benchmark path (`is_benchmark_run`) and the cancel path deliberately avoid the parent timer and defer to external termination — the orphan window is specifically the **non-benchmark** timeout branch.

#### 3.1-F — Add alerting + SLO burn-rate on already-scraped Dapr/watchdog signals · **P1** · M / low-risk / high-impact

- **Problem.** Zero alerting fleet-wide — no PrometheusRule/ServiceMonitor/Alertmanager/Grafana alert rule (`grep` confirmed; observability stack is LGTM + ClickHouse, no Prometheus/Alertmanager instance). The watchdog runs every 30 min and its only "alert" is an unconsumed log line (`ConfigMap...script.yaml:253` "log signal is what alerts on"). Stuck-workflow detection latency is up to 30 min; notification is human-poll.
- **Recommendation.** Sequence: **(1)** discrete log-derived alerts first (lowest effort, highest signal): `stuck workflow detected`, watchdog crash/non-zero exit, circuit-breaker trip, PSI-check stuck-Pending. **(2)** Provision the ClickHouse Grafana datasource where missing. **(3)** Workflow SLI burn-rate SLOs as ClickHouse SQL alert rules on `dapr_runtime_workflow_execution_count{status="failed"}`, operation-latency p90, and actor failure rate. Codify as GitOps so they recreate with the cluster.
- **Why it helps (grounding).** Dapr workflow metrics genuinely land in queryable ClickHouse `otel_metrics_*` (the forwarder has a `prometheus/dapr` receiver → clickhouse exporter, db `otel`). The official `grafana-clickhouse-datasource` plugin supports Grafana unified alerting via SQL + Reduce/Threshold expressions. Metrics present in Dapr 1.17.9.
- **Accuracy caveat.** On **hub**, Grafana *already* has the ClickHouse datasource provisioned (via `overlays/hub → observability-clickhouse-shared`), so it's even more incremental there; the base `grafana.yaml` only shows Loki+Tempo, which can mislead a quick scan. Burn-rate must be expressed as ClickHouse SQL with `$__timeFilter` (not PromQL multi-window), and eval windows must tolerate async OTel ingestion lag.
- **Validate.** Trigger a synthetic stuck workflow → confirm an alert fires within minutes (not 30); induce a failed-workflow spike → confirm the burn-rate alert fires and clears.

#### 3.1-C — Attach `RetryPolicy` to internal activities + child `CreateInstance`; reconcile the two function-router Resiliency CRDs · **P2** · M / medium-risk / medium-impact

- **Problem.** `call_activity`×29 / `call_child_workflow`×7 / `retry_policy`×**0** across the entire orchestrator; no runtime-level default policy. `log_node_start` is outside the per-task try/except, so a DB blip there fails the whole workflow; even the failure-path `persist_results_to_db` has no retry. Separately, two Resiliency CRDs both scope the `function-router` target with conflicting timeouts (`Resiliency-workflow-orchestrator.yaml`: 330s + retry; `Resiliency-workflow-builder.yaml`: 1000s, no retry) → ambiguous effective policy.
- **Recommendation.** Use the native `dapr.ext.workflow.RetryPolicy` (ctor args `first_retry_interval`/`max_number_of_attempts`/`backoff_coefficient`) on the **idempotent** internal activities (the deterministic-keyed UPSERTs — `persist_results_to_db` does `UPDATE ... WHERE id=%s`; `log_node_*`; artifact persistence) and on child `CreateInstance`. Pick **one** authoritative retry layer per failure class: in-code `RetryPolicy` for business/activity errors, Dapr Resiliency for transport timeouts only. Collapse the two function-router Resiliency CRDs into one. Fix the CLAUDE.md framing.
- **Why it helps (grounding).** Dapr docs warn that workflow-retry + resiliency + built-in sidecar retries stack multiplicatively (the `#9070` retry-storm shape) and that retry-policy shape is recorded in durable history (don't alter for in-flight). Idempotency is verified for the proposed set. The SDK accepts `retry_policy` on both call types at 1.17.1.
- **Accuracy caveat.** The "CLAUDE.md advertises a `max_attempts=8` that doesn't exist" framing is slightly unfair: that policy *is* real in the agent callee (`dapr-agent-py` `main.py:5898`) for the `durable/run` child path, which the orchestrator comment correctly says "relies on native retry policy configured on the callee." The genuine gap is the orchestrator's own internal activities + child scheduling. Reword the doc rather than calling it false.
- **Validate.** Inject a transient DB-pool failure on `persist_results_to_db`; before, the workflow fails; after, the activity retries and completes. Confirm a single effective function-router timeout via sidecar resiliency logs.
- **Sequencing.** Retry shape is durable history — introduce alongside versioning (3.1-A). The Resiliency-CRD collapse is a near-free P2 that can ship independently.

#### 3.1-G — Add a DLQ + retry to the orchestrator pubsub (split out the session-event half) · **P2** · M / low-risk / medium-impact

- **Problem.** The JetStream pubsub has `maxDeliver:3` and no DLQ (`Component-pubsub.yaml:39-40`); there is a real push subscriber (`approval-notifier`), so an exhausted/poison message vanishes with no DLQ for inspection/replay.
- **Recommendation.** Add a `deadLetterTopic` **on the Subscription resource** (`approval-notifier`'s programmatic `/dapr/subscribe`, or the declarative Subscription — *not* the pubsub Component, which has no such field) plus a components-target retry in `Resiliency-workflow-orchestrator.yaml`, and a DLQ-drain subscription. The receive side already has `UNIQUE(session_id, source_event_id)` to make redelivery safe.
- **Why it helps (grounding).** Dapr supports DLQ for every pubsub component (incl. JetStream) at 1.17.x and recommends pairing DLQ + retry resiliency + a drain subscription.
- **Accuracy caveats (drop/rescope the second half).** The session-event "move off the blocking POST" half rests on a **misread**: `_post_ingest` is off-thread (daemon thread, `event_publisher.py:406-408`) — there is no hot-path stall, so **drop that motivation**. The residual (events lost on a BFF outage) is real but smaller; if pursued, a small bounded client-side retry/spool in `_post_ingest` is the idiomatic fix, **not** re-routing through pubsub (which would partly undo the deliberate Phase-4 consolidation onto `session_events`). Also note `approval-notifier` currently always returns HTTP 200/SUCCESS even on error, so the DLQ exposure is **latent** (rarely reaches `maxDeliver` exhaustion today) — fix the handler to NACK if you want the DLQ to actually engage.
- **Validate.** Force an honest NACK; confirm the poison message lands in the DLQ topic instead of vanishing.

### 3.2 Durable agents (`dapr-agent-py`)

#### 3.2-A — Restore an in-workflow durable turn timer; default the host-monitor to `terminate` · **P1** · M / medium-risk / high-impact

- **Problem.** `grep SESSION_TURN_TIMEOUT|create_timer|when_any` in `src/` = **0**. The two child-turn yields (`main.py:5514`, `:5525`) are un-raced. The only live timeout is the host-monitor thread, default action `"warn"` (`session_host_monitor.py:39`; `main.py:6335`), which never kills the turn. A turn hung inside a successful activity (MCP/placement stall) is unbounded — the stuck class needing manual `wfstate_state` surgery. `docs/per-agent-runtime.md:259-279` still documents the now-deleted mechanism.
- **Recommendation.** Re-introduce a durable timer racing the child turn: `ctx.when_any([child_task, ctx.create_timer(timedelta(seconds=SESSION_TURN_TIMEOUT))])`; on timer-win, terminate the child and raise so the turn fails deterministically inside the replay model. Flip the host-monitor `nonterminal_timeout_action` default to `terminate` as **defense-in-depth** (`main.py:6507` already branches on it). Update the doc.
- **Why it helps (grounding).** `when_any(child_or_event, create_timer)` is the canonical Dapr durable-timeout pattern (`docs.dapr.io` workflow-patterns), crash-safe across replays, and this exact construct ran in this repo before commit `72154581` deleted it — so it provably works on the pinned SDK. No Dapr/Kueue bump.
- **Refinement.** The two mechanisms are complementary, not redundant: the in-workflow `when_any` is the better primary fix (deterministic, turn-scoped); the host-monitor terminates the whole process and can't cleanly kill a single turn even when set to `terminate` — which *strengthens* the case for the durable timer. Keep the benchmark-progress escape hatch (`6488`) so SWE-bench long activities aren't false-killed.
- **Validate.** Inject an MCP tool that sleeps past the timeout; confirm the workflow → terminated/failed at ~`SESSION_TURN_TIMEOUT`, the child is purged from `wfstate_state`, no orphaned reminder remains, and zero `NonDeterminismError` on replay across a pod restart.

#### 3.2-B — Make `call_llm` idempotent or right-size its retry · **P1** · M / medium-risk / high-impact

- **Problem.** `call_llm` is wrapped in `WorkflowRetryPolicy(max_attempts=8, initial_backoff=4s, max_backoff=45s)` (`main.py:5897-5902`, applied at `:1844-1853`). The base `call_llm` does `generate()` (billable) → `_save_assistant_message` → `save_state`. A worker death after `save_state` but before Dapr records the activity completion re-runs the whole body on replay → re-bills *and* re-appends. The comment at `main.py:2993` explicitly acknowledges the amplification.
- **Recommendation.** Derive an idempotency key from the deterministic instance_id + turn/sequence; short-circuit a replayed `call_llm` that already recorded an assistant message for that key (dedup the appended message and skip `generate()` on a recorded result). **OR** lower `max_attempts` on `call_llm` specifically to absorb only sub-second sidecar blips and let the provider SDK's own `max_retries` handle 5xx/429 (`anthropic.Anthropic(max_retries=4)` already exists). Keep `max_attempts=8` only on genuinely idempotent activities (`run_tool` where idempotent, persist).
- **Why it helps (grounding).** Dapr docs confirm activities are at-least-once and describe the exact window ("worker fails after executing but before the result is recorded → retried"). The existing `_save_assistant_message` dedup is **inert** here because `AssistantMessage` has no `id` field, so duplicate-append protection does not fire — strengthening the case.
- **Note.** The idempotency-key option (first) is the durable fix; `max_attempts` right-sizing is a cheaper partial mitigation (duplicate-billing exists even at `max_attempts=1`, so only a real key fully closes it).
- **Validate.** Kill the worker mid-`call_llm` (after the provider responds, before Dapr commits); confirm on replay the assistant message is not duplicated and no second provider charge (assert via provider usage logs / MLflow token accounting deduped per activity id).

#### 3.2-C — Add an in-app ordered cross-provider failover shim before the circuit breaker latches · **P2** · M / medium-risk / medium-impact

- **Problem.** Nine adapters wired (`main.py:2714-2766`), `grep failover` = 0. Persistent 5xx/429 → Dapr same-provider retry → empty-response circuit breaker trips (`main.py:3000-3028`, `AgentError`) → total turn failure. The MLflow AI Gateway ConfigMap has no LiteLLM fallback/`num_retries`/`router_settings` either, so there's no gateway-level safety net.
- **Recommendation.** Add an **in-app ordered-retry shim**: on persistent 5xx/429 (after the SDK's own retry budget, and *before* the circuit breaker latches), re-patch `self.llm` to the next configured component and re-issue. Fix the circuit-breaker conflation first (it currently counts real-empty and provider-error together at `:2998-3000` and would prematurely latch before a fallback fires). Make the fallback index replay-safe.
- **Why it helps (grounding).** This matches how the dispatch already swaps components per call; ordered provider-fallback chains with per-provider retry budgets are standard practice.
- **Accuracy caveat (drop the "declarative Dapr" framing).** The recommendation's *preferred* mechanism — routing failover declaratively through the Dapr Conversation API / `DaprChatClient` — is **wrong for this stack**: the Conversation API does not support a declarative cross-provider fallback chain (resiliency policies are per-component), the API is **alpha at 1.17**, and these adapters **bypass** it (they monkeypatch `DaprChatClient.generate` to make direct provider HTTP calls — `openai_adapter.py:678-702`, `foundry_adapter.py:547-595`). So the only feasible path is the in-app shim. Scope accordingly; this is the reason the item is P2, not the "high-leverage declarative win" originally advertised.
- **Validate.** Point the primary component at a stub returning 503; confirm the turn completes via the next fallback and the breaker does **not** fire; confirm no duplicate billing across the failover boundary.

#### 3.2-D — Adopt Anthropic server-side context-editing (Anthropic half only) · **P3** · M / low-risk / medium-impact

- **Problem.** The only Anthropic context trimming is the bespoke client-side image-block logic (`anthropic_adapter.py:277-402`); there is no use of server-side context editing.
- **Recommendation.** For **Anthropic only**, adopt server-side context editing (`context-management-2025-06-27` beta + `clear_tool_uses_20250919`) to replace/augment the bespoke image-block trimming (the bespoke logic trims only *image* tool_results; `clear_tool_uses` clears *all* tool_results by token threshold — complementary). Keep cached prefixes byte-identical (`tools→system→messages`, ≤4 breakpoints).
- **Why it helps (grounding).** Confirmed real via the Anthropic context-editing docs (works on the standard Messages API, "best for agentic workflows with heavy tool use").
- **Accuracy caveat (drop the non-Anthropic half).** The premise that DeepSeek/Kimi/Together "pay full input cost every turn" is **false** — DeepSeek context caching is fully automatic (no `cache_control`), Kimi K2 uses automatic prefix caching, and the code's "accounting-only" handling is the *correct* complete posture. There is no Anthropic-style cache-prefix control to add for them (and Anthropic-style content blocks can't traverse the LiteLLM OpenAI shim anyway). Note also Anthropic now positions *server-side compaction* (which this repo already has a rich `src/compaction/` engine for) as the primary long-conversation strategy — so context-editing is a fine-grained complement, making this a modernization, not a fix. Hence **P3**.
- **Validate.** Run a 10-turn coding session and confirm context-editing placeholders appear / cache hits hold (note: a non-Anthropic A/B would show *no* delta because caching already happens — don't waste the cycle).

### 3.3 Kueue capacity & scheduling

#### 3.3-A — Resolve the PSI fail-open/fail-closed contradiction; remove the single-replica chokepoint · **P1** · S / medium-risk / high-impact

- **Problem.** `Deployment-psi-admission-check.yaml`: `replicas: 1` (`:11`), `PSI_REQUIRE_COMPLETE_COVERAGE=true` (`:66`), `PSI_FAIL_CLOSED=true` (`:68`); pod annotation literally reads `...-script-revision: "2026-05-23-psi-full-fail-closed"`. The controller **default** is fail-open (`ConfigMap...script.yaml` docstring `:21-23`; `evaluate()` returns Ready/admit when psi is None unless `FAIL_CLOSED`, `:193-195`), and `ClusterQueue-benchmark-fast.yaml:12-13` documents fail-open. So code+comment say fail-open; the deployed env forces fail-closed. With Kueue's no-native-fail-open contract, an unreachable `capacity-observer` (also `replicas: 1`), a crashed 1-replica controller, or one worker's missing kubelet PSI leaves the check `Pending` and **stalls all new admission across all five queues** — over the exact Talos/Tailscale kubelet-proxy path ops memory documents as fragile. Live-verified on `admin@ryzen` (Kueue v0.17.3; all 5 CQs list `psi-memory-pressure`).
- **Recommendation.** Prefer **(a)** flip `PSI_FAIL_CLOSED=false` (and `PSI_REQUIRE_COMPLETE_COVERAGE=false` so one missing kubelet degrades to admit) to match the documented intent — a 1-line env change plus a comment/docstring fix and the stale "only benchmark-fast references this check" comment. Reject **(b)** (keep fail-closed with ≥2 leader-elected replicas) on this single-node cluster: it doesn't remove the single-observer/single-node-kubelet SPOFs and adds complexity (the controller is a busy-loop reconciler with no leader election today, so 2 replicas would race on Workload status patches). Add a CI grep asserting the env matches the CQ comment.
- **Why it helps (grounding).** Kueue docs + issues `#3543`/`#5891` confirm: admit only when **all** AdmissionChecks reach Ready; a `Pending` check blocks admission; no native fail-open. The static `nominalQuota` is already pinned to the Docker per-worker memory wall (`RATIONALE.md`), so PSI is *adaptive backpressure on top of a hard OOM-safe budget* — you don't lose the OOM floor by failing open. `psi-node-guard` is **not** an independent fallback (it reads the same observer `/snapshot`), which further argues for fail-open.
- **Why P1 not P0.** `reconcile()` is promote-only (never demotes; `:339-348`), so a stall blocks only **new** admissions — running work is not evicted. Latent fragility, not an active outage; the fix is trivially safe.
- **Validate.** Scale `capacity-observer` to 0 and submit a `benchmark-fast` workload: with fail-open it admits within seconds; with current config it hangs `Pending` indefinitely.

#### 3.3-B — Migrate the remaining `v1beta1` Kueue objects to `v1beta2` · **P2** · S / low-risk / medium-impact

- **Problem.** ClusterQueues are `v1beta2`; `ResourceFlavor-dev-benchmark`, `AdmissionCheck-psi-memory-pressure`, all five LocalQueues, three WorkloadPriorityClasses, and (in `hub-tekton`) `ResourceFlavor-hub-build` are still `v1beta1`. Live CRDs: all four kinds report `v1beta1 served=true, storage=FALSE`, `v1beta2 served=true, storage=TRUE`; `storedVersions=["v1beta2"]`. The conversion webhook makes the mix work today; a future chart that drops `v1beta1` breaks those manifests at apply on the next recreate/upgrade — the recreate-time landmine class this fleet has hit (cf. the kueue `ClientSideApplyMigration` wedge).
- **Recommendation.** Convert all the above to `kueue.x-k8s.io/v1beta2` in a single atomic commit while the webhook still serves both; validate via `kustomize build` + `kubectl apply --dry-run=server` (the Application uses ServerSideApply, so server-dry-run matches the real apply path).
- **Why it helps (grounding).** It's a **source-manifest-only** change (objects already persist as `v1beta2`; no etcd surgery, no data migration). `v1beta1` is deprecated with removal pending (the "remove in 0.17" plan slipped — they run 0.17.3 with `v1beta1` still served — so this is latent debt, not imminent).
- **Accuracy caveat.** Do **not** re-render the ryzen RFC6902 patches: they target ClusterQueues only, which are *already* `v1beta2`. Include the three WorkloadPriorityClasses and the hub-tekton ResourceFlavor for completeness.
- **Validate.** `kubectl apply --dry-run=server` with zero conversion warnings; all CQ/RF/LQ/AdmissionCheck/WPC objects report `v1beta2` in `-o yaml`.

#### 3.3-C — Bump Kueue to v0.17.4 for the quota-leak / race fixes that hit fan-out · **P2** · S / low-risk / low-impact

- **Problem.** `Application-kueue.yaml:14` pins `targetRevision: 0.17.3`. v0.17.4 (2026-05-29) is a patch release whose notes are quota-leak / race / MultiKueue-reliability fixes — and several target `ElasticJobsViaWorkloadSlices` (which this cluster enables, `:33-35`, for the browserstation RayCluster) plus a preemption head-of-line race. Running one patch behind on quota-leak fixes on the cluster whose purpose is bursty batch admission is avoidable risk.
- **Recommendation.** Bump `targetRevision` to `0.17.4` (or latest 0.17.x) through the normal promotion flow; review the changelog for quota-accounting/admission interactions with the elastic gate; validate on dev (the gated spoke) before ryzen. Defer the v0.18.0 minor (DRA / concurrent-admission) to a separate evaluation.
- **Why it helps (grounding).** v0.17.4 fixes include verbatim: quota leak during elastic scale-up, duplicate replacement slices leaving quota reserved, and the `workload-slice-name` annotation bug — all gated by `ElasticJobsViaWorkloadSlices`, which this cluster runs. Chart version == appVersion.
- **Accuracy note.** The "do v1beta2 first" dependency is **advisory, not required** — `v1beta1` is served throughout 0.17.x, so the patch bump is independently safe; just avoid compounding both in one PR.
- **Validate.** After the bump, run a SWE-bench fan-out and confirm `benchmark-fast .status.flavorsUsage` returns to zero after completion (no leaked quota) with no admission regressions in `capacity-observer`.

### 3.4 Reliability & observability (cross-cutting)

#### 3.4-A — Re-enable sampled orchestrator daprd tracing so the `call_child_workflow` + service-invoke sidecar spans aren't blind · **P2** · M / medium-risk / medium-impact

- **Problem.** The orchestrator daprd runs `workflow-orchestrator-no-tracing` (`Deployment-workflow-orchestrator.yaml:33`; the Configuration has no `spec.tracing`), so Dapr's own service-invocation and actor/workflow sidecar spans are absent on the orchestrator hop — exactly where the watchdog's failure signature lives (function-router service-invoke + `call_child_workflow` placement/actor hops; the watchdog keys on daprd actor/sub-orchestration log lines). The orchestrator is the **only** wfb workload still on `no-tracing`; every other wfb workload uses `workflow-builder-tracing` (`samplingRate '1'`).
- **Recommendation.** Restore orchestrator sidecar tracing. **Simplest path:** flip the annotation to `workflow-builder-tracing` (or copy its `samplingRate: '1'` tracing block into the no-tracing Configuration). The team's own tracing-config comment states 1.0 covers unparented sidecar spans (service-invocation, actor calls) and that none of ClickHouse/Tempo/Phoenix saturate at this volume; MLflow now ingests only via dapr-agent-py's direct sampled exporter.
- **Why it helps (grounding).** Dapr 1.17 preserves incoming W3C context through workflow scheduling/execution, so BFF → orchestrator → child-workflow → function-router stitches into one trace once tracing is on. No `ignoreDifferences` trap blocks this (the Application ignores `/spec/metric` on `workflow-builder-tracing`, not `/spec/tracing`, and the no-tracing Configuration isn't listed) — propagates via normal GitOps.
- **Accuracy caveats (simplify the prescription).** Drop the original `samplingRate 0.05–0.1` + new tail-sampling scaffolding — it's over-engineered: the MLflow backpressure root cause was already fixed (the `otlphttp/mlflow` HTTP 400 / Huey-on-tmpfs bug), the team deliberately restored `samplingRate '1'` namespace-wide, and the collector already drops health-probe noise (`filter/health_noise`). The orchestrator app *also* emits app-level OTEL spans today (`dapr_invoke.py` wraps every service-invoke in a `dapr.invoke` span), so "blind" is narrower than it sounds — what's missing is the daprd **sidecar-internal** spans (CallLocal, actor/placement, durabletask sub-orchestration). Also correct the activity-to-external caveat: that work landed in the Java SDK, not Python (`dapr#7927` closed not-planned) — manual `traceparent` re-injection inside activities remains needed for full external coverage.
- **Why P2 (regression risk).** The no-tracing config was a real SWE-bench-era mitigation; validate under a fan-out before fleet rollout.
- **Validate.** With tracing on, run a SWE-bench fan-out; confirm MLflow/collector backpressure stays in budget (no dropped exporter queue) **and** a sampled orchestrator trace shows the function-router service-invoke + `call_child_workflow` (CallLocal + sub-orchestration/actor) spans on the orchestrator hop.

---

## 4. Prioritized Roadmap

**Quick wins** (small, low-risk, high leverage — do these first):

| # | Item | Theme | P | Effort | Risk | Impact |
|---|------|-------|---|--------|------|--------|
| 1 | **PSI fail-open env flip** (`PSI_FAIL_CLOSED=false`, `REQUIRE_COMPLETE_COVERAGE=false`) + comment/CI fix | Kueue | **P1** | S | medium | high |
| 2 | **Terminate orphaned children on parent timeout** (via activity, both Dapr child + durable run) | Workflow | **P1** | S | low | medium |
| 3 | **Collapse the two function-router Resiliency CRDs** (ship independently of the retry-shape work) | Workflow | **P2** | S | low | medium |
| 4 | **v1beta1 → v1beta2 Kueue migration** (single atomic commit, server-dry-run gated) | Kueue | **P2** | S | low | medium |
| 5 | **Kueue 0.17.3 → 0.17.4** (dev-first, then ryzen) | Kueue | **P2** | S | low | low |

**Strategic bets / hardening** (larger, sequence deliberately):

| # | Item | Theme | P | Effort | Risk | Impact |
|---|------|-------|---|--------|------|--------|
| 6 | **Restore in-workflow durable turn timer** + host-monitor default `terminate` | Agents | **P1** | M | medium | high |
| 7 | **`call_llm` idempotency key** (or right-size `max_attempts`) | Agents | **P1** | M | medium | high |
| 8 | **Adopt named workflow versions / `IsPatched`** (gates 9 & the retry-shape work) | Workflow | **P1** | M | medium | high |
| 9 | **Claim-check large outputs** + loud pre-16 MiB guard (guard first; offload behind #8) | Workflow | **P1** | M | medium | high |
| 10 | **Alerting/SLOs on existing ClickHouse telemetry** (log-derived alerts → datasource → burn-rate SQL) | Reliability | **P1** | M | low | high |
| 11 | **`RetryPolicy` on idempotent internal activities + child CreateInstance** (behind #8) | Workflow | **P2** | M | medium | medium |
| 12 | **In-app cross-provider failover shim** (fix breaker conflation first; drop the Conversation-API framing) | Agents | **P2** | M | medium | medium |
| 13 | **Re-enable sampled orchestrator daprd tracing** (flip to `workflow-builder-tracing`; fan-out-gated) | Reliability | **P2** | M | medium | medium |
| 14 | **Orchestrator pubsub DLQ** (on the Subscription; NACK the handler; drop the session-event re-route) | Workflow | **P2** | M | low | medium |
| 15 | **Anthropic server-side context-editing** (Anthropic half only) | Agents | **P3** | M | low | medium |

**Sequencing notes.** #8 (versioning) is the keystone for replay-affecting changes — land it before #9, #11, and any interpreter shape change. #6 + #2 together attack the "stuck workflow" root causes and let #10's watchdog alerts become break-glass signals rather than primary recovery. The five quick wins are independent and can ship in parallel.

---

## 5. Strategic Bets Worth Debating

**(a) Adopt more of the official dapr-agents framework wholesale?** *Lean: no, stay incremental.* The system already subclasses GA `DurableAgent` on the same Dapr 1.17.9 engine, so this is alignment, not a rewrite — but the genuinely custom assets (the empty-response circuit breaker, the strict-sequential tool loop that exists *because* the framework's SEQUENTIAL mode still materializes all tool tasks up front, the nine adapters incl. `together`/`kimi`/`foundry`/`gateway` that dapr-agents does *not* natively cover, the `src/compaction/` engine) are real and not turnkey-replaceable. Critically, adopting the framework's native clients would route through the **alpha** Conversation API the adapters deliberately bypass — so it would *discard* working behavior, not save porting cost. **Pro:** less bespoke surface, framework-maintained retries/circuit-breakers. **Con:** loses the custom safety nets and the direct-provider Responses-API/thinking handling; does **not** relieve the Dapr-engine-level ops pain (stuck workflows, sidecar cold-start) since it runs on the identical engine. Verdict: keep the framework base, port feature-by-feature only where it's a clean win.

**(b) Gang scheduling (`waitForPodsReady` / TAS) for SWE-bench?** *Lean: only for the RayCluster, not the fan-out.* SWE-bench single-pod sandbox instances do **not** need gang admission, and selective per-workload `blockAdmission` is **not expressible** in Kueue (`blockAdmission` is a single global field). The legitimate, separate idea is enabling `waitForPodsReady` **globally with `blockAdmission: false`** + a tuned `requeuingStrategy` backoff as a small-cluster deadlock breaker for the over-subscribed fan-out — but that's a different, fresh proposal, and `blockAdmission:true` is being deprecated upstream (`#7656`). Gang admission also conceptually conflicts with the `ElasticJobsViaWorkloadSlices` model this cluster already depends on. **Pro:** breaks partial-admission deadlock. **Con:** mis-scoped as originally framed; real value is narrow. Verdict: a future P2 *if* fan-out deadlocks are observed, scoped to non-blocking `waitForPodsReady`.

**(c) A complement durable engine (Temporal / Restate)?** *Lean: no, but keep it on the table behind a flag.* For an already-Dapr, already-Kubernetes, data-sovereignty stack, Dapr Workflows is the well-justified default (intra-pod sidecar call, self-hosted residency); Temporal/Restate each add a separate control plane to operate. The honest case *for* a complement is narrow: a dedicated operator-facing workflow UI / visibility search (Temporal's strength), or framework-agnostic durable wrapping of third-party agent SDKs without the SW 1.0 interpreter. **Pro:** mature UI + battle-tested versioning. **Con:** new control plane cuts against the sidecar-simplicity posture; migration cost outweighs gain today. Verdict: evaluate only as a **targeted complement behind a backend flag** (matching the team's parallel-rollout posture), never an in-place replacement — and only after exhausting the now-GA Dapr 1.17 versioning (#8), which closes the historical gap that would have justified Temporal.

**(d) MultiKueue across the ryzen+dev fleet?** *Worth debating later.* The flagship 2026 Kueue investment; it would let one manager queue dispatch SWE-bench fan-out to whichever spoke has capacity and make the BFF capacity-snapshot partly redundant. Premature now (three independent installs work; UX still maturing), but the natural endgame for the fan-out admission story.

---

## 6. Rejected / Not-Recommended

These were investigated and **dropped** — recording why builds trust in the survivors:

- **"Enable the Kueue `pod` framework / SWE-bench gating is silently a no-op."** *Refuted on a version-specific fact.* The `pod` integration is **on by default** in chart 0.17.3 (verified in live `kueue-manager-config` on ryzen *and* hub, in the `mpod.kb.io` webhook, and via a live `pod-`prefixed admitted Workload). The "no integrations block ⇒ pod off" inference describes pre-v0.16 behavior. Hand-authoring an `integrations.frameworks:[pod]` block would *regress* by dropping the other ~15 default integrations the RayCluster/JobSets rely on. The benchmark-fast quota + PSI check are genuinely live on the inference path.

- **"Publish session events through Dapr pubsub instead of fire-and-forget HTTP."** *Refuted on four independent grounds:* the POST is off-thread (daemon thread) so there's no 5s hot-path stall; the team **deliberately removed** the pubsub session-event path in Phase 4 in favor of the authoritative `session_events` ingest; the BFF ingest assigns a server-side monotonic sequence under a pg advisory lock (the SSE-replay contract) that a pubsub subscriber can't own; and the cited `deadLetterTopic` belongs on a Subscription, not the Component. (The *DLQ* kernel survives as the rescoped Rec 3.1-G.)

- **"Repin the per-agent runtime image off the retired gitea registry / scale down the 4-replica legacy Deployment."** *Refuted by the GitOps render closure.* The inline `gitea*` strings are kustomize **placeholders**; `images:`/`replacements` rewrite them to `ghcr.io/pittampalliorg/*` on every live render path (component, dev/staging overlays, ryzen), and live pods pull from GHCR. The Application sets `ignoreDifferences /spec/replicas` and live ryzen runs **1** healthy pod, not 4 idle ones. It's also the **active default** durable-agent app-id target — deleting it would break the `durable/run` path.

- **"Add ContinueAsNew-aware payload bounding against the ~2 MB record limit."** *Refuted on the limit.* The 2 MB figure is Cosmos-only; their store is Postgres v2 (BYTEA, ~1 GB). The real ceiling is the 16 MiB gRPC `max-body-size`, and the SDK channel is already raised to 16 MB. The genuinely correct narrow fix (set `dapr.io/max-body-size: 16Mi` on the agent runtime; cap bash tool output mirroring the existing `web_fetch`/`file_read` caps) is a small P3, not the proposed M-effort externalization layer. (The *orchestrator-side* unbounded-growth gap survives as Rec 3.1-D, scoped to 16 MiB.)

- **"Right-size & eviction-protect the Dapr Scheduler StatefulSet as the real driver of stuck workflows."** *Refuted on causation.* The watchdog recovers a SQL `wfstate_state` cascade-purge loop entirely decoupled from the scheduler's etcd; it never touches the scheduler PVC/etcd. The rec also named ryzen as at-risk, but ryzen already overrides the scheduler PVC to 8 Gi + Retain (the base 1 Gi applies only to dev/talos), and there are zero observed etcd-disk incidents. The residual (bump base/dev PVC toward 16 Gi) is P3 hygiene, not the headline.

- **"Retire the watchdog/`wfstate_state` surgery to break-glass now that you're on 1.17.9."** *Refuted on the version-fix attribution.* The 1.17.8 fix targets a *terminal*-instance/deterministic-reschedule retention case; the watchdog's documented stuck class is a *different* mechanism (a parent looping on already-purged child sub-orchestrations — `no such instance exists`), which no verified release note claims to fix. `PurgeInstance` is terminal-only and doesn't apply to the non-terminal looping actor the watchdog targets. The directionally-sound parts (move off blind SQL toward supported lifecycle, tighten the substring `LIKE`, demote residual DELETE) survive as future work *after* empirically re-validating whether the cascade recurs on 1.17.9 — but the "upgrade already fixed it" justification is unproven, so it's not actionable today.

- **"Justify-or-collapse function-router / fix the CLAUDE.md decryption mis-attribution."** *Partially kept, partially deferred.* The **CLAUDE.md fix is correct and free**: `:37`/`:293` claim function-router "owns AES-256-CBC decryption," but `credential-service.ts:214` HTTP-GETs the BFF `/decrypt` endpoint and never decrypts (the real `createDecipheriv('aes-256-cbc')` lives in the BFF `encryption.ts`). Do that doc correction. The **architectural collapse is deferred**, not rejected: `execute.ts` is ~2,964 lines and the router core is ~5,600 LOC of real logic (credential brokering, tracing, code-functions, gitea-repo, execution-logger); collapsing it into the Python orchestrator is a larger refactor than "M" implies, and Knative's own Activator handles `fn-system` cold-start, so the router earns no proxy justification — making "keep + document the boundary" the cheaper arm. Not in the active roadmap; flagged for a deliberate decision.

- **Other Kueue items dropped as already-implemented:** explicit gang for the elastic RayCluster (conflicts with `ElasticJobsViaWorkloadSlices`; `blockAdmission` not per-workload), right-sizing quota below allocatable (the renderer already hard-fails if `budget > alloc − reserve`, and a CI validator asserts `sum(nominalQuota) == budget`), wiring `sharePercent` to `fairSharing.weight` (`sharePercent` is **not** dead config — the renderer consumes it to compute `nominalQuota`; deleting it breaks the renderer + CI gate).

---

## 7. Sources

**Dapr (workflows, runtime, observability):**
- https://blog.dapr.io/posts/2026/02/27/dapr-v1.17-is-now-available/
- https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-features-concepts/
- https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-architecture/
- https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-patterns/
- https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-versioning/
- https://docs.dapr.io/developing-applications/building-blocks/actors/actors-timers-reminders/
- https://docs.dapr.io/developing-applications/building-blocks/pubsub/pubsub-deadletter/
- https://docs.dapr.io/operations/resiliency/policies/
- https://docs.dapr.io/operations/resiliency/policies/circuit-breakers/
- https://docs.dapr.io/operations/hosting/kubernetes/kubernetes-persisting-scheduler/
- https://docs.dapr.io/operations/hosting/kubernetes/kubernetes-production/
- https://docs.dapr.io/operations/troubleshooting/common_issues/
- https://docs.dapr.io/operations/security/mtls/
- https://github.com/dapr/dapr/issues/9070
- https://github.com/dapr/dapr/issues/8323
- https://github.com/dapr/dapr/issues/7927
- https://github.com/dapr/dapr/issues/6014
- https://opentelemetry.io/blog/2026/dapr-workflow-observability/
- https://www.diagrid.io/blog/tuning-dapr-scheduler-for-production
- https://www.dash0.com/blog/deep-diving-into-dapr-workflows-and-opentelemetry-tracing-the-invisible-parts-of-asynchronous

**dapr-agents framework & agent best practices:**
- https://www.cncf.io/announcements/2026/03/23/general-availability-of-dapr-agents-delivers-production-reliability-for-enterprise-ai/
- https://docs.dapr.io/developing-ai/dapr-agents/dapr-agents-core-concepts/
- https://docs.dapr.io/developing-ai/dapr-agents/dapr-agents-patterns/
- https://docs.dapr.io/developing-ai/dapr-agents/dapr-agents-introduction/
- https://docs.dapr.io/developing-ai/dapr-agents/dapr-agents-why/
- https://github.com/dapr/dapr-agents
- https://www.diagrid.io/blog/making-agent-to-agent-a2a-communication-secure-and-reliable-with-dapr
- https://platform.claude.com/docs/en/build-with-claude/context-editing
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://medium.com/@tort_mario/ai-agent-best-practices-production-ready-harness-engineering-2026-guide-c1236d713fac

**Kueue:**
- https://github.com/kubernetes-sigs/kueue/releases
- https://kueue.sigs.k8s.io/docs/concepts/admission_check/
- https://kueue.sigs.k8s.io/docs/tasks/dev/develop-acc/
- https://kueue.sigs.k8s.io/docs/concepts/cohort/
- https://kueue.sigs.k8s.io/docs/concepts/preemption/
- https://kueue.sigs.k8s.io/docs/concepts/admission_check/provisioning_request/
- https://kueue.sigs.k8s.io/docs/concepts/cluster_queue/
- https://kueue.sigs.k8s.io/docs/concepts/workload_priority_class/
- https://kueue.sigs.k8s.io/docs/concepts/workload/
- https://kueue.sigs.k8s.io/docs/concepts/resource_flavor/
- https://kueue.sigs.k8s.io/docs/concepts/topology_aware_scheduling/
- https://kueue.sigs.k8s.io/docs/concepts/multikueue/
- https://kueue.sigs.k8s.io/docs/tasks/manage/setup_wait_for_pods_ready/
- https://kueue.sigs.k8s.io/docs/tasks/run/plain_pods/
- https://kueue.sigs.k8s.io/docs/overview/
- https://github.com/kubernetes-sigs/kueue/issues/3211
- https://github.com/kubernetes-sigs/kueue/issues/6929
- https://github.com/kubernetes-sigs/kueue/issues/7656
- https://developers.redhat.com/articles/2026/04/16/red-hat-build-kueue-1-3-batch-workload-kubernetes
- https://medium.com/google-cloud/kueue-v0-17-whats-new-c2d5ef82f3f6

**Ray / Grafana-ClickHouse / alternatives / LLM rate-limiting:**
- https://docs.ray.io/en/latest/cluster/kubernetes/k8s-ecosystem/kueue.html
- https://grafana.com/docs/plugins/grafana-clickhouse-datasource/latest/alerting/
- https://www.restate.dev/what-is-durable-execution
- https://www.restate.dev/blog/durable-ai-loops-fault-tolerance-across-frameworks-and-without-handcuffs
- https://www.infoq.com/news/2025/09/temporal-aiagent/
- https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-orchestration-versioning
- https://www.typedef.ai/resources/handle-token-limits-rate-limits-large-scale-llm-inference