export const meta = {
  name: 'review-readiness-gate',
  description: 'Adversarial review of the kickoff readiness-gate change (race conditions, exactly-once, loop-thread safety)',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const FIND = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'severity', 'detail', 'location'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['bug', 'risk', 'nit'] },
          detail: { type: 'string', description: 'What is wrong + the concrete failing scenario' },
          location: { type: 'string', description: 'file:function or file:line' },
          suggestedFix: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT = {
  type: 'object',
  required: ['isReal', 'reasoning'],
  properties: {
    isReal: { type: 'boolean' },
    reasoning: { type: 'string' },
    severity: { type: 'string', enum: ['bug', 'risk', 'nit', 'not-a-bug'] },
  },
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const CONTEXT = `Review a change to the cli-agent-py service (the claude-code-cli interactive runtime host) that adds a READINESS GATE to kickoff (seed) injection into the Claude Code TUI. Background: the TUI runs in a herdr pane; typing into it before it boots to its prompt loses the keystrokes. The fix waits until herdr reports the agent 'idle' before sending.

The diff is at /tmp/readiness-gate.diff. The full files are in ${REPO}/services/cli-agent-py/src/{session_supervisor.py, session_workflow.py, cli_lifecycle.py, main.py}. READ them.

Key architecture facts you MUST account for (do not flag these as bugs without verifying against the real code):
- session_supervisor.py SessionSupervisor runs on the FastAPI APP loop; it captures self._loop in start(). It consumes a herdr events.subscribe stream and maintains self._committed_state (debounced ~2s) + self._pane_ref.
- start_cli_activity (cli_lifecycle.py) runs on a Dapr workflow WORKER THREAD via asyncio.run() (a throwaway loop). It calls supervisor.register_session(...) then supervisor.arm_seed(text, marker). arm_seed must schedule onto self._loop via asyncio.run_coroutine_threadsafe (cross-thread).
- The kickoff text comes from childInput.initialEvents (first user.message), extracted in session_workflow.py::_extract_seed_user_message, passed as seedUserMessage to start_cli_activity.
- The marker is a zero-width unicode prefix; the UserPromptSubmit hook strips it to avoid re-publishing (the BFF already recorded the kickoff in session_events at create time).
- _inject_seed sets self._seed_injected=True BEFORE awaiting (claim-before-await for exactly-once), then waits for readiness, then sends best-effort even on timeout.
- inject_user_text(await_ready=True) is the raise-event path (goal-loop continuations, manual chat); main.py now also accepts the BFF's canonical 'session.user_events' batch name and injects each user.message.
- continue_as_new: after ~50 when_any cycles the workflow continue_as_news with seeded=True, which SKIPS the seed/start activities — so arm_seed is NOT called again (seed is one-shot per pod).`

phase('Review')
const lenses = [
  {
    key: 'concurrency',
    prompt: `${CONTEXT}

YOUR LENS: **Concurrency / event-loop / thread-safety.** Hunt specifically for:
1. arm_seed is called from a WORKER THREAD (start_cli's asyncio.run loop) but schedules onto self._loop (the app loop). Is run_coroutine_threadsafe used correctly? Is self._loop guaranteed set before arm_seed (start() ordering vs first dispatch)? What if _loop is None or the loop is closed?
2. Exactly-once seed: _inject_seed sets _seed_injected=True before awaiting. Can two _inject_seed run concurrently (arm_seed called twice on activity retry)? The _START_RETRY_POLICY allows 2 attempts — if start_cli_activity runs twice, arm_seed is called twice. Trace whether the guard actually prevents a double-injection given the claim-before-await + the arm_seed _seed_injected check happening on different threads (race between the worker-thread arm_seed check and the app-loop _inject_seed set).
3. self._seed_task holds a concurrent.futures.Future (from run_coroutine_threadsafe), but stop() calls .cancel() on it and earlier code may treat it as an asyncio.Task. Is the type handling consistent? Does register_session reset seed state across continue_as_new pod-reuse (it doesn't reset _seed_injected — is that correct)?
4. wait_until_ready reads self._committed_state and self._pane_ref without locks — are there torn-read or visibility issues across the worker thread vs app loop?
Return concrete findings with the exact failing interleaving.`,
  },
  {
    key: 'correctness',
    prompt: `${CONTEXT}

YOUR LENS: **Functional correctness / edge cases.** Hunt for:
1. Does the kickoff actually reach the TUI now end-to-end? Trace: BFF create → initialEvents in childInput → _extract_seed_user_message → seedUserMessage → arm_seed → _inject_seed → pane_send_text. Any broken link? Does the BFF actually put the kickoff user.message into childInput.initialEvents for a DIRECT (UI) session (check ${REPO}/src/lib/server/sessions/spawn.ts initialEvents construction ~line 123 and the +server.ts sendUserEvent at create)?
2. Double-injection of the kickoff: the kickoff is injected into the TUI by the seed path AND could ALSO arrive via raiseSessionUserEvents (the BFF's mid-session forward) — would the same kickoff get typed twice? Does the marker/dedup prevent a visible duplicate in session_events but NOT a double-type into the TUI?
3. wait_until_ready waits for agent_status==idle. Is 'idle' definitely the 'ready to type' signal for a freshly-booted Claude Code TUI (vs the gate hanging until timeout if herdr reports something else first)? What if the TUI shows a trust/login prompt (blocked) instead of idle — does the seed inject into a blocked prompt?
4. Timeout fallback: on readiness timeout the seed is sent best-effort. If the TUI genuinely isn't ready, the best-effort send is lost — is that acceptable, and is it logged? Could the best-effort send land mid-boot and corrupt the TUI state?
5. main.py session.user_events batch: each user.message is injected with await_ready per message. If there are N messages and the agent goes working after the first, do messages 2..N each wait for idle (serially), and is that the intended behavior?
Return concrete findings.`,
  },
]

const reviews = await parallel(
  lenses.map((l) => () =>
    agent(l.prompt, { label: `review:${l.key}`, phase: 'Review', schema: FIND }),
  ),
)

const allFindings = reviews.filter(Boolean).flatMap((r) => r.findings || [])
if (allFindings.length === 0) return { findings: [], confirmed: [] }

phase('Verify')
const verified = await parallel(
  allFindings.map((f) => () =>
    agent(
      `Adversarially verify this claimed issue in the cli-agent-py readiness-gate change. READ the actual code in ${REPO}/services/cli-agent-py/src/ before deciding — default to isReal=false unless you can cite the concrete code + a real failing scenario.\n\nCLAIM: ${f.title}\nSEVERITY: ${f.severity}\nLOCATION: ${f.location}\nDETAIL: ${f.detail}\nSUGGESTED FIX: ${f.suggestedFix || '(none)'}`,
      { label: `verify:${(f.location || '').slice(0, 32)}`, phase: 'Verify', schema: VERDICT },
    ).then((v) => ({ ...f, verdict: v })),
  ),
)

const confirmed = verified
  .filter(Boolean)
  .filter((f) => f.verdict?.isReal && f.verdict?.severity !== 'not-a-bug')
return { confirmed, allCount: allFindings.length }