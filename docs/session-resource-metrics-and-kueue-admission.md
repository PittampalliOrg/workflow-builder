# Session Resource Metrics & Usage-Aware Kueue Admission

**Status:** evaluation / decision doc (2026-06-16). Prompted by dev CLI sessions hitting "stuck `rescheduling`" — fixed short-term by raising the `interactive-agent` Kueue quota + cutting per-session requests (stacks `cf67c389a`), but that exposed a deeper question: **what do we actually measure about resource consumption, and can admission be driven by real usage instead of static requests?**

This doc maps (1) the metrics we capture today, (2) the gaps, (3) options for more robust metrics, and (4) what Kueue can/does do for usage-aware admission — with a recommendation. It does **not** propose a build; it's the artifact to decide from.

---

## 1. What we capture today

### 1a. Per-session LLM / agent telemetry (rich)

Emitted to the append-only `session_events` stream (agent → BFF `/api/internal/sessions/[id]/events/ingest`), via the shared `event_publisher.py` (dapr-agent-py / claude-agent-py / cli-agent-py):

| Event | Fields | Source |
|---|---|---|
| `agent.llm_usage` | `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `ttft_ms`, `duration_ms`, `recovery_attempts`, `success` (+ OTEL `trace_id`/`span_id` in incremental tier) | `services/dapr-agent-py/src/event_publisher.py` (per LLM call) |
| `agent.context_usage` | `context_window_size`, `context_used_percentage`, `context_*` breakdown, `context_count_method` (`provider_usage` vs `local_advisory`) | `services/dapr-agent-py/src/compaction/tokens.py` |
| `agent.iteration` | `index`, `max` (turn counter) | `main.py` |
| `agent.circuit_breaker_tripped` | `reason`, `streak`, `threshold`, `last_error` | `main.py` |

Consumed by **Session Pulse** (`src/lib/components/sessions/session-pulse.svelte`) + `/api/v1/{usage,cost,limits/live}` + `MODEL_PRICING` (`src/lib/server/pricing/model-pricing.ts`) → tokens, live cost, context %, per-model/per-agent rollups.

**CLI caveat:** codex + claude report real tokens (native OTEL + claude transcript `usage`); **agy is an ESTIMATE** (~4 chars/token; no native usage anywhere) — see `[[project_cli_terminal_ux]]`.

### 1b. Actual pod resource consumption (exists, but coarse)

Real CPU/memory **is** observed — in two places — but only cluster/class-level and **never persisted or attributed per session**:

- **BFF metrics reader** `src/lib/server/metrics/resources.ts` → Kubernetes Metrics API (`metrics.k8s.io`, metrics-server) → per-pod actual CPU (millicores) + memory (MiB), bucketed by class (agent-runtime / sandbox / orchestrator / …). 15s rolling window, ephemeral. Feeds the admin dashboard via `src/lib/server/metrics/aggregate.ts`.
- **capacity-observer** (stacks `kueue-capacity/manifests/capacity-observer/observer.py`) → scrapes kubelet `/stats/summary` per worker → per-pod `observedResources` (actual cpu/mem/ephemeral) **and node PSI** (memory/cpu/io pressure) **and** Kueue queue state → exposes `/snapshot` (JSON) + `/metrics` (Prometheus). The Fleet/capacity panel (`src/lib/server/capacity/business-work.ts`) shows `requestedResources` vs `observedResources` at class level.

### 1c. Trace/metric stores available

ClickHouse `otel.otel_traces` + `obs.llm_spans` (token fields per span), Phoenix, MLflow — queryable; deep-linked from sessions via stamped `trace_id`.

---

## 2. Gaps

1. **No per-session "resources actually consumed."** We store the sandbox pod name (`sessions.sandboxName`/`runtimeSandboxName`) and the capacity-observer already has per-pod `observedResources` — but they're never **joined to `session_id` or persisted** (peak memory, CPU-seconds). So we can't answer "how much CPU/mem did this session actually use" historically.
2. **Requests are guesses, not measured.** Per-session Kueue requests (`agentHostCpu`/`agentHostMemory` in `SANDBOX_EXECUTION_CLASSES_JSON`) are hand-tuned. We just halved CLI requests (500m/1Gi → 250m/512Mi) by intuition — we have no measured working-set distribution to right-size from.
3. **agy token usage is estimate-only.**
4. **`sessions.usage` is re-aggregated on read**, not written at ingest — fine for now, but means no cheap historical per-session totals table.

---

## 3. Can we track more robust metrics? (options)

| Option | What | Effort | Notes |
|---|---|---|---|
| **A. Attribute + persist per-session pod usage** | Join capacity-observer `observedResources` (or metrics-server) by pod name → `session_id`; periodically write peak-mem / cpu-seconds into `sessions.usage` (or a new `session_resource_samples`). Emit an `agent.resource_usage` session event. | Medium | **The data already exists** in the observer — this is plumbing, not new collection. Enables right-sizing + per-session cost-of-compute. **Recommended first step.** |
| **B. Right-size requests from measured usage (VPA recommender)** | Run Vertical Pod Autoscaler in *recommendation-only* mode on the sandbox pods; read its recommendations to set `agentHostCpu/Memory` requests from observed P90, instead of guessing. | Medium | VPA isn't deployed today. Recommendation mode is safe (no auto-mutation of the ephemeral pods). Closes gap #2 properly. |
| **C. Close the agy token gap** | (Already evaluated — `[[project_cli_terminal_ux]]`): only `/context` TUI has real agy tokens; an egress proxy would be vendor-agnostic but MITM-heavy. Decision was: keep estimate. | — | No change recommended. |
| **D. Persist usage at ingest** | Update `sessions.usage` incrementally in `appendEvent` instead of re-aggregating. | Low | Perf/cleanliness, not new signal. |

---

## 4. Kueue admission: requests vs actual usage

**Fundamental:** Kueue admits on **pod requests vs `nominalQuota`** (static), **not live container usage** — by design. But it offers real hooks to react to actual usage, and **we already use the main one**:

### Already live on dev (verified)
- **PSI AdmissionCheck** (`kueue-capacity/manifests/psi-admission-check/`) — a custom AdmissionCheck controller wired to **all 5 ClusterQueues** (incl. `interactive-agent`), `Active=True`. It gates admission on **actual node Pressure Stall Information** from kubelet (`memory.some/full.avg60`, `io.full.avg60`, `cpu.some.avg60`), fed by the capacity-observer. Promote-only (admits when pressure is low; doesn't evict on transient spikes; fail-closed). **This *is* usage-aware admission** — it stops admitting new sandboxes when nodes are genuinely under memory/IO/CPU pressure, regardless of quota.
- **Cohort + borrowing/lending** — all queues share cohort `agent-platform` (v1beta2 `cohortName`), with preemption (`reclaimWithinCohort`/`borrowWithinCohort`/`withinClusterQueue: LowerPriority`). interactive-agent (post-fix) = nominal cpu 21 + **borrow 5.2** (≈26 effective). Reacts to *demand*, not live usage. (Pre-fix the 6.7 nominal × small borrow capped it ≈8.4 cpu — the real cause of the starvation, not "no cohort".)
- Kueue **0.17.3**, `v1beta2` — AdmissionChecks, fair sharing, visibility API all available.

### Options to make admission more usage-aware

| Option | What | Pros | Cons |
|---|---|---|---|
| **K1. Right-size requests (pairs with §3-B)** | Set requests from measured usage so `nominalQuota` ÷ request reflects what pods *actually* use. | Biggest practical win — makes the static quota model accurate; we already partly did this. No new admission machinery. | Still request-based; needs the VPA/measurement loop. |
| **K2. Tune the existing knobs** | Raise quota / borrowingLimits where nodes have headroom; tune PSI thresholds (`PSI_MAX_*_AVG60_PCT`) so admission throttles earlier/later on real pressure. | Zero new components; PSI already wired. | Coarse; per-cluster tuning. |
| **K3. Custom metrics-driven AdmissionCheck** | A second AdmissionCheck (like PSI) that gates on **observed-usage headroom** from the capacity-observer (`allocatable − observedUsage` vs requests) rather than quota — i.e. admit only if the cluster is *actually* under-utilized. | True usage-based admission beyond node pressure; capacity-observer already exposes the data. | New controller to own; risk of over-admitting (requests < usage) then OOM — must stay conservative; duplicates what good request-sizing achieves more simply. |
| **K4. Enable cohort fully / fair-sharing** | Ensure borrowing actually lets interactive consume benchmark's idle quota (raise interactive `borrowingLimitPercent`). | Dynamic sharing without static reallocation. | Borrowed quota is reclaimable (preemptible) — interactive sessions could be evicted when benchmark ramps. |

---

## 5. Recommendation

1. **Measure before tuning more (§3-A).** Wire the capacity-observer's existing per-pod `observedResources` to `session_id` and persist peak-mem / cpu-seconds (+ an `agent.resource_usage` event). Low-risk plumbing of data we already collect; turns request-sizing from guesswork into data.
2. **Right-size requests from that data (§3-B / K1).** Optionally VPA-recommender. This makes the *existing* request-based Kueue model accurate — the highest-leverage, lowest-complexity path.
3. **Keep PSI as the actual-usage safety net (already live).** Tune its thresholds (K2) rather than building a second usage-based AdmissionCheck (K3) unless measurement shows requests systematically diverge from usage.
4. **Defer K3** (custom observed-usage AdmissionCheck) — only worth it if, after right-sizing, we still want to over-commit quota and rely on live headroom. Higher risk (OOM if requests undercount), and it largely duplicates good request-sizing.

Net: the quota/request fix already removed the immediate pain; the durable improvement is **per-session usage measurement → request right-sizing**, with PSI continuing to gate on real node pressure. We do **not** need to replace Kueue's request-based model to get usage-aware behavior — we already have it (PSI), and accurate requests make it correct.

---

**Related:** `[[project_dev_cli_capacity_fix]]` (the quota/request fix + the sandbox-reap leak), `[[project_cli_terminal_ux]]` (agy token estimate), `docs/interactive-cli-sessions.md`, stacks `kueue-capacity` component.
