# Goal authoring + alignment with Claude Code `/goal`

> Two questions: (1) is our evaluator-gated goal loop aligned with Claude Code's `/goal` principles? (2) what inputs does our goal-loop action need, and how do we help a user *author* them well — a pre-step that turns raw intent into an optimal goal + evaluation spec, emitted as artifacts the goal-loop action consumes? Pairs with [[goal-loop-evaluator-design]] and [[goal-loop]] (SSOT).

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
| Resume | restores active goal (timers reset) | persisted `thread_goals` + `goal-loop-tick` CronJob | **aligned** |
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

## Risks / guardrails
- **Planner over/under-specifies** → human approval + the validate pass catch this; surface the drafted criteria + a dry-run result before the user commits.
- **Cost** → the planner is a one-time call per goal (cheap relative to the solve loop); the validate dry-run reuses the cheap deterministic evidence path.
- **Scope creep** → the planner should output the *minimal* criteria that capture intent, not gold-plate.

## Bottom line
We're aligned with Claude's `/goal` on the loop, the independent evaluator, bounding, and resume — and deliberately stronger by gating on ground-truth instead of the transcript. The real gap relative to the *spirit* of their docs is **authoring quality**: they teach the user to write a good condition; we should **generate** a good one. A shared `planGoal` pre-step (interactive Workbench + workflow PLAN node) that emits a validated, typed `goal_spec` artifact closes that gap and feeds the existing goal-loop action without changing its contract.
