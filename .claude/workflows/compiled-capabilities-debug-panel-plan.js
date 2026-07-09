export const meta = {
  name: 'compiled-capabilities-debug-panel-plan',
  description: 'Map where/how to add a compiled-capabilities debug panel + fix the UI-template config.runtime bug',
  phases: [
    { title: 'Map', detail: '3 parallel readers: debug surfaces, resolve path, template bug' },
    { title: 'Synthesize', detail: 'actionable implementation plan' },
  ],
}
const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const MAP = {
  type: 'object', additionalProperties: false,
  properties: {
    area: { type: 'string' },
    files: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, role: { type: 'string' } }, required: ['path', 'role'] } },
    anchors: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { ref: { type: 'string' }, what: { type: 'string' } }, required: ['ref', 'what'] } },
    approach: { type: 'string' },
    risks: { type: 'string' },
  },
  required: ['area', 'files', 'anchors', 'approach', 'risks'],
}
const ctx = `cwd=${REPO}. Capability bundles + the capability compiler shipped (PRs #136-140). flattenBundles (src/lib/server/capabilities/flatten.ts) + resolveAgentConfigMcpForProject (src/lib/server/agents/mcp-resolution.ts) + assertSwapSafe/deriveAgentRequirements (src/lib/server/agents/swap-safety.ts) produce the effective config at spawn (src/lib/server/sessions/spawn.ts). GOAL: a "Compiled capabilities" DEBUG panel showing the resolved/compiled config (resolved runtime, flattened+resolved mcpServers with secrets redacted, skills, tools, bundle provenance, swap-safety warnings). Read files, do NOT edit. Give exact file:line anchors.`

phase('Map')
const [debugUi, resolvePath, templateBug] = await parallel([
  () => agent(`${ctx}\n\nMAP the DEBUG SURFACES where the panel should live. (1) The SESSION detail has a "Debug" tab (Terminal/Timeline/Debug/OpenShell) — find the component + how tabs render. (2) The AGENT detail page (src/routes/workspaces/[slug]/agents/[id]/+page.svelte) tabs (Overview/Basics/Prompt Workbench/Capabilities/Sandbox/Advanced/Sessions) — is there a debug-ish tab, and how would I add a "Compiled capabilities" tab/section? (3) Any existing JSON-viewer / code-block component to reuse for rendering the compiled config. Report component paths + how to add a tab/panel + a fetch-on-demand pattern.`, { label: 'debug-ui', phase: 'Map', schema: MAP }),

  () => agent(`${ctx}\n\nMAP the RESOLVE PATH to expose in a new endpoint GET /api/agents/[id]/compiled-capabilities (and a session variant). I need to compute the SAME effective config the runtime gets. Trace: flattenBundles(config, projectId) -> resolveAgentConfigMcpForProject(config, projectId) (mcp-resolution.ts ~451) -> the resolved mcpServers shape (fields: serverName/name, transport, url, headers, allowedTools, connectionExternalId, registryRef, sourceType). Also assertSwapSafe + deriveAgentRequirements (swap-safety.ts) to surface the runtime-mismatch as a warning. CRITICAL: SECRET REDACTION — which header keys are SECRETS (e.g. Authorization, x-api-key) vs the safe audit-only X-Connection-External-Id reference? Is there an existing redaction helper? Where does plaintext ever appear in the resolved mcpServers (it should NOT — the BFF forwards connectionExternalId references, the piece-runtime self-resolves)? Confirm the resolved config carries only references, not plaintext. Report the exact functions to call + the redaction approach.`, { label: 'resolve-path', phase: 'Map', schema: MAP }),

  () => agent(`${ctx}\n\nFIND + diagnose the UI-template agent-creation bug: creating a "Claude Code CLI" agent via POST /api/agents?fromTemplate=... sets the agent ROW runtime to claude-code-cli but leaves config.runtime at the default dapr-agent-py (confirmed in DB: row=claude-code-cli, cfg=dapr-agent-py). Trace src/routes/api/agents/+server.ts POST (findTemplate, applyBuiltinTemplate, createDefaultAgentConfig, mergeConfig) + the template catalog (src/lib/server/agent-templates/catalog.ts or quickstart templates) for the "claude-code-cli" template: does its config set runtime? Does mergeConfig overwrite/preserve runtime? Does createAgent (registry.ts) sync config.runtime from input.runtime? Pinpoint WHERE config.runtime should be set to match input.runtime and the minimal fix so a CLI template produces config.runtime===its row runtime. Report file:line + the exact fix.`, { label: 'template-bug', phase: 'Map', schema: MAP }),
])

phase('Synthesize')
const PLAN = {
  type: 'object', additionalProperties: false,
  properties: {
    endpoint: { type: 'string', description: 'the new endpoint design (path, response shape, functions called, redaction)' },
    ui: { type: 'string', description: 'where the panel goes + the component plan' },
    templateFix: { type: 'string', description: 'the exact config.runtime fix' },
    steps: { type: 'array', items: { type: 'string' } },
    holes: { type: 'array', items: { type: 'string' } },
  },
  required: ['endpoint', 'ui', 'templateFix', 'steps', 'holes'],
}
const plan = await agent(`${ctx}\n\nSynthesize an actionable plan for (A) the compiled-capabilities debug endpoint + panel and (B) the config.runtime template-bug fix. Be file-anchored. Flag holes (esp. secret-redaction correctness + whether the per-runtime compiled shape can/should be replicated in TS or just show the resolved config).\n\nDEBUG-UI:\n${JSON.stringify(debugUi)}\n\nRESOLVE-PATH:\n${JSON.stringify(resolvePath)}\n\nTEMPLATE-BUG:\n${JSON.stringify(templateBug)}`, { label: 'synthesis', phase: 'Synthesize', schema: PLAN })
return { debugUi, resolvePath, templateBug, plan }
