export const meta = {
  name: 'goal-parity-audit',
  description: 'Deep-read codex /goal vs our goal-loop implementation for a behavioral parity audit',
  phases: [{ title: 'Audit', detail: 'parallel deep reads against a fixed checklist' }],
}

const OUT = {
  type: 'object', additionalProperties: false,
  required: ['answers', 'keyQuotes'],
  properties: {
    answers: { type: 'string', description: 'numbered answers to every checklist item, precise, with file:line' },
    keyQuotes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file','quote'], properties: { file: {type:'string'}, lines: {type:'string'}, quote: {type:'string'} } } },
  },
}

const CHECKLIST = `Answer EVERY item precisely with file:line citations and verbatim quotes of the decisive code:
1. CONTINUATION TRIGGER: exact conditions checked before injecting a continuation turn (idle definition, queued-input checks, feature/mode gates, status checks). When does it fire relative to turn lifecycle?
2. CONTINUATION CONTENT: how the continuation message is delivered (hidden developer message? user message?) and whether the template text matches the canonical codex continuation.md (objective wrapper, budget block, completion-audit bullets).
3. BUDGET ACCOUNTING: the EXACT token formula (which usage fields added/subtracted), WHEN it accrues (per tool call? per LLM call? per turn end?), any calls excluded from accounting (e.g. the update_goal call itself), and where wall-clock time accrues.
4. BUDGET LIMIT BEHAVIOR: what happens when budget crosses — status transition, one-time steering injection (how is once-ness guaranteed), can the goal still be completed afterwards, do continuations stop?
5. COMPLETION: who can set which statuses (model vs user vs system), validation on update_goal, what is returned (budget report?), accounting behavior on the completing turn.
6. PAUSE/INTERRUPT: what pauses a goal (user interrupt? explicit API?), can it resume, what happens on thread/session resume after a restart (state restored? counters reset?).
7. CAPS: any max-iterations or other hard caps besides token budget?
8. GOAL REPLACEMENT: setting a new objective — replace vs insert, what resets, goal id rotation.
9. STATE/EVENTS: where goal state persists, and how clients learn of goal changes (events pushed? polling?).
10. EXEMPTIONS: any modes where the loop is inert (plan mode etc.)?`

const results = await parallel([
  () => agent(`Repo: /home/vpittamp/repos/PittampalliOrg/codex/main (READ-ONLY). Subject: codex's /goal implementation — primarily codex-rs/core/src/goals.rs, codex-rs/core/src/tools/handlers/goal.rs, codex-rs/core/templates/goals/{continuation.md,budget_limit.md}, codex-rs/state/src/model/thread_goal.rs, codex-rs/core/src/codex_thread.rs, codex-rs/app-server/src/request_processors/thread_goal_processor.rs.
${CHECKLIST}`, { label: 'audit:codex', phase: 'Audit', schema: OUT, agentType: 'Explore' }),
  () => agent(`Repo: /home/vpittamp/repos/PittampalliOrg/workflow-builder/main at origin/main (READ-ONLY). Subject: OUR goal-loop implementation — src/lib/server/goals/{goal-loop.ts,repo.ts,render.ts,templates/continuation.md,templates/budget_limit.md}, src/lib/server/sessions/events.ts (the side-effect hook), src/routes/api/v1/sessions/[id]/goal/+server.ts, src/routes/api/internal/goal-loop/tick/+server.ts, src/routes/api/v1/sessions/[id]/stop/+server.ts (goal pause), services/workflow-mcp-server/src/goal-tools.ts + goal-db.ts, src/lib/server/db/schema.ts (threadGoals), src/lib/server/sessions/spawn.ts (goal MCP auto-wire + header stamp).
${CHECKLIST}`, { label: 'audit:ours', phase: 'Audit', schema: OUT, agentType: 'Explore' }),
])

return results.filter(Boolean)
