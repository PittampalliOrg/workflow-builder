export const meta = {
  name: 'map-fleet-surface',
  description: 'Map all cluster-resource primitives, capacity/KueueViz surface, lifecycle/bulk APIs, real-time mechanisms, and nav for a unified Fleet view',
  phases: [{ title: 'Map', detail: 'five parallel deep readers over distinct subsystems' }],
}

phase('Map')

const AREAS = [
  {
    label: 'sessions-surface',
    prompt: `You are mapping the SESSIONS surface of a SvelteKit app (workflow-builder) so a unified "Fleet" view can be designed. Read these files FULLY and report:
- src/routes/workspaces/[slug]/sessions/+page.svelte (the sessions list page)
- src/routes/workspaces/[slug]/sessions/+page.server.ts or any data loader / .remote.ts in that dir
- src/routes/api/v1/sessions/+server.ts and subroutes (list/query API shape, filters, pagination)
- The sessions table in src/lib/server/db/schema.ts (columns, status enum, project_id, workflow_execution_id, usage, workspaceSandboxName)
- Session status lifecycle values and how "active/running" is determined
- Session Pulse component(s): find src/lib/components/**/session-pulse* and summarize what vitals it shows and which API it polls (pricing/cost/context/cache)
Report as structured markdown: (1) Sessions list page: columns shown, filters, actions, how it fetches+refreshes (SSE? poll? interval?), any existing row-selection. (2) Session data model: key columns + status values. (3) Session→sandbox/workload linkage fields. (4) Session Pulse vitals + endpoints. (5) Exact file paths + line ranges for anything a redesign would touch. Be precise with file paths. Return the report as your final message.`,
  },
  {
    label: 'capacity-kueueviz',
    prompt: `You are mapping the CAPACITY / KueueViz surface of the workflow-builder SvelteKit app. Read FULLY and report:
- src/routes/workspaces/[slug]/capacity/+layout.svelte, +page.server.ts, +layout.server.ts
- src/routes/workspaces/[slug]/capacity/overview/+page.svelte and overview/data.remote.ts
- src/routes/workspaces/[slug]/capacity/workloads/+page.svelte
- src/routes/api/capacity/overview/+server.ts
- src/routes/api/kueueviz/[...endpoint]/+server.ts and api/kueueviz/yaml/+server.ts
- src/lib/server/kueueviz/{client.ts,index.ts,projections.ts,rest.ts,endpoints.ts,types.ts,pool.ts}
- src/lib/stores/kueueviz/{workloads,cluster-queues,local-queues,resource-flavors,workload-detail,shared}.svelte.ts
- src/lib/components/capacity/*.svelte and src/lib/components/capacity/overview/*.svelte (list each component + one-line purpose)
- src/lib/types/capacity.ts
- src/lib/server/capacity/{observer.ts,coverage.ts,ownership.ts,business-work.ts}
Report structured markdown: (1) How capacity data flows from Kueue (kueueviz backend? direct k8s? WebSocket/SSE?) to the UI, including real-time mechanism. (2) The full list of capacity components and what each renders (gauges, donut, workload-table, session-capacity-card, resource-flavor-strip, pressure-panel, etc.). (3) Data shapes in capacity.ts + projections. (4) What a "workload" object contains and how it maps to an owning primitive (ownership.ts / business-work.ts — session? workflow? benchmark?). (5) How per-session resource usage is computed/shown (session-capacity-card). (6) Reusable building blocks for a unified Fleet view. Exact file paths + line refs. Return the report as your final message.`,
  },
  {
    label: 'lifecycle-bulk-actions',
    prompt: `You are mapping the LIFECYCLE / STOP control plane of workflow-builder so a BULK multi-select stop can be added. Read FULLY and report:
- src/lib/server/lifecycle/{index.ts,cascade.ts,resolvers.ts,reaper.ts,ownership.ts} (the Lifecycle Controller SSOT)
- The stopDurableRun entry point: its signature, target.kind values (workflowExecution|session|evalRun), modes (interrupt|terminate|purge|reset)
- src/routes/api/v1/sessions/[id]/stop/+server.ts and any .../stop/status route
- src/routes/api/workflows/executions/[executionId]/stop/+server.ts (and status)
- Any benchmarks/evaluations run cancel routes: src/routes/api/benchmarks/runs/[id]/cancel, src/routes/api/evaluations/runs/[id]/cancel
- The coordinator_owned gating (ownsBenchmarkOrEvalRun / ownsBenchmarkOrEvalRunForSession) — when a session/execution stop returns 409
Report structured markdown: (1) stopDurableRun full contract: params, modes semantics, return values (202 stopping vs 200 vs 409). (2) Per-primitive stop endpoints with exact request/response shapes. (3) coordinator_owned rule: which primitives can't be stopped individually and what must be cancelled instead. (4) The cleanest way to implement a BULK stop endpoint (loop stopDurableRun? new endpoint? what auth/CSRF, what project scoping) given the existing controller — propose a concrete server route signature and how it would fan out + report per-item results. (5) Exact file paths + line refs. Return the report as your final message.`,
  },
  {
    label: 'other-primitives-nav',
    prompt: `You are inventorying ALL cluster-resource-consuming primitives in workflow-builder beyond sessions, plus the app NAVIGATION, so they can be consolidated into one unified Fleet view. Read FULLY and report:
- src/routes/workflows/+page.svelte and the workflow EXECUTIONS list (find routes/components that list workflow_executions with status RUNNING; src/routes/api/workflows/executions* )
- Benchmarks/eval runs surfaces: src/routes/workspaces/[slug]/benchmarks/** (runs list, run detail), src/lib/components/benchmarks/*, the benchmark_runs / benchmark_run_instances data model in schema.ts
- src/routes/sandboxes/+page.svelte (and its loader/API) — what it lists (agent-sandbox CRs / Sandbox pods), columns, actions
- The app sidebar / nav: find the layout component(s) that render the left nav (search src/lib/components for 'nav', 'sidebar', 'app-shell', and look at src/routes/+layout.svelte and workspaces/[slug]/+layout.svelte). List every nav item + its route.
- How workflow executions, benchmark runs, and sandboxes each map to a Kueue Workload / consume cluster capacity
Report structured markdown: (1) Complete inventory of resource-consuming primitives (session, workflow execution, benchmark run + instances, eval run, sandbox pod, warm pool) — for each: data model table, status values, where listed in UI today, how to stop/cancel. (2) The sidebar nav structure (every item + route + which file renders it) so we know where to add a new top-level entry. (3) Which surfaces are "disparately located" and could be consolidated. Exact file paths + line refs. Return the report as your final message.`,
  },
  {
    label: 'realtime-and-events',
    prompt: `You are mapping the REAL-TIME data mechanisms + cross-links in workflow-builder, to power a live unified Fleet view. Read FULLY and report:
- All SSE endpoints: search src/routes/api for '+server.ts' files returning text/event-stream or ReadableStream (e.g. /api/v1/sessions/[id]/events/stream, /api/v1/gitops/events/stream, any capacity/workloads stream). List each SSE route + what it streams + the event shape.
- The session_events model + appendEvent (src/lib/server/**): event categories (agent.message, session.status_*, agent.llm_usage, etc.)
- How the sessions list and capacity pages currently get LIVE updates (polling interval? SSE? svelte stores with timers?) — quote the relevant code.
- Pricing/cost live endpoints: src/routes/api/v1/pricing, /api/v1/usage, /api/v1/cost, /api/v1/limits/live — request/response shapes
- The kueueviz backend connection: does src/lib/server/kueueviz connect to a websocket (kueue-kueueviz-backend) or REST? How fresh is the data?
- Cross-link helpers: /api/workflows/executions/[executionId]/sessions, session→workflow_execution_id
Report structured markdown: (1) Table of every live/streaming endpoint + payload. (2) The recommended real-time strategy for a Fleet view aggregating sessions + workflows + workloads + capacity (single new SSE aggregator? reuse kueueviz stream + sessions poll? interval?). (3) Live cost/usage/limits endpoints + shapes. (4) Freshness characteristics of kueueviz data. Exact file paths + line refs. Return the report as your final message.`,
  },
]

const reports = await parallel(
  AREAS.map((a) => () => agent(a.prompt, { label: a.label, phase: 'Map' }))
)

return AREAS.map((a, i) => ({ area: a.label, report: reports[i] }))
