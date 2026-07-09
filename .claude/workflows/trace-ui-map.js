export const meta = {
  name: 'trace-ui-map',
  description: 'Map service-graph UI, trace tab, OTEL wiring across orchestrator + agents + ClickHouse for the dynamic-script trace experience',
  phases: [{ title: 'Map' }],
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/dynamic-script-engine'

const AREA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'keyFiles', 'dataShapes', 'integrationPoints', 'gotchas'],
  properties: {
    summary: { type: 'string', description: '2-4 sentence architectural summary' },
    keyFiles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'role'],
        properties: {
          path: { type: 'string' },
          lines: { type: 'string' },
          role: { type: 'string' },
        },
      },
    },
    dataShapes: { type: 'array', items: { type: 'string' }, description: 'Concrete types/columns/API contracts with field names' },
    integrationPoints: { type: 'array', items: { type: 'string' }, description: 'Exact seams to hook into (routes, functions, env vars)' },
    gotchas: { type: 'array', items: { type: 'string' } },
  },
}

const AREAS = [
  {
    key: 'servicegraph',
    prompt: `Map the SERVICE GRAPH UI in ${REPO}. Find the sidebar "Service graph" page (likely under /workspaces/[slug]/... search routes for service-graph / service_graph). Read the page + every component it uses + its data source (API routes, adapters). What does it visualize today (nodes=services? edges=calls?), where does the data come from (ClickHouse? Prometheus? Dapr metadata?), how is it laid out/rendered (SvelteFlow? d3? custom svg?), what interactivity exists, does it know anything about workflow runs or traces? Include exact file paths with line ranges, the full data contract of its API, and how it's styled.`,
  },
  {
    key: 'tracetab',
    prompt: `Map the run-detail TRACE tab in ${REPO}. The workflow run page src/routes/workspaces/[slug]/workflows/[workflowId]/runs/[executionId]/+page.svelte has a "Trace" tab. Find what component renders it, what data it fetches (which API routes), what it shows for a normal SW 1.0 run vs a dynamic-script run, and any trace-viewer components in src/lib/components (waterfall, span tree, timeline). Also find any Phoenix/Jaeger/MLflow deep-links from run or session pages. Include exact file paths + line ranges + API contracts (request/response shapes).`,
  },
  {
    key: 'orchotel',
    prompt: `Map OTEL tracing in the workflow-orchestrator at ${REPO}/services/workflow-orchestrator. Read tracing.py and content_tracing.py fully. Explain: how spans are created for workflows/activities (start_activity_span, apply_workflow_activity_context), what the _otel dict carries (traceparent? trace ids?), how dynamic_script_workflow.py + workflows/script_agent_dispatch.py stamp _otel into activities and into the child session dispatch (does the spawn bridge payload / call_child_workflow input carry trace context to the agent?), where the root trace for an execution is created (BFF? orchestrator? execute route), what exporter/endpoint is used (OTLP to what collector), the finalize_mlflow_trace_root activity, and whether workflow_executions rows store a trace id column. Include exact code refs.`,
  },
  {
    key: 'agentotel',
    prompt: `Map OTEL tracing in dapr-agent-py at ${REPO}/services/dapr-agent-py. How does it create spans (search for opentelemetry, tracer, traceparent, TRACEPARENT, span)? Does session_workflow / call_llm / run_tool create spans? Does it ADOPT an incoming trace context from the child workflow input (childInput) or agentConfig or env — i.e., are agent spans connected to the orchestrator's trace, or do they start fresh traces? What resource attributes/service.name does it export as, and to where? Also check how session ids / workflow execution ids get stamped on spans (span attributes). Also briefly: does claude-agent-py differ? Include exact code refs with line numbers.`,
  },
  {
    key: 'traceapi',
    prompt: `Map trace QUERY infrastructure in the BFF at ${REPO}/src/lib/server/otel/ (clickhouse.ts and siblings) plus any /api routes querying traces/spans (search src/routes/api for clickhouse, trace, span, otel). What ClickHouse tables exist (otel_traces? columns?), what query helpers exist (by trace id? by session id? service graph aggregation?), what existing API endpoints return span data to the UI, and what auth/config they need (env vars, CLICKHOUSE_URL). Also check docs/CLICKHOUSE_OBSERVABILITY.md for the ingestion pipeline (collector config — what receives OTLP and writes ClickHouse) and note whether Jaeger is also fed. Include exact file paths, table schemas/column names, and API contracts.`,
  },
]

phase('Map')
const results = await parallel(
  AREAS.map((a) => () =>
    agent(
      a.prompt +
        ' Return ONLY structured findings via the schema. Be concrete: exact paths, line ranges, field names. You are read-only: do not modify anything.',
      { label: `map:${a.key}`, schema: AREA_SCHEMA, agentType: 'Explore' }
    )
  )
)

const out = {}
AREAS.forEach((a, i) => { out[a.key] = results[i] })
return out