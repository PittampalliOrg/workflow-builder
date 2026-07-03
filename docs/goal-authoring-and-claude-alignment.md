# Goal authoring + alignment with Claude Code `/goal`

> Questions: (1) is our evaluator-gated goal loop aligned with Claude Code's `/goal` principles? (2) what inputs does our goal-loop action need, and how do we help a user *author* them well — a pre-step that turns raw intent into an optimal goal + evaluation spec, emitted as artifacts the goal-loop action consumes? (3) what native human-in-the-loop building blocks do the newest Dapr Workflows + Dapr Agents give us, and where should we use them vs. BFF orchestration? Pairs with [[goal-loop-evaluator-design]] and [[goal-loop]] (SSOT).

## Part A — Alignment with Claude Code `/goal`

Claude's `/goal` = a session-scoped completion **condition**; after each turn a **small fast model (Haiku)** judges whether the condition holds **against the conversation transcript** (it "does not call tools… can only judge what Claude has already surfaced"); "no" → keep working with the reason as guidance; "yes" → clear. Bound with "or stop after N turns." One goal per session.

| Principle | Claude `/goal` | Ours (evaluator-gated) | Verdict |
|---|---|---|---|
| Completion gates "done", set as a directive | NL condition (≤4000 chars), becomes the turn directive | `objective` re-injected each idle + `acceptanceCriteria` + `evidence` | **aligned** |
| Evaluator is independent of the doer | fresh small model, separate from the worker | BFF, out-of-band, holds completion authority | **aligned** |
| What the evaluator reads | the **transcript** (what the agent surfaced) | **ground-truth workspace** (runs the `evidence.commands`) | **deliberate divergence — ours is stronger** |
| Reason guides the next turn | evaluator's short reason | failing check **output** (output-only since #209) | **aligned** |
| Bound the loop | "stop after N turns" in the condition | `maxIterations` + `tokenBudget` | **aligned** |
| One goal per session | yes | yes (`thread_goals` partial-unique) | **aligned** |
| Status visibility + reason | `◎ active` + latest reason | Goal card + Goal view (pipeline/verdicts) + Pulse | **aligned** |
| Resume | restores active goal (timers reset) | persisted `thread_goals` + event-driven BFF kickoff | **aligned** |
| **Authoring help** | strong docs: *one measurable end state + a stated check + constraints* | **none — the user hand-writes objective/criteria/evidence** | **GAP → Part C** |

**The one principle we intentionally invert.** Claude: *"the evaluator doesn't run commands or read files, so write the condition as something Claude's own output can demonstrate."* Ours is the opposite — our evaluator **does** run commands against ground truth, so our conditions must be authored as **independently-runnable checks**, not transcript assertions. This is why ours can't be fooled by a persuasive-but-incomplete transcript (the "stubbed-out features presented as complete" failure Anthropic's own harness blog warns about), and it is the reason our authoring guidance differs from theirs.

**Verdict:** architecturally aligned on the loop / independent-evaluator / bounded / one-goal / resume principles, and deliberately stronger on the evaluation substrate (ground-truth vs transcript). **Adopt from Claude:** (1) their *condition-authoring discipline* — one measurable end state + a stated check + constraints-that-must-not-change — as the rubric our Part-C planner follows; (2) the *small-fast-model* choice for the future isolated LLM-judge tier (see [[goal-loop-evaluator-design]] Phase 3); (3) keep surfacing the latest verdict reason (we do). **Do NOT adopt** transcript-only evaluation — ground-truth is our differentiator.

## Part B — What the goal-loop action needs to execute

The goal-loop action (`durable/run` with a `goalSpec`, or the one-off `POST /api/v1/sessions/[id]/goal`) consumes:

| Input | Type | Role | What "good" looks like |
|---|---|---|---|
| `objective` | string (**required**) | the persistent directive re-injected each idle | one clear, measurable end state |
| `acceptanceCriteria` | string[] | human-readable "done" conditions; shown to the doer; basis for the future LLM judge | specific + measurable + multi-criterion incl. edge cases |
| `evidence.commands` | string[] | the **deterministic ground-truth gate** | runnable, exit-0-on-pass, **actionable output on fail**, cover the criteria, **don't leak the answer** (#209), ideally ordered/cumulative for incremental reveal |
| `maxIterations` | int | hard cap (`stop_reason=iteration_cap`) | sized to scope |
| `tokenBudget` | int | soft cap → one wrap-up turn | sized to scope |
| *(future)* `evidence.llmCriteria` | string[] | non-deterministic quality, judged by an **isolated** LLM call | see [[goal-loop-evaluator-design]] |

Plus execution context the **BFF supplies** (not authored): the workspace/sandbox where evidence runs (resolved per runtime — openshell workspace for dapr, CLI pod `/sandbox` for interactive-CLI), the session binding, and completion authority.

**The garbage-in problem.** The loop is only as good as these inputs: a vague `objective`, criteria that aren't measurable, or evidence that always-passes / always-fails / leaks the answer all defeat the gate. Authoring them well is hard for a user — which is the entire motivation for Part C.

## Part C — A goal-authoring pre-step (intent → goalSpec)

Add a step **before** the goal loop that converts raw user intent into a validated `goalSpec` — the Anthropic **Planner** role (the "sprint contract" author), distinct from the doer.

**What it does**
1. **Intake** — the user's raw prompt/intent + context (repo, task, constraints).
2. **Clarify** (interactive) — targeted questions to pin the end state, constraints, and what "done" means.
3. **Author** — an optimized `objective`, `acceptanceCriteria` (specific/measurable/edge-cased), and `evidence.commands` that *prove each criterion against ground truth* (generating test files where useful), plus sized `maxIterations`/`tokenBudget`.
4. **Validate the checks** (critical) — run the proposed commands in a scratch/empty workspace to confirm they **fail when unmet and pass when met** (reject always-pass / always-fail / unrunnable checks). Bad evidence silently breaks the gate.
5. **Emit artifacts** — a typed `goal_spec` artifact (the goalSpec JSON) + a rationale doc; hand to the goal-loop action (human-approved).

**Form factor**

| Option | Best for | Pros | Cons |
|---|---|---|---|
| **Interactive "Goal Workbench"** (a session/Goal-card surface) | ambiguous, one-off intent | human-in-the-loop clarify + approve; reuses sessions + the Goal card | manual; one at a time |
| **Workflow PLAN→SOLVE nodes** — a planner `durable/run` (or a `goal/plan` activity) emits a `goal_spec` artifact, an optional approval-gate, then the solver `durable/run` consumes it via `${ .plan.goalSpec }` | automated / repeatable pipelines | composable, artifact-passed, no human needed | needs good auto-clarification; risk of weak criteria without review |
| **Both, sharing one `planGoal()` capability** (recommended) | — | one implementation, two surfaces; the workflow node and the Workbench both call the same planner + validator | — |

**Recommendation:** build a shared, runtime-agnostic `planGoal(intent, context) → goalSpec` capability (an **isolated** LLM/agent call + a validation pass), exposed (a) interactively on the Goal card (Workbench: draft → user edits/approves → set goal) and (b) as a workflow **PLAN** node that emits a `goal_spec` artifact for a following **SOLVE** node. Standardize a typed **`goal_spec` workflow artifact** so any producer emits it and the goal-loop action consumes it uniformly.

**Reuse what exists** (don't build from scratch):
- `src/lib/server/workflows/greenfield-prompt.ts` — already turns a prose prompt into structured JSON via an LLM (the precedent for intent→spec).
- The **Prompt Workbench** (`src/lib/agents/prompt-workbench-renderer.ts`, `resource_prompts`) — optimize the `objective`/prompt.
- `workflow_plan_artifacts` table + `src/lib/server/workflow-artifacts.ts` — persist the plan / typed `goal_spec` artifact.
- `create_goal` MCP (`services/workflow-mcp-server`) + the one-off goal API — the consumers.
- The `buildEvaluatorGoalWorkflowSpec` factory (`scripts/seed-workflows.ts`) — the PLAN→SOLVE shape to extend.

**Design principles (non-negotiable)**
- **Planner is isolated from the doer.** The doer must not author its own checks — that is gaming (and the same isolation principle as the evaluator; see [[goal-loop-evaluator-design]]).
- **Evidence must be runnable + deterministic + actionable + non-leaking** (#209) and **independently verifiable** (Part A's inversion).
- **Human approves the goalSpec** — the planner proposes, the user disposes; criteria must represent the user's actual intent.
- **Validate the checks before committing** — never ship a gate whose checks don't discriminate met vs unmet.

## Part D — Dapr-native human-in-the-loop building blocks (Dapr 1.18 / Dapr Agents)

Surveyed the newest Dapr Workflows + Dapr Agents HITL surface ([v1.18 workflow-patterns](https://v1-18.docs.dapr.io/developing-applications/building-blocks/workflow/workflow-patterns/), [dapr-agents hooks](https://docs.dapr.io/developing-ai/dapr-agents/dapr-agents-hooks/), [extensions](https://docs.dapr.io/developing-ai/dapr-agents/dapr-agents-extensions/)). Summary, then how each maps to the goal system.

**Dapr Workflows — approval gate (native, durable).** Built from three context primitives plus a client raise API: `ctx.wait_for_external_event(name)` (suspend until a matching event), `ctx.create_timer(delta)` (durable timeout), raced via `yield wf.when_any([approval_event, timeout_event])`, and resumed from outside the workflow by `client.raise_workflow_event(instance_id, event_name, event_data)`. The canonical purchase-order shape — under-threshold auto-approves; higher-value calls `send_approval_request` then races the named event against a 24h timer; timer wins → cancel, event wins → proceed. **This is exactly our SW 1.0 approval-gate node** (WEBHOOK → `wait_for_external_event`, DELAY → `create_timer`) — we already use the native primitive.

**Dapr Agents — hooks (new, v1.18+): native mid-loop interrupt/approval.** Hook slots `before_tool_call` / `before_llm_call` / `after_llm_call` (plus reserved `after_tool_call`) each receive a `HookContext` (`step_name`, `step_kind`, `source`, `payload`, `tool_call_id`) and return `Proceed | Mutate(payload) | Skip(result) | Deny(reason) | RequireApproval(timeout_seconds, instructions)`. Returning **`RequireApproval`** from `before_tool_call` pauses the agent *before a risky tool runs* — under the hood it suspends on the same `wait_for_external_event` primitive and resumes via `AgentApprovalConfig` pub/sub (`ApprovalRequiredEvent`/`ApprovalResponseEvent`) **or** the auto-mounted HTTP `GET /hitl/approvals` + `POST /hitl/approvals/{id}/respond`. Registered as `DurableAgent(hooks=Hooks(before_tool_call=[...]))`. **Constraints: dapr-agent-py only; tool-call boundary only** (not LLM-turn, for workflow determinism).

**Dapr Agents — extensions.** One point: `agent.add_activation(callback)` for attaching custom **trigger sources** (event-source integration) to a `DurableAgent`. Not HITL, and **not** an evaluator.

**No native Evaluator-Optimizer / judge.** Confirmed absent from both hooks and extensions — there is no built-in critic that gates completion. Our BFF evaluator-gated loop is the only option and has no Dapr equivalent to fold into.

**Mapping to our goal system**

| Our need | Dapr-native primitive | Native or BFF? |
|---|---|---|
| PLAN→SOLVE approval — human approves the `goal_spec` before solving (Part C step 5) | `wait_for_external_event` + `create_timer` + `raise_workflow_event` (= our approval-gate node) | **Native, via the existing approval-gate node** — runtime-agnostic; the gate sits between the PLAN and SOLVE `durable/run` nodes regardless of which runtime solves |
| Mid-loop risky-tool sign-off *during* SOLVE | Dapr Agents `RequireApproval` (`before_tool_call`) | **Optional per-runtime fast-path (dapr-agent-py only)** — for a uniform cross-runtime risky-action gate use BFF-mediated approval (raise external event / the Lifecycle Controller pause); `RequireApproval` doesn't exist for claude/adk/CLI runtimes and gates at tool boundaries only |
| Escalate when the goal can't be met (hit `iteration_cap`/`budget_limited`) | `wait_for_external_event` to ask a human instead of silently stopping | **BFF-orchestrated** (the goal loop is BFF-driven) — a natural HITL escape hatch on cap/budget exhaustion, surfacing the last verdict |
| Evaluator/judge gating completion | none | **BFF evaluator** — no Dapr equivalent; the tiered evaluator stays the SSOT |

**Net.** Dapr 1.18 gives a solid native *approval/interrupt* substrate (`wait_for_external_event` / `create_timer` / `when_any` / `raise_workflow_event`, plus `RequireApproval` for dapr-agent-py) but **zero** native evaluator. So the architecture is unchanged, just sharpened: the goal-authoring PLAN→SOLVE handoff should use the **native approval-gate primitive** (our existing node) for the human sign-off of the `goal_spec`; `RequireApproval` is a nice optional dapr-agent-py fast-path for risky-tool approval inside SOLVE; and the planner + evaluator + goal loop stay **BFF-orchestrated** for runtime-agnosticism — Dapr-native where *pausing/resuming* lives, BFF where *judgment* lives.

## Part E — Planner agent: validate-by-execution (evolution of Part C)

The Part C planner is a single **blind LLM call** (`goal/plan` → `planGoal()`): it *authors* `evidence.commands` but never *runs* them. Static lint (`lintEvidenceCommands`) catches prose/answer-leak smells but cannot answer the two questions that actually decide whether the evaluator works: **does each check run, and does it discriminate met vs. unmet?** Live DeepSeek runs proved the cost — the `retry` demo's first completion was wrongly rejected because a planGoal-authored inline `node -e "…${…}…"` was mangled by the shell (`sh: Bad substitution`): a *flaky check* that burned an iteration. (Earlier, an absurd auto-authored `tokenBudget:500` tripped `budget_limited` at iteration 0 — fixed by not auto-authoring budgets.)

**The evolution: make PLAN an agent run that proves its own checks.** Symmetric with SOLVE, the PLAN node becomes a `durable/run` **planner agent** in its **own throwaway sandbox** that: drafts the goalSpec → writes a **reference solution** → runs **each evidence command against it (must pass) and against an empty workspace (must fail)** → repairs any command that errors / always-passes / always-fails → emits the validated spec. This is un-deferring Part C step 4 ("validate the checks") as an agent capability instead of static lint only.

**Emission.** A `durable/run` agent has **no structured-output mode** — its result is free text in `.plan_agent.content`. So the agent emits the validated spec as a fenced ```json block and a follow-up `goal/plan` **`fromText` mode** (`finalizeGoalSpecFromText` in `plan-goal.ts`) recovers the canonical contract with the *same* `extractJson` + `normalizeGoalSpec` + `lint` — **no second LLM call**. SOLVE consumes `${ .plan_finalize.goalSpec }`.

**Isolation (non-negotiable).** The planner must not leak the answer to the doer. Two `workspace/profile` nodes give planner and solver **different sandboxes**; the planner's is `keepAfterRun:false` so it leaves **no `workflow_workspace_sessions` row** and is discarded — its reference solution **never reaches SOLVE**. The evaluator's `resolveEvidenceTarget` runs evidence in the **latest retained** workspace = the SOLVE sandbox. Consequence: evidence stays **self-contained inline** (each command references *solve's* `solution.js`); the planner validates those inline commands against its own throwaway reference. (Ferrying planner-written *test files* into the SOLVE sandbox as the contract is a heavier future variant — deferred, since it needs artifact→sandbox delivery.)

| Approach | Evidence quality | Cost / latency | When |
|---|---|---|---|
| **Blind `goal/plan` call** (Part C, shipped) | low — authored, never run | ~1 LLM call | simple goals; the cheap default |
| **Deterministic validate-loop** | medium-high — proven runnable + detects "unmet" | + a scratch sandbox, few calls | middle ground (not built) |
| **Planner agent** (Part E, prototyped: `planned-goal-agent-showcase`) | highest — writes + runs tests vs reference + empty, repairs | a full agent run + sandbox | complex / opt-in goals |

**Tiering recommendation:** keep the cheap deterministic planner as the default; promote to the planner agent for complex goals (or opt-in). Both emit the same `goal_spec` artifact + contract, so SOLVE and the evaluator are unchanged. The two demos (`planned-goal-showcase` deterministic, `planned-goal-agent-showcase` agent) exist side-by-side for A/B.

## Risks / guardrails
- **Planner over/under-specifies** → human approval + the validate pass catch this; surface the drafted criteria + a dry-run result before the user commits.
- **Cost** → the planner is a one-time call per goal (cheap relative to the solve loop); the validate dry-run reuses the cheap deterministic evidence path.
- **Scope creep** → the planner should output the *minimal* criteria that capture intent, not gold-plate.

## Bottom line
We're aligned with Claude's `/goal` on the loop, the independent evaluator, bounding, and resume — and deliberately stronger by gating on ground-truth instead of the transcript. The real gap relative to the *spirit* of their docs is **authoring quality**: they teach the user to write a good condition; we should **generate** a good one. A shared `planGoal` pre-step (interactive Workbench + workflow PLAN node) that emits a validated, typed `goal_spec` artifact closes that gap and feeds the existing goal-loop action without changing its contract. The newest Dapr HITL primitives (Part D) confirm the split: use the **native approval gate** (`wait_for_external_event`/`create_timer`) for the human sign-off of that `goal_spec` and an optional `RequireApproval` fast-path for risky tools on dapr-agent-py, while the planner and evaluator stay **BFF-orchestrated** because Dapr has no native judge and only the BFF path is runtime-agnostic.
