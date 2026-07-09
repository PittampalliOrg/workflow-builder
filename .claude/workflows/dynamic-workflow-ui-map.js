export const meta = {
  name: 'dynamic-workflow-ui-map',
  description: 'Map the six UI subsystems needed for dynamic-workflow authoring + visualization integration',
  phases: [{ title: 'Map' }],
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/dynamic-script-engine'
const SCHEMA = {
  type: 'object',
  required: ['summary', 'keyFiles', 'dataShapes', 'reuseCandidates', 'integrationPoints', 'gotchas'],
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    keyFiles: { type: 'array', items: { type: 'object', required: ['path', 'role'], additionalProperties: false, properties: { path: { type: 'string' }, role: { type: 'string' }, lines: { type: 'string' } } } },
    dataShapes: { type: 'array', items: { type: 'string' } },
    reuseCandidates: { type: 'array', items: { type: 'string' } },
    integrationPoints: { type: 'array', items: { type: 'string' } },
    gotchas: { type: 'array', items: { type: 'string' } },
  },
}

const AREAS = [
  {
    key: 'canvas',
    prompt: `Explore ${REPO} (SvelteKit BFF). Map the WORKFLOW EDITOR/CANVAS surface: the route for editing/viewing a single workflow (src/routes/**/workflows/[id]/** or similar), the SvelteFlow canvas components, and src/lib/utils/spec-graph-adapter.ts. CRITICAL QUESTIONS: (1) How does a workflow with engineType='dynamic-script' render in the EDITOR today (empty canvas? script editor? special panel — search for 'dynamic-script' in routes+components)? (2) How are nodes/edges derived from spec (buildGraph)? (3) Is there ANY existing AI/chat/copilot side panel on the canvas page (search 'chat', 'copilot', 'assistant', 'panel' in the workflow editor route tree)? (4) What layout system does the editor page use (could a right side panel be added)? (5) How does the page load + refetch the workflow (API routes, invalidate patterns)? Report exact file paths with line refs, component hierarchy, and data flows.`,
  },
  {
    key: 'chat',
    prompt: `Explore ${REPO} (SvelteKit BFF). Map the SESSION CHAT UI building blocks that could be embedded in another page as a chat side panel: the session detail page's transcript + message composer (src/routes/**/sessions/[id]/**, src/lib/components/sessions/**), how a user message is SENT to a running session (which API route — control/events?), the SSE/event-stream store (src/lib/stores/session-stream.svelte.ts), and any EXISTING embeddable/reusable chat components (e.g. SessionTranscript used by a 'unified Run Console' per code comments). Also: how does the UI CREATE a new interactive session (POST route, required body: agentId etc.) and start its first turn? Report component props, store APIs, send-message contract, and the smallest set of components to embed a working chat (transcript + composer + stream) in a different page.`,
  },
  {
    key: 'runpanel',
    prompt: `Explore ${REPO} (SvelteKit BFF). Map the DYNAMIC-SCRIPT RUN visualization: src/lib/components/workflow/script-run-panel.svelte (or wherever the script run UI lives), the run/execution detail page structure (routes for a workflow execution), the internal/public API routes serving script-call journal rows (…/executions/[id]/script-calls), and the exact data shape returned (callId, label, phase, status, retries, session linkage — how does the UI link a call to its child SESSION, and how are nested workflow() child executions represented?). Also how live updates reach this panel (SSE? poll?). Also check src/lib/components/workflow/execution/agent-run-explorer.svelte and step-timeline.svelte roles. Report everything needed to build a richer phase-grouped DAG/timeline visualization of script calls with click-through to sessions and nested child workflow runs.`,
  },
  {
    key: 'fleet',
    prompt: `Explore ${REPO} (SvelteKit BFF). Find any 'fleet' / multi-session OVERVIEW surfaces: search for 'fleet', 'Fleet' repo-wide (components/routes/stores); also map the sessions LIST page (src/routes/**/sessions/+page.svelte), the workflow runs list, and any 'run console' or dashboard that shows many sessions/runs at once. For each: route, data source(s), card/list components, live-update mechanism. Question to answer: where would a 'workflow run with N child agent sessions' GROUPING naturally live (parent run → child sessions tree), and what existing components (session cards, status pills, timeline bars like session-timeline-bar.svelte) could be reused? Report component APIs + data shapes.`,
  },
  {
    key: 'spawn',
    prompt: `Explore ${REPO} (SvelteKit BFF). Map how the UI creates + drives interactive agent sessions: the POST route for creating a session (src/routes/api/v1/sessions or similar — required body, agentId/agentVersion/projectId, title), how the first user message/turn is sent, spawnSessionWorkflow in src/lib/server/sessions/spawn.ts (what triggers it), and how the session's agent + model resolve (agentConfig.modelSpec). ALSO: find how an EPHEMERAL or inline agent could be used (can a session be created with an inline agentConfig override rather than a saved agent? search for config overrides in session creation), and whether sessions can carry initial context/metadata (e.g. a workflowId the agent should edit). Report exact contracts.`,
  },
  {
    key: 'live',
    prompt: `Explore ${REPO} (SvelteKit BFF). Map LIVE-UPDATE mechanisms usable by (a) a canvas page that must refetch/redraw when its workflow row's spec changes (is there any workflow.updated SSE/websocket? how do other pages learn about workflow row changes?), and (b) run pages streaming execution progress (execution events SSE routes, stores). Inventory: src/lib/stores/*.svelte.ts stores related to sessions/executions/workflows, SSE endpoints under src/routes/api (events/stream routes), invalidation patterns (invalidate/invalidateAll usage in workflow editor pages), and the session-stream store API. Report which mechanism a canvas AI-chat panel should use to know 'the agent just saved/updated the workflow' (options + recommendation grounded in what exists).`,
  },
]

phase('Map')
const results = await parallel(
  AREAS.map((a) => () => agent(
    a.prompt + ' Be very thorough; include verbatim key type definitions and component prop interfaces. Your final output MUST be the structured object.',
    { label: `map:${a.key}`, phase: 'Map', schema: SCHEMA, agentType: 'Explore' }
  ))
)
return Object.fromEntries(AREAS.map((a, i) => [a.key, results[i]]))