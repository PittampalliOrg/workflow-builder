export const meta = {
  name: 'verify-codex-agy-newsession-dropdown',
  description: 'Verify codex-cli/agy-cli runtimes are selectable in the new-session UI; trace the selection mechanism + check live clusters',
  phases: [
    { title: 'Investigate', detail: 'parallel: UI selector trace + runtime-surfacing trace + live cluster check' },
    { title: 'Synthesize', detail: 'verdict + exact fix if not selectable' },
  ],
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'

const UI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dropdownLists', 'runtimePickerExists', 'howRuntimeChosen', 'relevantFiles', 'notes'],
  properties: {
    dropdownLists: { type: 'string', description: 'Does the new-session form select AGENTS, RUNTIMES, or both?' },
    runtimePickerExists: { type: 'boolean', description: 'Is there an explicit runtime selector anywhere in the new-session flow?' },
    howRuntimeChosen: { type: 'string', description: 'How the session runtime is ultimately determined (e.g. from selectedAgent.runtime).' },
    relevantFiles: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const SURFACE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claudeCodeCliSurfacedVia', 'agentCreateHasRuntimePicker', 'runtimeOptionsSource', 'autoIncludesNewRuntimes', 'relevantFiles', 'notes'],
  properties: {
    claudeCodeCliSurfacedVia: { type: 'string', description: 'How a user can create/select a claude-code-cli session today (seeded agents? runtime picker in agent-create? registry-driven list?).' },
    agentCreateHasRuntimePicker: { type: 'boolean', description: 'Does the agent create/edit UI let the user pick a runtime, and where do the options come from?' },
    runtimeOptionsSource: { type: 'string', description: 'Source of the runtime option list shown in any UI (registry listRuntimes()? a hardcoded array? benchmark list?).' },
    autoIncludesNewRuntimes: { type: 'boolean', description: 'Would codex-cli/agy-cli AUTOMATICALLY appear wherever claude-code-cli appears, or is an explicit allowlist/seed needed?' },
    relevantFiles: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const LIVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['liveRuntimesOffered', 'codexAgyPresent', 'howChecked', 'notes'],
  properties: {
    liveRuntimesOffered: { type: 'array', items: { type: 'string' }, description: 'Runtime ids actually offered/selectable on the live dev cluster UI/API.' },
    codexAgyPresent: { type: 'boolean', description: 'Are codex-cli AND agy-cli both selectable on the live dev cluster?' },
    howChecked: { type: 'string' },
    notes: { type: 'string' },
  },
}

phase('Investigate')
const [ui, surface, live] = await parallel([
  () => agent(
    `Read-only code trace in ${REPO}. QUESTION: In the new-session form (src/routes/workspaces/[slug]/sessions/new/+page.svelte and its +page.server.ts), what does the primary selector dropdown actually list — AGENTS or RUNTIMES? Is there any explicit runtime picker in the new-session flow? How is the session's runtime ultimately determined (trace selectedAgent.runtime and what /api/agents returns)? Look at how the agent dropdown is populated. Do NOT change anything. Return structured findings.`,
    { label: 'ui-trace', phase: 'Investigate', schema: UI_SCHEMA, agentType: 'Explore' },
  ),
  () => agent(
    `Read-only code trace in ${REPO}. QUESTION: How is the claude-code-cli runtime made SELECTABLE by a user today (so codex-cli/agy-cli can mirror it)? Investigate: (1) the agent create/edit UI — does it let the user pick a runtime, and where does the runtime option list come from (registry listRuntimes()? a hardcoded list? listBenchmarkRuntimeIds()? interactiveTerminal filter?)? (2) Are there seeded/curated agents with runtime=claude-code-cli (search db seeds, scripts, migrations, default agents)? (3) Would codex-cli/agy-cli AUTOMATICALLY appear wherever claude-code-cli appears, or does an explicit allowlist/enum/seed gate it? Search broadly for "claude-code-cli", "interactiveTerminal", runtime selectors, agent runtime option lists. Do NOT change anything. Return structured findings.`,
    { label: 'runtime-surface', phase: 'Investigate', schema: SURFACE_SCHEMA, agentType: 'Explore' },
  ),
  () => agent(
    `Live cluster check (read-only). Use kubectl context admin@dev, namespace workflow-builder. Goal: determine which agent RUNTIMES are actually selectable in the new-session UI on the live dev cluster, and whether codex-cli AND agy-cli are present. Approaches: (a) exec into the workflow-builder BFF pod (label app=workflow-builder, container workflow-builder) and curl the internal agents/runtime endpoints if reachable without auth, or inspect the bundled src/lib/server/agents/runtime-registry.data.json in the running image for codex-cli/agy-cli; (b) query the postgres DB for agents and their runtime column if a runtime selector is agent-driven (find the DB connection via the pod env/secret if feasible, else skip); (c) check whether any UI route exposes the runtime list. Keep it READ-ONLY — no writes, no session spawns. Report which runtimes are offered and whether codex-cli/agy-cli are both selectable on dev. Return structured findings.`,
    { label: 'live-check', phase: 'Investigate', schema: LIVE_SCHEMA, agentType: 'Explore' },
  ),
])

phase('Synthesize')
const verdict = await agent(
  `Synthesize a precise verdict. Inputs:\n\nUI TRACE: ${JSON.stringify(ui)}\n\nRUNTIME SURFACING: ${JSON.stringify(surface)}\n\nLIVE DEV CHECK: ${JSON.stringify(live)}\n\nAnswer crisply:\n1) Do codex-cli AND agy-cli show up as selectable options for a user starting a new session (whether via a runtime picker or via agents with those runtimes)? YES/NO/PARTIAL with the exact reason.\n2) If NO/PARTIAL: what is the MINIMAL change needed to make them appear (e.g. the runtime picker already reads listRuntimes() so they appear automatically; OR a seeded/curated agent per runtime is required; OR a UI allowlist must be extended)? Name the exact file(s).\n3) Is any change needed at all, or is it already working?\nBe concrete and cite the mechanism.`,
  { label: 'verdict', phase: 'Synthesize' },
)

return { ui, surface, live, verdict }
