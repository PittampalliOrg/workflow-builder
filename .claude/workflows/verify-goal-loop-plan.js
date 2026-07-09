export const meta = {
  name: 'verify-goal-loop-plan',
  description: 'Adversarially verify the goal-loop implementation plan against the workflow-builder codebase, with a completeness critic',
  phases: [
    { title: 'Verify', detail: 'read-only agents confirm/refute each load-bearing claim and surface gaps' },
  ],
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'

const FINDING = {
  type: 'object',
  additionalProperties: false,
  required: ['area', 'verdict', 'evidence', 'corrections', 'gaps', 'recommendation'],
  properties: {
    area: { type: 'string', description: 'which claim/area this covers' },
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'partial', 'unknown'] },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'detail'],
        properties: {
          file: { type: 'string' },
          lines: { type: 'string' },
          detail: { type: 'string' },
        },
      },
    },
    corrections: { type: 'string', description: 'if the plan claim is wrong/imprecise, the corrected fact with citation' },
    gaps: { type: 'string', description: 'anything missing, risky, or unhandled that the plan should address' },
    recommendation: { type: 'string', description: 'concrete guidance for the implementation plan' },
  },
}

const COMMON = `Repo root: ${REPO}. You are a READ-ONLY verification agent for a PLANNING task — do NOT edit any files, only read/grep/search. Verify the stated claim(s) against the ACTUAL code. Cite exact file paths + line numbers + short quotes. If the plan's claim is wrong or imprecise, give the corrected fact. Also surface any GAP/RISK the plan should address. Return the structured finding.`

const SPECS = [
  {
    key: 'events-hook',
    label: 'verify:events-side-effect-hook',
    prompt: `${COMMON}

CLAIM (from plan): In src/lib/server/sessions/events.ts, appendEvent() runs per-event-type side-effect handlers (around L96 / L144-206), e.g. agent.llm_usage triggers benchmark rollups (aggregateLlmUsageIntoBenchmarkInstance), and it uses a pg_advisory_xact_lock(hashtext(sessionId)) pattern. The plan wants to add a goalLoop.onSessionEvent(sessionId, event) call in that side-effect block for event types 'agent.llm_usage' and 'session.status_idle'.

VERIFY:
1. The exact function name + line range where per-event side-effects are dispatched in appendEvent (or wherever). Quote the switch/if structure on event type.
2. The exact field names on an 'agent.llm_usage' event's data payload (input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, ttft_ms, model — confirm/correct). Cite where benchmark rollup reads them.
3. The exact field structure of a 'session.status_idle' event (does data.stop_reason.type == 'end_turn' exist? quote where it's emitted/consumed).
4. Whether the advisory-lock pattern exists and is reusable, and whether side-effects are awaited or fire-and-forget.
5. Is appendEvent idempotent on sourceEventId? Could a goal hook double-fire on replay/retry?
GAP focus: is the side-effect block the right insertion point, or is there a cleaner event-subscription mechanism (SSE fan-out, a listener registry)?`,
  },
  {
    key: 'raise-events',
    label: 'verify:raise-user-events',
    prompt: `${COMMON}

CLAIM (from plan): To drive a continuation turn we post a 'user.message' into a LIVE session, which the dapr-agent-py session_workflow consumes via wait_for_external_event("session.user_events"). The plan says src/lib/server/sessions/spawn.ts::raiseSessionUserEvents (L374-415) raises 'session.user_events' into the live workflow via Dapr — for sandbox sessions through the runtime pod's /internal/sessions/raise-event HTTP endpoint (NOT Dapr placement service-invoke), and that POST /api/v1/sessions/[id]/events (+server.ts) already does append+raise via a sendUserEvent helper.

VERIFY:
1. raiseSessionUserEvents exact location + how it raises the event. Does it use Dapr workflow raise_event (placement) or an HTTP POST to a runtime endpoint? For a per-session SANDBOX session specifically, what transport is used? Quote it. (This matters: the rejected #74/#75/#76 approach was Dapr-service-invoking sandboxes.)
2. sendUserEvent helper location + what it does (append + raise?).
3. POST /api/v1/sessions/[id]/events/+server.ts — confirm it appends a user.message and raises it. Quote.
4. How is the event batch shaped ({events:[...]}) and what content fields does a user.message carry (text? content?) so the agent composes the turn task (_compose_turn_task)?
5. Does raising require the session_workflow to be in the idle wait state, or does Dapr buffer raised events until the next wait_for_external_event? (Determines whether a posted continuation is reliably consumed.)
GAP focus: any auth/internal-token requirement; any failure mode if the workflow instance is mid-turn vs idle; how raise targets the right app-id/instance for a sandbox session.`,
  },
  {
    key: 'mcp-session-scope',
    label: 'verify:mcp-session-scoping-CRITICAL',
    prompt: `${COMMON}

THIS IS THE RISKIEST CLAIM — investigate deeply. CLAIM (from plan): We add create_goal/update_goal/get_goal MCP tools to services/workflow-mcp-server, wired into a goal-loop session via agentConfig.mcpServers, and the tool can resolve WHICH thread/session (thread_id == session_id) it is serving from request context (a per-session URL or header stamped at bootstrap).

VERIFY the actual mechanism by which a per-session MCP server call can be attributed to a specific session_id:
1. How does dapr-agent-py wire agentConfig.mcpServers and connect to them? Read services/dapr-agent-py/src/main.py around L1251-1266 (mcpServers wiring) + any mcp client module. What transports are supported (stdio / streamable_http / sse)? Are custom HEADERS supported per server entry? Is a URL templated per session?
2. Read src/lib/server/agents/mcp-sidecar.ts and registry-sync.ts and search for DAPR_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON. How/where is agentConfig.mcpServers stamped per session in BOTH spawn paths (src/lib/server/sessions/spawn.ts and the workflow bridge)? Can the BFF inject a per-session URL query param or header (e.g. ?sessionId=... or X-Session-Id) when stamping the goal MCP server entry?
3. Read services/workflow-mcp-server/src/index.ts + workflow-tools.ts + db.ts: how does the MCP server receive HTTP requests (transport)? Can a tool handler read the request URL/headers to get a session id? Or is identity only available as a tool ARGUMENT?
4. Is there ANY existing example of a session-scoped or connection-scoped MCP server in this repo (piece-mcp-server? mcp-gateway? mcp_connection table)? How do they scope identity?
CONCLUDE: What is the MOST RELIABLE way for the goal tools to know the current session_id? Options to evaluate: (a) BFF stamps a per-session URL/header into the mcpServers entry; (b) the agent passes session_id as a tool argument (model must be told its session id — how? is session id in the instruction bundle / cwd / env?); (c) a dedicated lightweight goal endpoint instead of MCP. Give a concrete, verified recommendation.
GAP focus: if neither header nor URL templating is supported by the dapr-agent-py MCP client, the plan's MCP approach needs a fallback — say so explicitly.`,
  },
  {
    key: 'deepseek-tools',
    label: 'verify:deepseek-tool-calling',
    prompt: `${COMMON}

CLAIM (from plan): dapr-agent-py + deepseek supports tool-calling, and MCP tools are exposed to the model as callable tools. modelSpec "deepseek/deepseek-v4-pro" selects it.

VERIFY:
1. services/dapr-agent-py/src/deepseek_adapter.py — confirm it normalizes OpenAI-style tool_calls (around L72-178). Quote how tool calls are parsed and whether 'thinking' is disabled on tool calls.
2. How are MCP tools (from agentConfig.mcpServers) registered as tools available to the LLM in the dapr-agent-py loop? Are MCP tools merged with built-in OpenShell tools before the LLM call? Cite the merge point.
3. What is the EXACT modelSpec string / value for deepseek (check runtime-registry.json supportedProviders + any deepseek model id used in seeds/fixtures/agent configs). Correct the plan's "deepseek/deepseek-v4-pro" if wrong.
4. Any known reliability caveats for deepseek tool-calling in this codebase (search comments, the empty-response circuit breaker, etc.).
GAP focus: does deepseek reliably emit well-formed tool_calls for an update_goal-style tool, or should we keep a sentinel fallback? What model id should the verification test actually use?`,
  },
  {
    key: 'live-session-create',
    label: 'verify:live-session-creation-multiturn',
    prompt: `${COMMON}

CLAIM (from plan): A direct UI session created via POST /api/v1/sessions is a LIVE multi-turn session (session_workflow runs with auto_terminate UNSET), and the first user.message kicks the first turn; subsequent user.message events drive subsequent turns.

VERIFY:
1. The session creation route: src/routes/api/v1/sessions/+server.ts (POST). What does it insert + does it call spawnSessionWorkflow? Cite.
2. src/lib/server/sessions/spawn.ts::spawnSessionWorkflow — does it start session_workflow WITHOUT autoTerminateAfterEndTurn (i.e. live/interactive), and how are initialEvents / the first prompt delivered? Confirm the distinction vs the workflow-bridge path which sets autoTerminateAfterEndTurn:true.
3. Confirm via services/dapr-agent-py/src/main.py that auto_terminate is derived from the input message and that when unset the session stays in the while-True loop (already partially confirmed at L5154/L5282-5286 — corroborate how auto_terminate is read from the message).
4. How does a brand-new session with NO initial user message behave — does it idle immediately waiting for user_events? (We need to set a goal then post the first continuation.)
GAP focus: what fields must POST /api/v1/sessions include to get a live dapr-agent-py session bound to a deepseek agent (agentId/environment/modelSpec/mcpServers)? Is there an existing agent row we can reuse or must we create one?`,
  },
  {
    key: 'lifecycle-reaper',
    label: 'verify:lifecycle-stop-and-reaper',
    prompt: `${COMMON}

CLAIM (from plan): A goal loop is just a live session, so POST /api/v1/sessions/[id]/stop {mode} already terminates it via the Lifecycle Controller; we add: on interrupt set Active goal->paused; and a goal-loop-tick reaper endpoint modeled on the lifecycle-terminal-reaper (POST /api/internal/lifecycle/reap-terminal) + a sibling CronJob. There is a stop_requested_at intent column.

VERIFY:
1. src/lib/server/lifecycle/ (cascade/resolvers/index/reaper/ownership.ts) — confirm stopDurableRun(target,{mode}) with target.kind in {workflowExecution, session, evalRun} and the modes interrupt/terminate/purge. Cite where a 'session' target is handled and where session.terminate / user.interrupt are raised.
2. src/routes/api/v1/sessions/[id]/stop/+server.ts — confirm it exists and routes through the Lifecycle Controller. Cite.
3. The reaper endpoint src/routes/api/internal/lifecycle/reap-terminal/+server.ts — confirm shape (internal token auth, what it scans). This is the template for a goal-loop tick reaper.
4. stop_requested_at column — confirm it exists (migration 0071?) and on which table (sessions? workflow_executions?). Cite schema.
GAP focus: where exactly to hook 'on interrupt -> set goal paused' without fighting the controller; how the reaper/tick should detect 'idle' (last session_event is status_idle with no later user.message) reliably; rate-limiting re-posts.`,
  },
  {
    key: 'schema-migration',
    label: 'verify:schema-migration-and-session-events',
    prompt: `${COMMON}

CLAIM (from plan): Add a threadGoals table to src/lib/server/db/schema.ts near the sessions table; generate drizzle/0079_thread_goals.sql (next after 0078); helpers like generateId exist; columns use pgTable/text/integer/bigint/timestamp/unique/index. Also the plan's idle-gate needs to detect an 'unprocessed user.message queued' — implying a processed_at column on session_events.

VERIFY:
1. The sessions table definition in src/lib/server/db/schema.ts (exact export name, id type, columns referenced by FK). Confirm the id generation helper (generateId? nanoid? cuid?) and import it correctly. Cite.
2. The session_events table schema — list its columns. CRITICAL: is there a 'processed_at' column or any way to tell whether a user.message has been consumed by a turn? If NOT, the plan's queued-input gate must use a different signal (e.g. compare latest event type / sequence). Correct the plan.
3. The current HIGHEST migration number in drizzle/ (so the new migration number is right). List the latest few files.
4. Confirm the drizzle import surface (pgTable, text, integer, bigint, timestamp, boolean, unique, index, jsonb) used elsewhere in schema.ts so the new table matches conventions. Note: does this project use bigint mode:'number'?
GAP focus: the plan's unique(session_id) constraint — codex rotates goal_id on a new objective; does one-active-goal-per-session conflict with re-setting a goal after completion? Recommend the right uniqueness/lifecycle (e.g. partial unique on status='active', or replace-on-new).`,
  },
  {
    key: 'ui-session-detail',
    label: 'verify:ui-session-detail-badge',
    prompt: `${COMMON}

CLAIM (from plan, now IN SCOPE for MVP): Add a goal status badge/footer to the session detail page mirroring codex goal_display (objective + status + tokens used/budget + iterations).

VERIFY / LOCATE:
1. The session detail Svelte route + page component (src/routes/.../sessions/[id]/ — find the exact path and the main +page.svelte and any layout/load function). How does it currently load session data (a load fn? an API fetch? SSE subscription to events)?
2. An existing badge / status-chip / footer component pattern to reuse (shadcn-svelte Badge? a session status indicator already on this page?). Cite a concrete component path to model the goal badge on.
3. How real-time updates reach the page (the SSE event stream GET /api/v1/sessions/[id]/events/stream?) so the goal badge can live-update tokens/iterations/status. Cite.
4. The cleanest data source for the badge: a new GET /api/v1/sessions/[id]/goal endpoint vs. embedding goal in the session load. Recommend.
GAP focus: minimal, non-invasive placement; does the page already show a footer/header region where a goal chip fits; svelte 5 runes conventions used here.`,
  },
  {
    key: 'completeness-critic',
    label: 'critic:gaps-and-edge-cases',
    prompt: `${COMMON}

You are an ADVERSARIAL COMPLETENESS CRITIC for the goal-loop plan (codex /goal parity via a LIVE dapr-agent-py session + a BFF driver that re-posts a continuation user.message on each idle, with MCP create_goal/update_goal/get_goal tools writing a thread_goals table, token/time budget accounting from agent.llm_usage events, a max-iteration cap, and a reaper backstop). Your job: find what the plan MISSES or gets risky. For each gap, cite code where relevant.

Investigate and report concrete gaps on:
1. RACE/DOUBLE-DRIVE: inline events.ts hook AND the reaper both posting a continuation; a human typing mid-loop; the agent calling create_goal which itself should kick the first continuation vs. the BFF kicking it (double first turn). How to make 'kick the loop' exactly-once.
2. ORDERING: does agent.llm_usage arrive BEFORE or AFTER session.status_idle for a turn? (Budget must be accounted before the idle continuation decision.) Search how/when these events are published in services/dapr-agent-py/src/main.py.
3. COMPACTION INTERPLAY: long goal loops grow history; the session uses continue_as_new (should_continue_session_as_new in session_native.py). Does continue_as_new preserve the wait_for_external_event semantics so posted continuations are not lost across a continue-as-new boundary? Any risk a continuation posted during compaction is dropped?
4. The 'idle gate' without a processed_at column — how to robustly detect 'a turn is actually waiting' vs 'a turn is mid-flight' to avoid posting into a running turn.
5. SECURITY: the objective is untrusted user text injected into a system-style continuation message; the plan keeps <untrusted_objective> wrapper — is that sufficient given our prompt-injection surface? Any other injection vector (objective into MCP tool args, into SQL)?
6. OBSERVABILITY: should goal iterations/budget be traced (MLflow/OTEL)? The plan is silent.
7. The first continuation vs create_goal: when the agent calls create_goal mid-turn, the turn is still running; the loop should start AFTER that turn idles. Verify the sequencing works.
8. Anything else material the plan overlooks (auth on the new endpoints, multi-runtime claude-agent-py parity for the MCP tools, what happens on agent error/circuit-breaker mid-goal, cost of unbounded continuations).
Return the most important gaps with concrete recommendations.`,
  },
]

const findings = await parallel(
  SPECS.map((s) => () =>
    agent(s.prompt, { label: s.label, phase: 'Verify', schema: FINDING, agentType: 'Explore' })
      .then((f) => ({ ...f, key: s.key }))
  )
)

return findings.filter(Boolean)
