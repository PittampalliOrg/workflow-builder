# Generator + Critic Multi-Agent (Rubric-Gated Goal Loops)

**Status:** Proposal / design. Phase 0 (deterministic evidence) is SHIPPED; this doc designs the generator/critic layering on top.

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
