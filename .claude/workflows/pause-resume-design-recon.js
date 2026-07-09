export const meta = {
  name: 'pause-resume-design-recon',
  description: 'Ground a pause/resume + on-demand-resume UI design: lifecycle modes, runtime pause/resume endpoints, Dapr suspend/resume, UI controls, crash-vs-terminate semantics',
  phases: [{ title: 'Recon' }],
}

const WFB = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'evidence'],
        properties: {
          claim: { type: 'string' },
          evidence: { type: 'string', description: 'file:line + the exact code/behavior that proves it' },
        },
      },
    },
  },
}

const tasks = [
  {
    label: 'lifecycle-modes-vs-dapr-suspend',
    prompt: `In ${WFB}, read src/lib/server/lifecycle/{index,cascade,resolvers}.ts. 
ANSWER PRECISELY: (1) What does each stop mode do at the Dapr level — interrupt vs terminate vs purge vs reset? Quote the cascade calls. (2) Is the Dapr workflow TERMINATED (terminal, non-resumable) by 'terminate'/'purge', vs merely the pod dying on a crash (workflow state intact, auto-recreated+replayed)? (3) Does ANY code path call Dapr's native suspend_workflow / resume_workflow (pause/resume a workflow WITHOUT terminating it)? grep the orchestrator + lifecycle + dapr-client for 'suspend','resume','pause'. (4) What does 'interrupt' mode actually do to the agent — raise user.interrupt and then what (does the session go idle+resumable, or end)? 
Goal: definitively answer whether an uncontrolled crash and a UI terminate are functionally the same (they are NOT — explain why), and whether a true pause-without-terminate primitive exists.`,
  },
  {
    label: 'runtime-pause-resume-endpoints',
    prompt: `In ${WFB}, the runtimes expose POST /api/v2/agent-runs/{id}/{terminate,pause,resume} + DELETE (per CLAUDE.md). Read services/dapr-agent-py/src/main.py and services/cli-agent-py/src/main.py — find these v2 management endpoints. 
ANSWER: For dapr-agent-py and cli-agent-py SEPARATELY: (1) what do the pause and resume endpoints actually DO internally — do they call Dapr suspend/resume, set a cancellation/pause flag, halt the herdr pane, nothing? Quote the handler bodies. (2) Are they wired/reachable from the BFF (does any src/lib/server or route call them)? grep BFF for 'agent-runs','/pause','/resume','v2/agent-runs'. (3) For the CLI runtime specifically, how does pause/resume interact with the claude TUI + the durable transcript? 
Goal: determine whether functional pause/resume primitives ALREADY EXIST at the runtime layer and just need BFF+UI wiring.`,
  },
  {
    label: 'ui-session-controls',
    prompt: `In ${WFB}, find the session detail UI controls. Read src/routes/sessions/[id]/+page.svelte (and any src/lib/components/sessions/* control/toolbar/action components) — focus on the STOP button(s) and any existing RESUME affordance (the plan referenced a resume gate around [id]/+page.svelte:1070). 
ANSWER: (1) What stop/terminate/interrupt buttons exist today, what modes do they call, and what endpoint (POST .../stop {mode})? (2) Is there ANY existing Resume button, and what gates it (status==='terminated'? interactive-cli only?)? (3) Where in the UI would Pause + Resume buttons naturally go, and what session statuses (rescheduling/running/idle/terminated) drive button enablement? Quote the relevant svelte + the API calls. 
Goal: map exactly what UI exists and what'd need adding for on-demand pause/resume buttons.`,
  },
  {
    label: 'resume-path-and-idle-model',
    prompt: `In ${WFB}, read src/routes/api/v1/sessions/+server.ts (the resume precondition we recently changed — canResumeCliSession), src/lib/server/sessions/spawn.ts (resumeFromSessionId + continueSession), and the dapr-agent-py session turn/idle model in services/dapr-agent-py/src/main.py (session_workflow: does a direct session go IDLE after each turn and WAIT for the next user.message, i.e. is 'resume' just 'send the next message' for a still-alive session?). 
ANSWER: (1) For dapr-agent-py: after a turn, does the session_workflow go idle and wait (resumable by sending a message) or terminate? Is there an autoTerminateAfterEndTurn distinction (workflow-driven vs direct UI sessions)? (2) For CLI: resume = new session with resumeFromSessionId -> re-mount transcript subPath -> claude --continue. Confirm the mechanics + the (now relaxed) precondition. (3) Could 'resume on demand' for a still-alive (idle) dapr-agent-py session be implemented simply as 'send the next user message', distinct from resuming a terminated/crashed one? 
Goal: clarify the resume mechanics per runtime so the UI design distinguishes idle-continue vs crashed-resume vs terminated.`,
  },
]

const results = await parallel(
  tasks.map((t) => () =>
    agent(t.prompt, { label: t.label, phase: 'Recon', schema: SCHEMA, agentType: 'Explore' })
      .then((r) => ({ label: t.label, ...r }))
  )
)
return results.filter(Boolean)
