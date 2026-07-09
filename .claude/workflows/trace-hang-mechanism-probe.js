export const meta = {
  name: 'trace-hang-mechanism-probe',
  description: 'Distinguish Dapr workflow payload-size stall vs MCP transport hang for the get_logs reviewer freeze',
  phases: [{ title: 'Probe', detail: '4 parallel read-only probes: statestore sizing, payload metric/logs, MCPClient timeouts, trace-tool payload sizing' }],
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    probe: { type: 'string' },
    verdict: { type: 'string', enum: ['payload-stall-supported', 'payload-stall-refuted', 'transport-supported', 'inconclusive', 'na'] },
    headline: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    conclusion: { type: 'string' },
  },
  required: ['probe', 'verdict', 'headline', 'evidence', 'conclusion'],
}

const CTX = `SHARED CONTEXT (read-only investigation — do NOT write/edit anything, do NOT run any workflow):
- Cluster access: kubectl --context dev -n workflow-builder ...
- Postgres (Dapr state stores + app DB): kubectl --context dev -n workflow-builder exec postgresql-0 -- psql -U postgres -d workflow_builder -tAc "SQL"
- Dapr runtime is 1.18.1 (daprd + control plane). max-body-size = 16Mi (16777216 bytes) on the per-session agent sandbox pods AND the orchestrator. Dispatch budget = 95% of that ≈ 15925248 bytes.
- The incident: a "trace-deep-analysis" dynamic-script run (analysis execution id = mwKMFzBNacXz7_D4oQTBA) fanned out 4 reviewer agent sessions. Three finished fast; the 4th ("review:quality") WEDGED for 7 min on its 15th tool call (wfb_goal_trace_get_logs) with no tool_result and no error, then I terminated it. Its child session id contained the fragment "32b05f23d6e7ac81". The target being analyzed was execution uX-12Z6gK29zYwWY00ChC.
- dapr-agent-py uses PER-ACTIVITY durability, so each reviewer's tool results accumulate in ITS session_workflow history in the Dapr state store "dapr-agent-py-statestore" (database workflow_builder, tablePrefix "agent_py_"). The orchestrator/pump uses "workflowstatestore".
- Goal: decide whether the wedge is a Dapr v1.18 PAYLOAD-SIZE graceful stall (history dispatch exceeded ~15.9MB → work item silently not sent to SDK, durable, no error) vs an un-timed-out MCP transport hang. Be surgical; if a path fails after 2-3 tries, report what you found and stop.`

const probes = [
  {
    label: 'statestore-sizing',
    prompt: `${CTX}

PROBE 1 — STATESTORE HISTORY SIZING (the decisive test for payload-stall).
1. Find the Dapr state table(s): kubectl ... exec postgresql-0 -- psql -U postgres -d workflow_builder -tAc "SELECT tablename FROM pg_tables WHERE tablename LIKE 'agent_py_%' OR tablename LIKE 'workflow%state%' OR tablename ~ 'state';"
2. Identify the value/data column and how history is stored (\\d <table>). Dapr postgres v2 state store rows are (key, value, ...). Workflow history may be many keys per instance OR one big blob — figure out which.
3. Measure the LARGEST rows: SELECT key, pg_column_size(value) AS bytes FROM agent_py_state ORDER BY bytes DESC LIMIT 25; (adapt column/table name). Also SUM per instance if history is split across many keys: aggregate by the instance-id portion of the key.
4. Zero in on THIS incident's reviewer sessions: WHERE key LIKE '%mwKMFzBN%' OR key LIKE '%32b05f23%'. Compute the total bytes for the quality reviewer (32b05f23...) vs the 3 that finished, and vs the 15925248-byte (95% of 16Mi) budget.
5. Also check the orchestrator store (workflowstatestore / its table) for the analysis pump instance (mwKMFzBN) and target (uX-12Z6g) — any row near 16Mi?
Report: the max single-row bytes and max per-instance total bytes observed anywhere; the quality reviewer's total; the ratio to 15925248; and whether ANY instance is at/over the budget. VERDICT payload-stall-supported ONLY if a reviewer/instance history is within ~10% of (or over) the budget; payload-stall-refuted if the largest reviewer history is comfortably small (e.g. <25% of budget); inconclusive if the rows were purged/unfindable.`,
  },
  {
    label: 'payload-metric-and-logs',
    prompt: `${CTX}

PROBE 2 — DAPR v1.18 PAYLOAD METRIC + daprd LOG FORENSICS (corroboration).
1. Dapr 1.18 exposes a workflow payload-size metric (ratio of dispatch size to max-body-size, histogram buckets ~0.1..2.0). Find it: exec into a live dapr-agent-py pod's daprd and curl its metrics: kubectl ... exec <dapr-agent-py pod> -c daprd -- wget -qO- http://localhost:9090/metrics 2>/dev/null | grep -iE "payload|body_size|dispatch|workflow.*size" | head -40  (try port 9090; if wget absent try the daprd metrics port from the pod spec). Look for any metric whose buckets/sum indicate dispatches near or over ratio 1.0.
2. Check if Prometheus in the "observability" namespace scrapes daprd — kubectl --context dev -n observability get pods | grep -i prom — and if a query API is reachable, query the payload metric for high ratios over the last hour.
3. daprd log forensics for stall/overflow evidence across live pods: for the dapr-agent-py pods and workflow-orchestrator pod, kubectl ... logs <pod> -c daprd --tail=2000 2>&1 | grep -iE "payload|max.?body|exceed|too large|ResourceExhausted|larger than max|stall|precheck|work item|drop" | tail -40
Report the exact metric name + whether any dispatch ratio approached/exceeded 1.0, and any daprd log lines indicating a payload stall/overflow. VERDICT payload-stall-supported if the metric or logs show a dispatch at/over the budget; inconclusive if the metric exists but shows nothing high; payload-stall-refuted only if the metric clearly shows all dispatches well under budget.`,
  },
  {
    label: 'mcpclient-timeouts',
    prompt: `${CTX}

PROBE 3 — UPSTREAM MCP CLIENT TIMEOUT BEHAVIOR (decisive for the transport-hang hypothesis + validates the proposed config fix).
Our code services/dapr-agent-py/src/capability_compiler/mcp.py:244 forwards config keys "timeout"/"sse_read_timeout" into the MCP server config ONLY if the mcpServers item supplies them. The platform-wired trace/goal MCP server supplies NEITHER.
1. Find how the config is consumed: git grep for where those MCP configs are turned into an MCP client connection in services/dapr-agent-py/src (grep for streamable_http, ClientSession, MCPClient, connect, sse_read_timeout, read_timeout).
2. Read the PINNED upstream source in a live pod: kubectl ... exec <dapr-agent-py pod> -c dapr-agent-py -- python -c "import dapr_agents,mcp,inspect,os; print(dapr_agents.__file__); print(mcp.__file__)"  then locate and read the dapr_agents MCP client + the mcp SDK streamablehttp_client / ClientSession. Determine: (a) the DEFAULT sse_read_timeout and timeout used for streamable-http tool calls when our config omits them; (b) whether ClientSession.call_tool enforces a per-request read_timeout_seconds; (c) whether our capability_compiler timeout/sse_read_timeout keys actually reach the client constructor (trace the plumbing). Use grep -rn inside the site-packages paths printed above.
Report the concrete default sse_read_timeout (seconds) and whether a stalled streamable-http tool call would EVER time out on its own, and whether setting timeout/sse_read_timeout in our MCP server config would actually bound it. VERDICT transport-supported if the default is effectively unbounded/very long (>=300s) AND no per-call timeout applies (so a lost SSE response hangs indefinitely); payload-stall-supported is NOT yours to decide — use na if the transport path turns out to be well-bounded (which would point elsewhere).`,
  },
  {
    label: 'trace-tool-payload-sizing',
    prompt: `${CTX}

PROBE 4 — TRACE-TOOL PAYLOAD SIZING (bounds each tool's contribution to history growth).
The 4 trace tools proxy BFF internal routes: /digest, /spans, /llm-turn, /logs under src/routes/api/internal/observability/executions/[executionId]/. 
1. Read each route's +server.ts to compute the MAX response size: row caps (limit params, default+max), per-row field sizes, truncation (e.g. logs body sliced to 500 chars). Note especially /logs: it calls getMultiTraceLogs(traceIds) which has NO LIMIT in the query (see src/lib/server/otel/clickhouse.ts getMultiTraceLogs / queryObservabilityLogs) then slices to <=200 in JS — so the RESPONSE is capped but the BFF fetches all logs into memory.
2. Measure the ACTUAL data volume for the incident target's traces. Resolve the target's trace ids and count/size the rows in ClickHouse. ClickHouse access: find how the app reaches it — grep src/lib/server/otel/clickhouse.ts for the endpoint/env (CLICKHOUSE_URL etc), then either query via a BFF pod (kubectl ... exec <workflow-builder pod> -- node -e "...fetch clickhouse...") OR read the config to report the theoretical max. For execution uX-12Z6gK29zYwWY00ChC: how many otel_logs rows and otel_traces spans share its trace ids, and roughly how many bytes? 
3. Compute: worst-case bytes a single reviewer accumulates from 15 tool calls (7 search_spans + 4 get_logs + 2 get_llm_turn + digest + list), using the per-call response caps. Compare to the 15925248-byte budget.
Report per-tool max response bytes, the target trace's actual log/span row counts, and the 15-call worst-case accumulation vs budget. VERDICT payload-stall-supported if 15 calls could plausibly reach the budget; payload-stall-refuted if 15 calls max out well under (e.g. <2MB); inconclusive if you cannot size the tools.`,
  },
]

phase('Probe')
const results = await parallel(
  probes.map((p) => () => agent(p.prompt, { label: p.label, phase: 'Probe', schema: SCHEMA }))
)
return results.filter(Boolean)
