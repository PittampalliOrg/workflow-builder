# Generator + Critic Multi-Agent (Rubric-Gated Goal Loops)

**Status:** Phase 1 IMPLEMENTED + dev-verified (workflow-native evaluator-optimizer; see §8). Phase 0 (deterministic evidence) was already SHIPPED; Phases 2–4 remain.

**Related SSOTs:** `goal-loop.md` (goal-loop SSOT), `goal-loop-evaluator-design.md` (the evaluator-optimizer proposal this extends), `callable-agents.md` (`CallAgent` peer delegation), `agent-node-and-workflow-sandbox-architecture.md` (`goalLifecycle` adapter + `sandbox.scope`), `workflow-execution-architecture.md` (SW 1.0 interpreter vs workflows-as-code), `agent-runtime-comparison.md`.

---

## 1. The ask

Run a multi-agent loop with **two distinct agents**, each with its own system prompt, MCP servers, tools, and model:

- a **generator** that produces work and **does not** have the `update_goal` tool (no self-grading), and
- a **critic** that judges the generator's output against explicit criteria / a **rubric** and holds completion authority.

This should work for **objective** outcomes (tests pass) *and* **subjective** ones — most importantly frontend/UX design quality, where there is no single ground-truth command. The loop should run **with or without a central orchestrator**, and use **dynamic workflows** (our SW 1.0 interpreter) where it fits.

The motivation is empirical (see §2): an agent grading its own work is systematically lenient, so separating generation from evaluation is the single biggest quality lever for long-running, autonomous runs.

---

## 2. What the references tell us

### 2.1 Anthropic — *Harness design for long-running agentic apps* (the "why")

- **Self-evaluation is systematically lenient.** Agents "confidently praise the work — even when it's obviously mediocre," on subjective *and* objective tasks. A **separate evaluator agent** is "a strong lever" against this (it doesn't fully remove LLM-toward-LLM generosity, but a distinct evaluator can be tuned toward skepticism).
- **Ground-truth verification beats reasoning about correctness.** Their evaluator drove the *live app* with Playwright (UI flows, API endpoints, DB state) rather than reading code or screenshots alone.
- **Subjective quality is made gradable by decomposition** into named dimensions: **design quality** (coherent whole), **originality** (custom vs. template/AI-default), **craft** (typography, spacing, color, contrast), **functionality** (task completion). The evaluator *interacts* (navigate + screenshot + study) before judging; loops ran **5–15 cycles**.
- **Calibrate with few-shot scored examples** to prevent score drift; **tune skepticism iteratively** by reading eval logs.
- **Negotiate a testable "done" contract up front** (what's built + how it's verified) before generating.
- **Bound iterations**; **manage context via reset + handoff artifacts**, not in-place compaction; **strip harness scaffolding as models improve** ("every component encodes an assumption about what the model can't do on its own").

### 2.2 LangChain — *Rubrics for DeepAgents* (`RubricMiddleware`) (the "mechanism")

- A **rubric** is a newline-delimited checklist of discrete pass/fail criteria, attached **per invocation** (in the input payload), not baked into the agent.
- The grader is a **dedicated sub-agent** with its own `model`, `system_prompt`, and `tools` (e.g. a `run_test_suite` tool + reviewer prompt); the generator is a separate agent, unaware of the rubric.
- Loop: generate → grader evaluates → all satisfied ⇒ terminate, else **per-criterion feedback re-injected** into the conversation → regenerate. **Grader decides pass/fail; `max_iterations` is the hard bound.** Terminal states: `satisfied | max_iterations_reached | failed | grader_error`.
- A **cheaper model for the grader** is viable (their example: Haiku grader / Sonnet generator).
- Limitation: rubric criteria are **objective/testable only** — no weights, no subjective gradations. (Anthropic's decomposition fills that gap.)

### 2.3 Dapr Agents / Diagrid (the "framework scaffolding")

- **Two ways to compose multi-agent in the framework:**
  - **With orchestrator (centralized, deterministic):** `call_agent(ctx, name, input=, app_id=)` inside a `@workflow` schedules another agent's `session_workflow` as a durable child workflow — directly analogous to our `ctx.call_child_workflow("session_workflow", app_id=…)` bridge. Also `DurableAgent` orchestrators in `OrchestrationMode.{RANDOM,ROUNDROBIN,AGENT}`.
  - **Without orchestrator (decentralized, event-driven):** each agent is a service subscribing to its own pub/sub topic (+ a `broadcast_topic`); they discover each other via a shared registry (`team_name`) and collaborate over the bus. Pub/sub arrival still *starts a durable workflow* on the receiver, so per-agent durability is preserved; you trade global determinism for flexible composition.
- **Per-agent identity** is just `role` / `goal` / `instructions` (system prompt), `tools=[@tool…]`, and a per-agent `MCPClient` (`connect_streamable_http|sse|stdio`) — i.e. "separate prompt + separate tools/MCP" is the native shape.
- **Evaluator-optimizer reference:** `diagrid-labs/building-effective-dapr-agents/07_evaluator.py` — a durable `while iteration ≤ max_iterations and not meets` loop with a `generate` task and an `evaluate` task returning typed `Evaluation{score, feedback, meets_criteria}`; the critic's `feedback` is re-injected into the next generate call. **But it is LLM-judged in-loop, not ground-truth.**

### 2.4 The throughline

All three agree on the shape: **generate → independent critic evaluates against explicit criteria → satisfied ends, else specific feedback re-injected → repeat, hard-bounded.** They differ on the verdict basis (LangChain: objective tools; Diagrid: LLM score; Anthropic: ground-truth + decomposed subjective dimensions). **Our existing evaluator-gated goal loop already runs ground-truth `evidence.commands` and holds completion authority in the BFF** — which is *stronger* than the framework defaults and is the natural seam for a critic.

---

## 3. What already exists in workflow-builder

(Code-grounded; see the cited files.)

| Capability | Status | Where |
|---|---|---|
| Two `durable/run` nodes, **different agents** (own prompt + MCP + model) in one workflow | **EXISTS** | per-node resolve `sw_workflow.py` `_resolve_native_agent_runtime` (~`:1453`); each node → its own per-session sandbox + `agentConfig` |
| Per-agent **system prompt / mcpServers / allowedTools / model / callableAgents / hooks** | **EXISTS** | `src/lib/types/agents.ts` (`systemPrompt`, `mcpServers`, `allowedTools`, `modelSpec`, `callableAgents`); resolved in `spawn.ts` |
| **Generator with NO `update_goal`** | **EXISTS (implicit)** | a `durable/run` node *without* `goalSpec` → `ensure-for-workflow` only wires the goal MCP when `bridgeGoal` present (`ensure-for-workflow/+server.ts:~416`); also global `GOAL_MCP_AUTO_WIRE=false` (`mcp-wiring.ts:22-46`) |
| **Independent completion authority** running ground-truth evidence | **EXISTS** | `evaluateGoalCompletion` (`evaluator.ts:209-255`) + `POST /api/internal/goals/[id]/evaluate` ("authority to complete lives here, not with the doer") |
| **Feedback re-injected as next turn** | **EXISTS** | `postEvidenceRejection` / continuation driver (`goal-loop.ts:250-399`); `driveContinuationIfIdle(fromStopHook)` |
| **One agent calls another as a tool** | **EXISTS** | `CallAgent` (`callable-agents.md`); dapr-agent-py only, `AGENT_CALL_AGENT_NATIVE=1`; returns peer's message as a `tool_result` (advisory, not authority) |
| **Bounded loop** in the interpreter | **PARTIAL** | `for` + `while:` guard (`_handle_for_task` `sw_workflow.py:2887-2939`); no dedicated `loop-until` handler (canvas `loop-until` → `for`/`while` compilation UNVERIFIED) |
| **Dynamic / runtime-created workflows** | **EXISTS** | SW 1.0 interpreter: spec is JSONB in `workflows.spec`, a new row = a new workflow, no redeploy (`workflow-execution-architecture.md`) |
| **Critic as an *agent*** (own prompt+tools) judging the generator | **NEW** | designed below |
| **LLM critic tier** (isolated context, adversarial prompt, different model) | **NEW (designed, not built)** | `goal-loop-evaluator-design.md:86-93` (Phase 3) |
| **Rubric** (objective + subjective dimensions) on a goal | **NEW** | designed below |
| Subjective design grading via screenshots/live-app | **PARTIAL** | `browser/validate` captures in-sandbox screenshots (Browser Validation section, CLAUDE.md) — a critic tool, not yet wired to the evaluator |

**Key architectural fact:** the system already separates *requesting* completion (the `update_goal` MCP tool, just a request) from *granting* it (the BFF `/evaluate` endpoint, the authority). A critic slots into the **granting** seam. This is why most of the work is additive, not a rewrite.

---

## 4. Design options

Three ways to realize generator+critic, ordered by increasing weight. They are **not mutually exclusive** — the recommendation (§5) is a tiered composition.

### Option A — BFF-orchestrated critic tier (extend the evaluator)

One generator session (no `update_goal`). The BFF evaluator gains a **critic tier** behind the deterministic checks: an **isolated LLM call** with an adversarial/skeptical prompt, a different (often cheaper) model, the goal's **rubric**, and read access to the workspace + optional **screenshot evidence** (via `browser/validate`). It returns a typed verdict `{met, perCriterion[]}`. Not-met → existing continuation injection. The critic is a **stateless judge**, not a peer agent.

- **Orchestrator:** the BFF (centralized, deterministic, runtime-agnostic — works for all 4 runtimes incl. CLI).
- **Pros:** smallest delta; reuses completion authority + continuation loop + Stop-hook trigger; critic context is isolated by construction; cheap (gated behind cheap deterministic checks); no goal-session-sharing problem; single verdict seam.
- **Cons:** the critic is one LLM call, not an agent that can *autonomously probe* over multiple turns with its own MCP tools; subjective interactive design review (navigate→screenshot→re-navigate, 5–15 cycles) is limited to what one call + the evidence we hand it can do.

### Option B — Critic as a second `durable/run` agent node (true multi-agent)

Generator node (agent A, no `goalSpec`, own MCP) → **critic node** (agent B, skeptical prompt, own MCP incl. test/Playwright tools **and** the goal MCP / `update_goal`). The critic is a full agent that can navigate the live app, run tests, inspect DB/API, and *then* call `update_goal(complete)` → BFF `/evaluate`. The generator literally cannot self-complete (different session, no goal MCP). Loop via the interpreter (`for`+`while`) or the single-session continuation driver.

- **Orchestrator:** the SW 1.0 interpreter (centralized, durable, replayable, canvas-visible) **or** without one via `CallAgent` (generator invokes critic peer as a tool — but then the verdict is advisory unless the critic itself calls `/evaluate`).
- **Pros:** the critic is a real agent — best fit for **subjective/interactive design review** (matches Anthropic's Playwright loop); maximal separation; reuses `CallAgent`/two-node dispatch.
- **Cons:** **goal-session-sharing semantics** need design (the goal currently lives on one session; the critic must be the session that completes it); per-iteration spawn cost (heavier); `CallAgent` path is dapr-agent-py only; `loop-until→for` compilation gap; more moving parts.

### Option C — Dapr-native evaluator-optimizer workflow (Diagrid pattern)

Author the generator↔critic alternation as an explicit durable loop — either the SW 1.0 `for`+`while` (Option B's loop made visible on the canvas) or workflows-as-code. Effectively a packaging of Option B; the LLM-judged Diagrid form is *weaker* than our ground-truth evaluator and is only attractive when no ground truth exists and we deliberately accept LLM judgment.

- **Pros:** canvas-visible, fully durable/replayable; mirrors a well-known reference.
- **Cons:** if it relies on in-loop LLM judgment it regresses from our ground-truth authority; the static spec makes per-goal rubric variation awkward (better carried as data on the goal).

### Comparison

| Axis | A — BFF critic tier | B — critic agent node | C — evaluator-optimizer workflow |
|---|---|---|---|
| Critic is a full agent (own MCP, multi-turn probing) | ✗ (one LLM call) | ✓ | ✓ |
| Runtime-agnostic (works for CLI/claude/adk too) | ✓ | dapr-agent-py-leaning | dapr-agent-py-leaning |
| Reuses existing completion authority unchanged | ✓ | needs goal-session sharing | needs goal-session sharing |
| Best for **subjective/interactive** design review | partial | ✓ | ✓ |
| Best for **objective** (tests/build) | ✓ | ✓ | ✓ (but LLM-judged unless wired to evidence) |
| New moving parts | low | medium | medium–high |
| Per-iteration cost | low (gated LLM call) | high (agent session/turn per cycle) | high |
| Canvas-visible loop | ✗ (BFF-internal) | optional | ✓ |
| Determinism risk | low | low (interpreter loop) / medium (CallAgent) | low |

---

## 5. Recommended architecture — tiered, rubric-gated, BFF-as-authority

Compose the options as **escalating tiers behind a single completion authority** (the BFF `/evaluate` seam), matching the tiered direction in `goal-loop-evaluator-design.md`. The **generator never holds `update_goal`**; the **verdict always belongs to the BFF**, regardless of which tier produced it. This keeps it runtime-agnostic and unifies the loop we already verified (deterministic + Stop-hook continuation).

```
generator session (no update_goal)
        │ produces work, ends turn (Stop hook / idle)
        ▼
BFF evaluator  ── Tier 0: deterministic evidence.commands   (EXISTS — cheap ground truth)
                ── Tier 1: isolated LLM critic + rubric      (Option A — default for most goals)
                ── Tier 2: critic AGENT (own MCP, multi-turn)(Option B — opt-in, subjective/interactive)
        │ met → markGoalComplete + terminate
        │ not-met → inject per-criterion feedback as the next continuation (EXISTS)
        ▼
generator gets failing criteria as next turn → iterate (hard-bounded by maxIterations)
```

- **Tier 0 (deterministic)** runs first and cheap; if it fails, never spend a critic LLM call. (Already shipped + verified.)
- **Tier 1 (LLM critic, Option A)** is the **default** when a `rubric` is present: one isolated, skeptical LLM call, gated behind Tier 0, optionally fed screenshots (`browser/validate`) and the workspace diff. Cheap, runtime-agnostic. Covers objective rubric items and lightweight subjective judgment.
- **Tier 2 (critic agent, Option B)** is **opt-in** for goals that need autonomous interactive probing — frontend/design especially. A dedicated critic `durable/run` node / peer holds `update_goal`; it navigates with Playwright, screenshots, runs tests, and renders the verdict. Use the SW 1.0 interpreter loop (centralized, durable) as the default orchestration; reserve the `CallAgent` decentralized variant for cases where the generator should pull the critic mid-turn.

### 5.1 Schema: rubric + critic config on the goal

Extend `goalSpec` (carried on the `durable/run` node `with:` and persisted with the goal). Backward-compatible — absent `rubric`/`critic` ⇒ today's deterministic-only behavior.

```jsonc
{
  "objective": "…",
  "acceptanceCriteria": ["…"],          // human-readable (existing)
  "evidence": { "commands": ["…"] },     // Tier 0 ground truth (existing)
  "maxIterations": 15,                    // hard bound (existing)

  "rubric": {                            // NEW — drives Tier 1/2
    "criteria": [
      { "id": "tests",   "kind": "objective",  "description": "All unit tests pass" },
      { "id": "craft",   "kind": "subjective", "dimension": "craft",
        "description": "Typography scale, spacing rhythm, color harmony, AA contrast" },
      { "id": "original","kind": "subjective", "dimension": "originality",
        "description": "No template/AI-default look; distinct identity" }
    ],
    "calibration": [                      // few-shot scored examples (anti-drift)
      { "note": "museum-quality reference", "verdict": "pass", "evidenceRef": "…" }
    ]
  },

  "critic": {                            // NEW — selects the tier + how it judges
    "mode": "llm",                       // "deterministic" | "llm" | "agent"
    "model": "deepseek-v4-pro",          // cheaper/skeptical judge model
    "skepticism": "default-reject",      // bias: require positive evidence to pass
    "tools": ["browser/validate"],       // evidence the critic may gather (Tier 1)
    "agentSlug": "design-critic",        // Tier 2 only: the critic agent
    "maxCriticIterations": 10            // Tier 2: bound the critic's own probing
  }
}
```

For **subjective design**, default the rubric dimensions to Anthropic's four (**design quality / originality / craft / functionality**) and have the critic gather screenshots via `browser/validate` before judging.

### 5.2 Verdict contract (uniform across tiers)

```jsonc
{
  "met": false,
  "terminalState": "rejected",           // satisfied | rejected | max_iterations_reached | critic_error
  "perCriterion": [
    { "id": "tests",   "met": true },
    { "id": "craft",   "met": false, "feedback": "Body line-height 1.2 is cramped; …", "score": 6 },
    { "id": "original","met": false, "feedback": "Hero is a default gradient template; …", "score": 4 }
  ]
}
```

Not-met → `perCriterion[].feedback` for failing items becomes the continuation injected to the generator (reusing `postEvidenceRejection`). `critic_error` is treated as not-terminal (retry next idle), never as a silent pass.

### 5.3 With vs without orchestrator (explicit)

- **Default = with orchestrator, and the orchestrator is the BFF** (Tiers 0/1). Centralized, deterministic, runtime-agnostic, single completion authority. This is the safest and reuses everything verified.
- **Tier 2 with orchestrator = SW 1.0 interpreter** `for`+`while` loop (durable, replayable, canvas-visible) — preferred when the loop should be inspectable/operable.
- **Without orchestrator = `CallAgent`/pub-sub peer** — generator pulls the critic mid-turn (decentralized, dapr-agent-py only). Allowed, but **completion authority must still terminate in the BFF** (the critic peer calls `/evaluate`); a purely advisory peer verdict must not grant completion. Recommended only for emergent/ad-hoc collaboration, not as the completion gate.

---

## 6. Implementation plan

Phased; each phase independently shippable + dev-verifiable. Files are indicative.

### Phase 1 — Rubric data model + Tier 1 LLM critic (Option A) — highest value, lowest risk
1. **Schema/types:** add `rubric` + `critic` to the goalSpec types and the goal persistence (`src/lib/types/agents.ts` goalSpec, `src/lib/server/goals/repo.ts`, a drizzle migration for the `thread_goals` columns / JSONB).
2. **Critic tier in the evaluator:** extend `evaluateGoalCompletion` (`evaluator.ts`) — after deterministic evidence passes (or when there are no `evidence.commands`), if `critic.mode==="llm"` run an isolated LLM call (reuse `openai-gateway.ts` / the planGoal isolated-call pattern) with an adversarial system prompt, the rubric, and gathered evidence (workspace summary + optional `browser/validate` screenshots). Return the uniform verdict (§5.2). Keep deterministic-only behavior when no rubric.
3. **Feedback mapping:** map failing `perCriterion` to the continuation text in `postEvidenceRejection` (`goal-loop.ts`) — no change to the trigger/exactly-once machinery (Stop-hook + idle already verified).
4. **Calibration + skepticism:** thread `rubric.calibration` few-shot examples and `critic.skepticism="default-reject"` into the critic prompt.
5. **Verify (dev):** a subjective design goal (small SvelteKit page) — confirm Tier 0→Tier 1 ordering, per-criterion feedback re-injected, bounded iterations, `terminalState` correctness. Reuse the Stop-hook harness from the rounding/Roman demos.

### Phase 2 — Subjective design evidence (screenshots) + dimensions
6. **Wire `browser/validate` as a critic evidence source** (it already captures in-sandbox screenshots → `workflow_browser_artifacts`); pass image artifacts into the Tier 1 critic call.
7. **Default design rubric**: a preset with the four dimensions (quality/originality/craft/functionality) selectable on the Goal card / agent-node config.
8. **Verify:** a "build an impressive landing page" goal; observe multi-cycle convergence (expect several rejects on craft/originality before pass), à la Anthropic's 5–15 cycles.

### Phase 3 — Critic AS an agent (Option B / Tier 2) — for autonomous interactive review
9. **Critic-agent dispatch:** when `critic.mode==="agent"`, run the critic as a `durable/run` peer (own prompt + MCP incl. Playwright + the goal MCP). Resolve the **goal-session-sharing** question: simplest is the critic owns the goal session and the generator is a `CallAgent`/sub-step it drives; alternative is a two-node interpreter loop where the critic node calls `/evaluate`. Pick one (lean: critic-owns-goal + generator-as-tool, reusing `CallAgent`).
10. **Generator hard-lockout of `update_goal`:** today it's implicit (no `goalSpec` ⇒ no goal MCP). Add a per-agent/per-node `disableGoalMcp` flag (small change in `mcp-wiring.ts` / `ensure-for-workflow`) and/or a `PreToolUse` hook blocking `update_goal` for the generator (dapr-agent-py hooks already exist) so the lockout is enforced, not merely instructed (we currently force it via prompt text — see the rounding-odd demo).
11. **Bounded canvas loop (optional):** verify/implement `loop-until → for`+`while` compilation so the alternation is canvas-authorable; otherwise keep it BFF-driven (single-session continuation loop).
12. **Verify:** a frontend-design goal with `critic.mode==="agent"`; confirm the critic navigates + screenshots + renders a gated verdict, the generator never self-completes, and completion still lands in the BFF.

### Phase 4 — Hardening / ops
13. Eval-log surfacing for **skepticism tuning** (read divergences, edit the critic prompt) — a maintenance loop, per Anthropic.
14. Cost guardrails: critic-call budget accounting (reuse `agent.llm_usage` net-of-cache convention); `critic_error` retry/backoff; ensure Tier gating actually short-circuits.
15. Docs: fold the shipped result back into `goal-loop.md` (SSOT) and update `goal-loop-evaluator-design.md` Phase 3/4 status.

### Out of scope (for now)
- Replacing the deterministic evidence path (Tier 0 stays the cheap first gate).
- A fully decentralized pub/sub critic that grants completion without the BFF seam (allowed as advisory only).
- The `goalLifecycle` registry-adapter generalization (`agent-node-and-workflow-sandbox-architecture.md`) — orthogonal, can land independently.

---

## 7. Open questions / risks

- **Goal-session sharing (Tier 2):** the goal lives on one session today; a critic agent that completes it must be that session (or `/evaluate` must accept a target session distinct from the caller). Needs a small design decision before Phase 3.
- **`loop-until` interpreter handler:** unverified whether the canvas `loop-until` node compiles to a `for`/`while` spec; confirm before promising canvas-authorable loops.
- **Subjective verdict stability:** LLM critics drift; calibration examples + `default-reject` skepticism mitigate but do not eliminate. Keep iterations bounded and surface eval logs.
- **Strong models mask iteration:** as observed in the Stop-hook verification, capable models one-shot objective tasks and self-correct within a turn via `update_goal`. The generator/critic split is most valuable exactly where ground truth is thin (design) — which is where we should target Phase 2/3 demos.
- **Cost:** Tier 2 (agent critic, multi-turn, screenshots) is expensive; keep it opt-in and gated behind Tiers 0/1.

---

## 8. Phase 1 implementation + dev verification (2026-06-18)

Phase 1 chose the **workflow-native** realization (the Dapr evaluator-optimizer pattern expressed in our SW 1.0 interpreter), fed by a separate planning step — per the user's steer toward the Dapr `@workflow` while-loop. Implemented on branch `feat/evaluator-optimizer-generator-critic` (`89f0122b`):

- **Loop-state ergonomic** (`sw_workflow.py` `_handle_for_task`): each `for` iteration publishes the previous iteration's sub-task outputs under `.loop.last.<subtask>`, plus `.loop.index`, `.loop.accepted` (set when any sub-task output has `meets_criteria: true`), `.loop.iterations`. Lets the `while` guard + generator prompt read the prior verdict/feedback without dynamic-index jq.
- **`parseJson` task affordance** (`_apply_parse_json_affordance` + `_loose_extract_json`): when a task declares `parseJson: true`, a JSON object is extracted from its (agent) output and merged into the stored output, so a critic ending its turn with STRICT JSON surfaces as real fields (`.evaluate.meets_criteria`). Tolerant extractor mirrors `plan-goal.ts`.
- **Child-instance-id sanitization** (the load-bearing bug fix): a `durable/run` nested in a `for` loop is named `<loop>/<sub>[<idx>]`, so the child Dapr **workflow instance id** contained `/` and `[]` — not routable as actor ids. The sandbox booted and registered but the child workflow never executed (stuck `rescheduling`). Now any non-`[A-Za-z0-9_.-]` char is replaced with `-`. **This is what makes `durable/run` work inside any loop**, not just this feature.
- **planGoal rubric** (`plan-goal.ts`): authors an optional rubric (objective|subjective criteria + design dimensions) alongside the evidence contract.
- **`evaluator-optimizer-showcase` template**: `workspace_profile (retained) → plan → for[1..N] while !.loop.accepted { generate (no goalSpec → no update_goal), evaluate (parseJson critic) } → summary`.

**Verified end-to-end on ryzen** (the unmerged build deploys to the ryzen spoke; dev pins only update on merge):
- ✅ Loop dispatches `generate→evaluate` per iteration with sanitized ids; each agent self-reaps (autoTerminate) freeing its Kueue slot for the next.
- ✅ Accept path: critic emits `{meets_criteria:true,...}` → `parseJson` → `.loop.accepted` → `while`-break → `summary` → `exec success` (run `ScQTBFHt`).
- ✅ Reject-continue: on `meets_criteria:false` the loop iterates (5+ rounds, run `onYgGdcE`).
- ✅ Content carry: `.loop.last.generate.content` carries the prior attempt into the next generator prompt.
- ✅ Feedback ref resolves null-safe; hardened so the generator consumes the **whole verdict** when the critic omits a top-level `feedback` field: `if .loop.last.evaluate then (.loop.last.evaluate.feedback // (.loop.last.evaluate | tojson)) else "(none yet)" end`.

**KEY FINDING — empirical case for the ground-truth tier.** On a deliberately *objective* task (hidden round-half-to-odd), the LLM critic **hallucinated a pass**: the generator implemented round-half-*away* (`1.5→2`, even), yet the critic returned `"ties-odd": {pass:true, failing_cases:[]}` claiming all ties were odd — it asserted a pass without actually running the verification sweep. This is exactly the self/LLM-judge leniency Anthropic warns about, and it validates the tiered design: **objective criteria must be gated on ground-truth `evidence.commands` (Tier 0), not LLM judgment** — the LLM critic is for *subjective* criteria. Phase 3's objective ground-truth tier is therefore not optional polish but the correctness backbone for objective rubric items.

**Environment gaps encountered (orthogonal to the feature; noted for the full plan-node path):**
- ryzen's `function-router` predates the `goal/plan` route (routes it to a nonexistent `ap-goal-service`) — verification used a hardcoded `goalSpec` via a `set` node instead of the live `planGoal`. Deploy a current function-router to exercise the real plan step.
- the execute route requires every `durable/run` to carry a named `agentRef`; inline-only `agentConfig` is rejected.
- registered dapr-agent-py agents on ryzen pin `runtime_app_id: agent-runtime-pool-coding` (a phantom app-id) → stuck `rescheduling`; a per-session agent needs `runtime_app_id: null` (created `evalopt-agent`). The Kueue `interactive-agent` quota is only 2 pods — zombie sandboxes from interrupted runs exhaust it and must be reaped.

---

## 9. Phase 2 — subjective design grading (2026-06-18)

Per the "code-level now, vision when Anthropic is free" decision, Phase 2 ships the design-critic loop on the default (deepseek) model with a clean upgrade path to pixel-level vision.

**Feasibility findings (vision):** the ONLY image-preserving path is **Anthropic models via the direct SDK** (`anthropic_adapter.py` handles image tool_results); `deepseek-v4-pro` and everything through the MLflow gateway **flatten images to text** (`gateway_adapter.py:_as_text`). `browser/validate` stores screenshots to `workflow_browser_artifacts` for human review — it does **not** feed the agent. So a true vision critic = a Tier-2 critic agent on `anthropic/claude-*` + Playwright MCP (it screenshots itself); the page must be *served* (the generator's files live in the openshell workspace, not the critic pod).

**Shipped (`design-critic-showcase` template):**
- A **4-dimension design rubric** (Anthropic's design_quality / originality / craft / functionality) — `planGoal` authors these for design intents; the template hardcodes them.
- A **default-reject, museum-quality-calibrated critic** that reads the generator's HTML/CSS and judges each dimension (code-level critique).
- The generator builds a landing page in the shared workspace, no `goalSpec` → no `update_goal`.
- **Structured for the vision upgrade with no rework**: flip the critic node's `modelSpec` → `anthropic/claude-*` and add Playwright MCP to its `mcpServers`.

**Verified on ryzen:**
- ✅ The critic produces a *rigorous, taste-driven* 4-dimension evaluation — e.g. it checked AI-default tells (flagged Playfair+Inter+JetBrains fonts *not* system default, amber *not* `#007bff`, no generic 3-card layout) and cited concrete flaws (a `#pricing` nav link with no pricing section). Not a rubber stamp.
- ✅ **Multi-cycle convergence** (run `EPY2kvr1`): generate-0 → evaluate-0 (**reject**) → generate-1 → evaluate-1 (**accept**).
- ✅ **Real feedback carry** — generate-1's prompt contained the critic's *actual* verdict text (via the robust `.loop.last.evaluate | tojson` fallback). This also closes the Phase-1 open item (multi-iteration feedback carry with real critic feedback).

**Deferred to Phase 2.5 (coupled — both need the browser-render path):**
- **Screenshot artifact** for human review: a `browser/validate` capture step was authored + correctly wired (routes to `openshell-agent-runtime /api/browser/validate`), but `openshell-agent-runtime` is a **Knative scale-to-zero** service and every call **cold-starts past the function-router's 45s timeout** (`Cold start detected: 45004ms vs avg 8894ms`). Needs a Knative min-scale (keep-warm) or a higher browser/validate timeout. The capture node is removed from the shipped template until that's addressed.
- **Pixel-level vision critic**: flip the critic to `anthropic/claude-*` + Playwright MCP (Anthropic-only; gated on Anthropic API quota, flagged limited until 2026-07-01).

---

## 10. Phase 3 — objective ground-truth tier (2026-06-18)

The Phase-1 finding (the LLM critic hallucinated a pass on an objective rule) made the **objective ground-truth tier** the correctness backbone. The scout confirmed it is achievable **entirely template-level** — no orchestrator/BFF/dapr-agent-py deploy.

**Shipped (`evaluator-gated-showcase`):** the loop body is `generate → gate → evaluate`, where **`gate` is a deterministic `workspace/command`** node that runs the objective checks in the shared workspace (`with: { workspaceRef, command: "cd /sandbox && node -e '<sweep>' ...", allowFailure: true }`). Acceptance is an explicit AND in the `while` guard: **gate-pass (stdout contains `OBJECTIVE PASS`) AND critic `meets_criteria`** — so a hallucinated critic pass cannot accept a broken solution. The generator's prompt now includes the gate's real stdout (the failing cases) alongside the critic feedback. The `summary` node derives a `terminalState` (`satisfied | max_iterations_reached`) via jq.

**Verified on ryzen (run `yxoTtvyc`, the SAME hidden round-half-to-odd task the critic hallucinated on in Phase 1):**
- `gate[0]: OBJECTIVE FAIL (10): 1.5->2 (expected 1), 3.5->4 (expected 3) ...` — generator attempt 0 was round-half-to-**even**; the deterministic gate caught it.
- `gate[1]: OBJECTIVE PASS` — generator attempt 1 inferred round-half-to-**odd** from the gate's failing cases and fixed it.
- Final: `terminalState: satisfied`, `objectivePass: true`, `criticPass: true`, `iterations: 2`, `exec success`.

This proves the anti-hallucination guarantee: **objective correctness is decided by running the checks, not by LLM judgment**; the critic covers only subjective criteria.

**Other Phase-3 items (per the scout's template-level vs deploy split):**
- **Terminal states** — derived in `summary` via jq (TEMPLATE-LEVEL). Done.
- **Non-JSON critic verdict** — already fail-safe: `_apply_parse_json_affordance` leaves output untouched on parse failure → `meets_criteria` absent → not accepted → loop continues (never a silent pass). No change needed.
- **Critic-as-agent (Tier 2)** — already works: per-node `agentConfig.mcpServers` + `modelSpec` flow through the bridge for a loop sub-task (the critic is already a `durable/run` node). A vision critic = flip `modelSpec` → `anthropic/claude-*` + add Playwright MCP (Phase 2.5; Anthropic-only).
- **Generator `update_goal` lockout** — the structural lockout (no `goalSpec` ⇒ no goal MCP wired) already holds. An explicit `disableGoalMcp` flag (`mcp-wiring.ts` + 2 call sites) is **optional hardening requiring a BFF deploy**, deferred unless a runtime-agnostic enforcement is needed; a dapr-agent-py `PreToolUse` deny hook is a template-level alternative if `DAPR_AGENT_PY_HOOKS_ENABLED=true`.

**Net:** Phase 3's correctness goal is delivered + verified, entirely template-level. The remaining items are optional hardening (BFF `disableGoalMcp`) and Phase-2.5 vision.

---

## 11. Phase 4 — productization (2026-06-18)

- **Seed persistence:** the three verified showcases are committed as fixtures (`scripts/fixtures/generator-critic/{evaluator-optimizer,design-critic,evaluator-gated}-showcase.json`) and registered by `seedGeneratorCriticShowcases()` in `scripts/seed-workflows.ts` (linear canvas graph via `buildGeneratorCriticGraph`; the for-loop sub-tasks render as one `refine` node and the canvas adapter re-expands them on edit). This makes them durable across DB reseeds and deploys to every cluster — previously they lived only in the ryzen DB. They default `agentRef.slug` to the seed's `general-assistant` (override via the `agentSlug` trigger input).
- **Docs:** this doc (§1–§11) is the SSOT for the feature, linked from CLAUDE.md; `goal-loop-evaluator-design.md` is updated to point here for the shipped implementation.

**Deferred (clean follow-ups, none blocking):**
- **Canvas authoring UI** for rubric/critic config + loop authoring — the showcases are canvas-*viewable* (linear graph; adapter re-expands the loop), but bespoke config panels are a separate UX effort.
- **`disableGoalMcp` BFF flag** — explicit runtime-agnostic lockout (`mcp-wiring.ts` + 2 call sites); the structural no-`goalSpec` lockout already covers these templates, so it's optional hardening requiring a BFF deploy.
- **Phase 2.5 vision critic** — flip the critic `modelSpec` → `anthropic/claude-*` + add Playwright MCP (Anthropic-only; quota-gated) + the `browser/validate` screenshot artifact (needs the Knative `openshell-agent-runtime` kept warm or a higher function-router timeout).

**Branch:** `feat/evaluator-optimizer-generator-critic` (Phases 1–4). Templates verified on ryzen; merge opens them to the standard seed on all clusters.

---

## 12. RetroForge demo — planner + evaluator + critic (2026-06-18)

`retroforge-showcase` reproduces a scoped slice of Anthropic's **RetroForge** (*Harness design for long-running agentic apps*) to demonstrate all the roles working together. The article's full build was ~6h/$200, so the demo builds **one representative slice — the pixel-art Sprite Editor** — as a single-file vanilla web app.

**Pipeline:** `workspace_profile → plan (Planner agent) → approve_goal_spec (HITL gate) → for[while !(gate∧critic)]{ generate (Generator agent) → gate (deterministic evaluator) → evaluate (Critic agent) } → summary`.

**Role → tier mapping (the article ↔ our stack):**
- **Planner agent** — expands the one-line app idea into a high-level product spec (objective + user stories + acceptance criteria + the **four design dimensions** with the article's verbatim definitions) and **writes it to `/sandbox/SPEC.md`**; the generator and critic read that file. We use a planner *agent* (not the `goal/plan` node, which is unreachable on ryzen) and a **file-based handoff** — the article's actual "agents communicate through files" pattern. (An earlier JSON-via-`parseJson` handoff was abandoned: a strong model authors its own nested schema, so flat `.plan.objective`/`.plan.rubric` cross-refs didn't resolve and the spec didn't drive the build. A shared `SPEC.md` is schema-agnostic and robust.)
- **Generator agent** — reads `/sandbox/SPEC.md`, builds/refines `/sandbox/{index.html,style.css,app.js}`; no `goalSpec` → no `update_goal`.
- **Evaluator = deterministic `workspace/command` gate** — objective ground-truth (required structure present: canvas/palette/tools/export + `getContext`/handlers, plus a JS parse check) → `OBJECTIVE PASS/FAIL`. This is the anti-hallucination backbone (our LLM critic hallucinated a pass in §8/§10); it's the deterministic equivalent of the article's Playwright QA for what a command can verify.
- **Critic agent** — reads `/sandbox/SPEC.md` and grades the four design dimensions (retro-aesthetic calibration, default-reject), STRICT-JSON verdict via `parseJson`.

Acceptance requires **gate-pass AND critic-pass** (explicit `while`-guard AND); the generator receives both the gate's objective failures and the critic's design feedback each turn.

**Capturing the built UI as an artifact.** A `capture` node (`workspace/command`) runs after the loop: it inlines `style.css` + `app.js` into `index.html` → `/sandbox/standalone.html` and `cat`s it, then persists it via an `artifacts:` block in two forms — a primary **`html`** artifact (rendered live on the run-detail page in a **sandboxed iframe**, `sandbox="allow-scripts"` only → isolated from the app origin) and a secondary **`text`** artifact (the self-contained source to copy/save). This is the durable answer to "view the output UI": the build is persisted to `workflow_artifacts` and survives the ephemeral workspace's teardown, instead of living only in the sandbox `/sandbox` (which self-reaps on run end). The **`html` artifact kind** is a general platform capability (`artifact-renderer.svelte`), reusable by any workflow that produces self-contained HTML.

**Deliberate divergences from the article (for a reliable ~20–40 min runnable demo):** vanilla single-file app instead of React+Vite (no build step / dev server); a *deterministic structural* gate instead of a *Playwright-functional* QA agent (the latter needs the Knative `openshell-agent-runtime` kept warm + a vision model — Phase 2.5); single-pass loop instead of per-sprint contracts + context resets (article V1). The three "separate agents" share the per-session `evaluator-critic-agent` base with distinct per-node `agentConfig.instructions` (Planner/Generator/Critic personas, distinct sessions).
