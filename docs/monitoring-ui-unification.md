# Monitoring UI Unification — the "Observe" hub (Fleet → Run → Session)

**Status:** design / phased-build (chosen direction, not yet implemented). **Owner-decision recorded 2026-06-20:** unified Observe hub via scope-drill (Option A), delivered through incremental phases; conservative run-tab pruning.

## Problem / context

The app accreted **the same master-detail monitoring pattern, implemented three times at different scopes**, on disconnected routes with three different metric vocabularies — plus several genuinely redundant pages. After the recent unified **Run Console** ("Live" tab, replacing the old Overview link-list), the duplication is obvious and worth consolidating.

The user asked two things: (1) prune run-detail tabs that are stale after major system changes, and (2) unify the fleet view + overall workflow/session monitoring + capacity metrics with the workflow-detail UI "in a cohesive way," explicitly inviting a different architecture/layout/navigation.

## The core insight — one recursive shape at three scopes

| Scope | list / rail | detail | aggregate metrics | today's route(s) |
| --- | --- | --- | --- | --- |
| **Fleet** (all work) | fleet table (sessions + runs + benchmarks, live) | `fleet-detail-sheet` (inline stream) | capacity headroom + cost + usage | `/capacity/{active,overview,workloads}`, `/sessions`, `/runs`, `/usage`, `/cost`, `/dashboard` |
| **Run** (one execution) | session rail (by node) | session transcript | `run-metrics-bar` | run-detail **Live** tab |
| **Session** (one) | event list | event detail | `session-pulse` | `/sessions/[id]` |

Every level is **master-detail + an aggregate strip**. They should be one shell you *zoom* through, not separate destinations you navigate between.

### Confirmed redundancies (from the surface audit)
- `/sessions` (sessions-only list) is a **strict subset** of `/capacity/active` — the Fleet already lists all sessions + runs + benchmarks with live activity sparklines, resource req-vs-actual, bulk-stop, and an inline live-stream drawer.
- `/runs` is another filtered view of the same work-set.
- `/cost` + `/usage` are **dual aspects of one token dataset**.
- `/sandboxes/dashboard` ⊂ `/admin/metrics` (system pod/work snapshot).
- The new per-run **Live console** is a run-scoped re-implementation of the Fleet's master-detail+stream pattern.

## Target architecture — the "Observe" hub

One top-level **Observe** section: a **single master-detail shell with a scope switcher** that drills **Fleet → Run → Session in place**, never changing page chrome or mental model.

```
OBSERVE  (one shell)                        scope: Fleet ▸ Run ▸ Session
┌── lens: [All work | Sessions | Runs | Benchmarks] ──────────────┐
│  ● run  gan-harness-cli   ▶ running   $13.63  7 sess   2m       │  ← rows = work items
│  ● sess plan              ✓ done      $0.46          (live ●)   │     (the Fleet table)
│  …                                                              │
├─────────────────────────────────────────────────────────────────┤
│  Capacity headroom · queue pressure · cost · usage  (collapsible)│  ← FLEET-scope aggregate
└─────────────────────────────────────────────────────────────────┘
   click a run     → Run Console   (session rail + transcript + run-metrics-bar)   ← RUN scope
   click a session → Session view  (event list + detail + session-pulse)          ← SESSION scope
   breadcrumb zooms back out:  Fleet ‹ Run ‹ Session
```

- **Fleet scope** = today's `/capacity/active` fleet table, with `/sessions` and `/runs` folded in as **lens filters** (saved views), and capacity/cost/usage as the **collapsible aggregate panel** at the bottom (the fleet-scope analogue of `run-metrics-bar`/`session-pulse`).
- **Run scope** = the existing **Run Console** (`run-console.svelte`) shown *in place* when a run row is selected.
- **Session scope** = the existing **`session-transcript.svelte`** + `session-pulse` shown in place when a session row (or a rail card) is selected.
- **Cluster capacity introspection** (`/capacity/overview` gauges/headroom/PSI, `/capacity/workloads` Kueue) stays a distinct **"Infra" lens** within Observe — it answers "is the cluster healthy / where's the headroom," which is complementary to "watch my work," not a row-drill. It's reachable from the same hub but is not on the Fleet→Run→Session spine.
- **Workflow-detail editor** keeps its **Runs** tab, but each run **links into the Observe hub at Run scope** instead of duplicating run-list/console logic.

### Navigation / IA change
Collapse the scattered monitoring entries into **one Observe group** with lenses, and dedupe Analytics:
- **Remove as standalone nav items:** Managed Agents › Sessions, Managed Agents › Runs, Operate › Fleet (→ all become lenses of Observe › Fleet).
- **Observe** group: `Fleet` (All work / Sessions / Runs / Benchmarks lenses) · `Infra` (capacity overview + Kueue workloads) · `Cost & Usage` (merged) · `Logs` · `Traces`.
- **Merge** `/cost` + `/usage` → one **Cost & Usage** page; **merge** `/sandboxes/dashboard` → `/admin/metrics`.
- `nav-config.ts` (`NAV_GROUPS` SSOT) + `sidebar.svelte` are the only nav edit points.

## Run-detail tab pruning (conservative — chosen)

Run-detail has **10 tabs**; most show empty on simple runs.

| Tab | Decision | Why |
| --- | --- | --- |
| **Live** | keep (default) | the unified Run Console |
| **Outputs** | keep | generic `workflow_artifacts` gallery |
| **Canvas** | keep | only structural/diagram view |
| **Timeline** | keep | forensic chronological feed + turn outline |
| **Trace** | keep | InvestigationStudio (goal DAG / waterfall / spans); remove the dead **MLflow** deep-link (ClickHouse is primary) |
| **Steps** | **drop** | legacy SDK `tool_call_*` logs; fully superseded by Timeline/Live CMA events |
| **Code** | **conditional** | show only when the run has code-checkpoints |
| **Plan** | **conditional** | show only when a plan artifact / `PLAN.md` exists |
| **Browser** | **conditional** | show only when `browserArtifacts.length > 0` |
| **Agents** | **conditional** | show only when >1 agent run; later fold into a Live-rail drill-down drawer |

Net: simple runs show ~5 tabs instead of 10; nothing capable is lost. (A more aggressive future step — merge Timeline into Trace, Agents into a Live drawer — is deferred; see Out of scope.)

## Reuse (do NOT rebuild)

- **Just built:** `run-console.svelte`, `run-metrics-bar.svelte`, `session-transcript.svelte`, `transcript-model.ts`, `GET /api/workflows/executions/[id]/metrics`.
- **Fleet:** `capacity/active` fleet table, `capacity/fleet/activity-cell.svelte`, `capacity/fleet/fleet-detail-sheet.svelte` (lazy inline session/exec stream — the drill pattern already exists), `getFleetActivity`.
- **Capacity/Infra:** `capacity/overview/*` (gauges, trends, headroom-forecast, pending-duration-histogram, contributor-heatmap, PSI), `capacity/workload-table.svelte`, KueueViz `createWorkloadStream`/`createClusterQueueStream`, `getCapacityOverview`/`getCapacity*Trends`.
- **Session:** `session-pulse.svelte`, `session-resources-panel.svelte`, `session-capacity-card.svelte` (consolidate the 3 compute readouts to one).
- **Shell/layout:** `observability-layout.svelte` (resizable 2-panel), the `investigation-studio` selection-store pattern, the `/admin/gitops/system` SSE event-feed pattern.
- **Streams:** `createExecutionStream`, `createSessionStream` (multi-subscribe proven), KueueViz streams.
- **Data:** `GET /api/v1/sessions`, `/api/v1/runs`, `/api/v1/usage`, `/api/v1/cost`, `/api/workflows/executions/[id]/{sessions,metrics,nats-stream,status}`, capacity observer endpoints. **No new backend required for Phases 1–3.**

## Phased build (incremental, low-risk first)

- **Phase 1 — Dedupe + cross-link (≈ the conservative "Option B"; foundation, ships value immediately).**
  - Run-tab pruning (drop Steps, conditional Code/Plan/Browser/Agents, kill MLflow link).
  - `/sessions` and `/runs` become **filtered entry points into the Fleet** (`/capacity/active`): delete the duplicate list implementations, keep deep-links (`?lens=sessions|runs`, `?status=`, `?workflowId=`).
  - Merge `/cost` + `/usage` → one **Cost & Usage** page; merge `/sandboxes/dashboard` → `/admin/metrics`.
  - No nav-group restructure yet (just point the old items at the deduped surfaces).
- **Phase 2 — The Observe shell + scope-drill.**
  - Introduce the Observe master-detail shell wrapping the Fleet table; selecting a run renders `run-console` in place, selecting a session renders `session-transcript` in place; breadcrumb zoom-out. Reuse `observability-layout` for the resizable split.
  - Fleet-scope aggregate panel (capacity headroom + cost + usage roll-up) as the collapsible strip.
  - Restructure nav into the **Observe** group with lenses; retire the standalone Sessions/Runs/Fleet items.
- **Phase 3 — Cohesion polish.**
  - Workflow-editor **Runs** tab links into Observe @ Run scope (drop its embedded run-list logic).
  - Consolidate the 3 session compute readouts (`session-pulse` / `session-capacity-card` / `activity-cell`) onto one data source.
  - Consistent metric vocabulary + formatting across all three scopes.
- **Phase 4 — (optional) Aggressive tab merge + measured capacity.** Merge Timeline into Trace + Agents into a Live drawer; wire `capacity-observer` per-pod usage to `session_id` (per `session-resource-metrics-and-kueue-admission.md`) so the fleet/aggregate panels show *measured* compute, not just requests.

## Pros / cons of the chosen direction

**Pros:** one mental model for all monitoring; deletes three duplicate list implementations; capacity/cost/usage become contextual rather than separate destinations; the just-built Run Console + Pulse drop straight in; scales to many concurrent sessions; phased so Phase 1 ships value with low risk.

**Cons / risks:** Phase 2 is a real refactor (mega-shell perf — bound concurrent streams as the Run Console already does); nav restructure is disruptive (mitigate with redirects from old routes); "Infra" capacity view must stay distinct so the work-spine doesn't get muddied with cluster introspection; benchmarks/evals are work-items too and must fit the Fleet lens model.

## Out of scope (for now)

- Workflows-as-code / parallel-fork execution changes (`workflow-execution-architecture.md`).
- A second usage-based Kueue AdmissionCheck (PSI is already live; just surface it).
- Replacing the standalone `/sessions/[id]` and `/observability/[traceId]` deep-link pages (kept for sharing/bookmarks).

## References

- `docs/cma-parity.md` (workspace-scoping invariant — extend it to runs/work/resources), `docs/session-resource-metrics-and-kueue-admission.md` (measured per-session compute — Phase 4), `docs/workflow-execution-architecture.md` (interpreter model).
- Prior art: `/admin/gitops/system` (SSE event-feed "mission control"), `observability/investigation-studio.svelte` + `observability-layout.svelte` (resizable multi-view shell), `capacity/*` (fleet + gauges).
- Built foundation: the unified Run Console (`run-console.svelte` et al., PRs #230/#231).
