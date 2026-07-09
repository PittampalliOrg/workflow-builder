export const meta = {
  name: 'cli-resume-wiring-research',
  description: 'Map the code paths for wiring interactive-cli conversation resume (resumeFromSessionId -> claude --continue/--resume)',
  phases: [
    { title: 'Map', detail: 'spawn path, cli-agent launch, schema/fork, UI, claude --continue semantics' },
    { title: 'Plan', detail: 'synthesize a concrete implementation plan' },
  ],
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'

const SPAWN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['files', 'currentFlow', 'insertionPoints', 'notes'],
  properties: {
    files: { type: 'array', items: { type: 'string' }, description: 'file:line refs touched' },
    currentFlow: { type: 'string', description: 'How POST /api/v1/sessions -> spawnSessionWorkflow -> sandbox-execution-api /agent-workflow-hosts builds the request for an interactive-cli session. What fields of the request body (AgentWorkflowHostRequest) the BFF already sets, and whether resumeFromSessionId is passed anywhere.' },
    sessionInputShape: { type: 'string', description: 'What "session input" / agentConfig / instructionBundle the BFF passes to the cli-agent host (the childInput / ensure-for-workflow payload), and where a resume signal could be added.' },
    insertionPoints: { type: 'string', description: 'EXACT places (file:line + symbol) to (a) accept a resumeFromSessionId/parentSessionId on session create, (b) thread it into the sandbox-execution-api request, (c) signal cli-agent-py to resume.' },
    notes: { type: 'string' },
  },
}
const CLIAGENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['files', 'buildArgvFlow', 'resumeApproach', 'claudeSessionIdCapture', 'notes'],
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    buildArgvFlow: { type: 'string', description: 'How ClaudeCodeAdapter.build_argv constructs the claude launch argv, and how session_input/agentConfig reaches it (the cli_lifecycle/session_workflow path). Where to inject --continue/--resume.' },
    resumeApproach: { type: 'string', description: 'Recommend: does `claude --continue` resume the most-recent conversation in $CLAUDE_CONFIG_DIR/projects/<cwd-hash>/ WITHOUT needing the explicit session id? (Check the claude-code-src harness at /home/vpittamp/repos/PittampalliOrg/claude-code-src/main and/or the CLI flags.) If --continue works, we avoid tracking the claude session id. Else we need --resume <claudeSessionId>.' },
    claudeSessionIdCapture: { type: 'string', description: 'IF an explicit id is needed: how/where the platform already learns the claude session id (the transcript filename <uuid>.jsonl is the claude session id; the transcript tailer in hooks_api/transcript_tailer reads that path). Is it surfaced into session_events / a session column already?' },
    paneEnvOrConfig: { type: 'string', description: 'How a resume flag would reach build_argv: via agentConfig field, a pane env var, or session_input. The cleanest hook.' },
    notes: { type: 'string' },
  },
}
const SCHEMA_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['files', 'sessionColumns', 'forkFlow', 'notes'],
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    sessionColumns: { type: 'string', description: 'sessions table columns relevant to lineage/continuation (parentSessionId, forkedFromSessionId, resumedFromSessionId, workflowExecutionId, etc.) from src/lib/server/db/schema.ts. Is there an existing field to store "this session resumes session X"? Migration count/dir.' },
    forkFlow: { type: 'string', description: 'How POST /api/v1/sessions/[id]/fork works (src/routes/api/v1/sessions/[id]/fork/+server.ts) — it forks at fromSequence; does it spawn a new session/pod, and how does it relate the new session to the parent? A good template for resume.' },
    notes: { type: 'string' },
  },
}
const UI_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['files', 'sessionDetailActions', 'resumeButtonPlacement', 'notes'],
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    sessionDetailActions: { type: 'string', description: 'Where session-level actions (stop, fork) live on the session detail page + session list (svelte components), and how they call the API.' },
    resumeButtonPlacement: { type: 'string', description: 'Best place + pattern for a "Resume" action for a TERMINATED interactive-cli session (only for the interactive-cli runtime family), mirroring the fork/stop buttons.' },
    notes: { type: 'string' },
  },
}

phase('Map')
const [spawn, cliagent, schema, ui] = await parallel([
  () => agent(`Map the BFF session spawn path for interactive-cli in ${REPO}. Read src/routes/api/v1/sessions/+server.ts, src/lib/server/sessions/spawn.ts, src/routes/api/internal/sessions/ensure-for-workflow/+server.ts, and how they call the sandbox-execution-api /api/v1/agent-workflow-hosts (the AgentWorkflowHostRequest — note: it ALREADY has a resumeFromSessionId field, added in services/sandbox-execution-api/src/app.py). Determine exactly where a resumeFromSessionId would enter on session-create and how to thread it into the spawn request + the cli-agent session input.`, { label: 'spawn-path', phase: 'Map', schema: SPAWN_SCHEMA, agentType: 'Explore' }),
  () => agent(`Map the cli-agent-py claude launch in ${REPO}/services/cli-agent-py. Read src/cli_adapters/claude_code.py (build_argv), src/cli_lifecycle.py / src/session_workflow.py (how session_input + agentConfig reach the adapter + how the pane is launched), src/hooks_api.py / src/transcript_tailer.py (claude session id = transcript <uuid>.jsonl filename). KEY QUESTION: does \`claude --continue\` resume the most-recent conversation in the project dir without an explicit id? Check the harness at /home/vpittamp/repos/PittampalliOrg/claude-code-src/main for --continue vs --resume semantics. Recommend the resume approach + the cleanest hook to pass a resume flag into build_argv.`, { label: 'cli-agent', phase: 'Map', schema: CLIAGENT_SCHEMA, agentType: 'Explore' }),
  () => agent(`Map session lineage + the fork flow in ${REPO}. Read src/lib/server/db/schema.ts (sessions table — find any parent/forkedFrom/resumedFrom/lineage columns) and src/routes/api/v1/sessions/[id]/fork/+server.ts. Report whether there's an existing column to record "session B resumes/continues session A", how fork spawns + links a new session, and the migration dir/latest number.`, { label: 'schema-fork', phase: 'Map', schema: SCHEMA_SCHEMA, agentType: 'Explore' }),
  () => agent(`Map the session UI in ${REPO}. Find the session detail page + session list svelte components (likely under src/routes and src/lib/components) where stop/fork actions render + call the API. Recommend where a "Resume" action belongs for a TERMINATED interactive-cli session (runtime family claude-code-cli/codex-cli/agy-cli), mirroring existing action buttons.`, { label: 'ui', phase: 'Map', schema: UI_SCHEMA, agentType: 'Explore' }),
])

phase('Plan')
const plan = await agent(
  `Synthesize a CONCRETE implementation plan to wire interactive-cli conversation RESUME. Context: a session's transcript persists to a per-session Postgres-backed JuiceFS subtree keyed on subPath = (resumeFromSessionId or sessionId); a resumed session must mount the SAME subPath (so resumeFromSessionId = the original session id) and launch claude to continue that conversation. sandbox-execution-api ALREADY accepts resumeFromSessionId (provisions the PV with that subPath).\n\n` +
  `SPAWN PATH:\n${JSON.stringify(spawn, null, 2)}\n\nCLI-AGENT:\n${JSON.stringify(cliagent, null, 2)}\n\nSCHEMA/FORK:\n${JSON.stringify(schema, null, 2)}\n\nUI:\n${JSON.stringify(ui, null, 2)}\n\n` +
  `Produce an ordered, file-by-file plan: (1) the API surface to start a resume (new endpoint or a param on create — prefer the simplest, mirror fork), (2) threading resumeFromSessionId from create -> spawn.ts -> AgentWorkflowHostRequest, (3) the cli-agent-py change to launch claude in continue/resume mode (prefer \`claude --continue\` if it resumes the latest project conversation — note whether an explicit claude-session-id is needed and how to get it), (4) any schema/migration for lineage, (5) the UI Resume action (interactive-cli only, terminated sessions). Flag the single riskiest assumption. Keep it minimal + loop-preserving (do NOT reimplement the agent loop).`,
  { label: 'plan', phase: 'Plan', schema: { type: 'object', additionalProperties: false, required: ['steps', 'resumeMechanism', 'riskiestAssumption', 'minimalChangeset'], properties: {
    steps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file', 'change'], properties: { file: { type: 'string' }, change: { type: 'string' } } } },
    resumeMechanism: { type: 'string', description: 'claude --continue vs --resume <id> + why; whether claude-session-id tracking is needed' },
    needsMigration: { type: 'boolean' },
    riskiestAssumption: { type: 'string' },
    minimalChangeset: { type: 'string', description: 'the smallest set of edits that delivers a working resume' },
  } } }
)
return plan
