export const meta = {
  name: 'remaining-items-diagnosis',
  description: 'Diagnose claude-agent-py dev failure + design the AP MCP call-time cold-start fix',
  phases: [
    { title: 'Investigate', detail: 'parallel: claude-agent-py auth + AP MCP scale-down-delay' },
    { title: 'Synthesize', detail: 'actionable fixes' },
  ],
}
const WB = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const STK = '/home/vpittamp/repos/PittampalliOrg/stacks/main'
const FIND = {
  type: 'object', additionalProperties: false,
  properties: {
    area: { type: 'string' },
    rootCause: { type: 'string' },
    fixable: { type: 'string', description: 'yes-config | yes-code | no-external | unknown' },
    fix: { type: 'string', description: 'exact file(s) + change, or why not fixable' },
    anchors: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { ref: { type: 'string' }, what: { type: 'string' } }, required: ['ref','what'] } },
    risks: { type: 'string' },
  },
  required: ['area','rootCause','fixable','fix','anchors','risks'],
}

phase('Investigate')
const [claudeAgent, coldStart] = await parallel([
  () => agent(`Diagnose why the **claude-agent-py** runtime FAILS on dev (cluster admin@dev, ns workflow-builder) with \`Claude Code returned an error result: success\` (a Claude Agent SDK query() exception) — it fails EVEN WITH NO MCP (verified via isolation). The claude-agent-py-sandbox pod gets ANTHROPIC_API_KEY via envFrom dapr-agent-py-secrets; the Claude Agent SDK spawns the Claude Code CLI internally (CLAUDE_AGENT_SDK_CLI_PATH).

Investigate:
1. Read ${WB}/services/claude-agent-py/src/claude_sdk_runner.py — how it sets up Anthropic auth (ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / a gateway), how it spawns the Claude Code CLI, and the error handling around "error result". What does "error result: success" mean (the SDK raises on a result message whose subtype/error fields conflict)?
2. Is the dev ANTHROPIC_API_KEY a REAL Anthropic key (works for the Claude Code CLI) or an MLflow-gateway key (the dapr-agent-py adapters use direct provider calls / a gateway — but the Claude Code CLI needs a real key or OAuth)? Check the claude-agent-py pod env + any ANTHROPIC_BASE_URL. The dapr-agent-py-secrets ANTHROPIC_API_KEY may route through the MLflow AI gateway which the Claude Code CLI can't use.
3. Compare dev vs RYZEN (admin@ryzen): are there recent SUCCESSFUL claude-agent-py sessions on ryzen (query the DB via the BFF pod), or does claude-agent-py fail there too? This tells me if it's a dev-only config issue.
4. Read the claude-agent-py-config ConfigMap (CLAUDE_AGENT_PY_DEFAULT_MODEL, CLAUDE_AGENT_SDK_CLI_PATH, CLAUDE_AGENT_SDK_CLIENT_APP) and whether the model/base_url is wired for the Claude Code CLI.

Determine the root cause + whether it's fixable (config: wrong key/base_url/missing env) or external (no-credit/invalid key). Report the exact fix.`, { label: 'claude-agent-py', phase: 'Investigate', schema: FIND }),

  () => agent(`Design the fix for **AP MCP cold-start at TOOL-CALL time**. The startup warm-up (cli_lifecycle._warm_ap_mcp_servers, just shipped) covers the INITIAL MCP connection, but a scale-to-zero \`ap-<piece>-service\` Knative service can scale DOWN mid-session, so a later tool call hits a Knative **activation request timeout** (observed: agy's findEmail). 

Investigate + design:
1. Find where the per-piece \`ap-<piece>-service\` Knative Service TEMPLATE is defined — the reconciler that provisions them. Likely in stacks ${STK} (an \`activepieces-mcps\` app / CronJob reconciler) OR ${WB}/services (piece-mcp-server / a metadata sync). Grep for 'ap-' + '-service', 'Knative', 'serving.knative.dev', 'activepieces-mcps', 'autoscaling.knative.dev'.
2. Read the current Knative Service spec for these — the autoscaling annotations: \`autoscaling.knative.dev/minScale\` (scale-to-zero?), \`autoscaling.knative.dev/scale-down-delay\`, \`target\`, \`window\`. Is scale-down-delay set?
3. RECOMMENDED FIX: add \`autoscaling.knative.dev/scale-down-delay: "300s"\` (or similar ~5min) to the ap-<piece>-service template so an actively-used server stays warm during a session (tool calls within the window keep it alive) then scales to zero when idle — no per-runtime code, balances scale-to-zero economics. Find the EXACT template file + the annotation block to edit, and whether the reconciler re-applies it (so the change propagates to all ap-<piece>-service).
4. Evaluate the alternative (a per-session keepalive pinging bound AP MCP URLs) and why scale-down-delay is cleaner.

Report the exact file:line + the annotation change + how it propagates to existing/new ap-<piece>-service.`, { label: 'cold-start', phase: 'Investigate', schema: FIND }),
])

phase('Synthesize')
const PLAN = {
  type: 'object', additionalProperties: false,
  properties: {
    claudeAgentPy: { type: 'string' },
    coldStart: { type: 'string' },
    order: { type: 'array', items: { type: 'string' } },
    holes: { type: 'array', items: { type: 'string' } },
  },
  required: ['claudeAgentPy','coldStart','order','holes'],
}
const plan = await agent(`Synthesize actionable fixes from the two investigations. For claude-agent-py: state the root cause + whether to fix (config) or report (external). For cold-start: the exact stacks/template change + propagation. Be file-anchored; flag holes.\n\nCLAUDE-AGENT-PY:\n${JSON.stringify(claudeAgent)}\n\nCOLD-START:\n${JSON.stringify(coldStart)}`, { label: 'synth', phase: 'Synthesize', schema: PLAN })
return { claudeAgent, coldStart, plan }
