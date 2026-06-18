# Goal-Loop Methodology: Evaluator-Gated Completion (design)

> Proposal to fix the weakest link in our goal system — **self-judged completion** — by introducing an independent, adversarial **evaluator** that gates "done." Grounded in Anthropic's [harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps), the Dapr-agents [Evaluator-Optimizer + Orchestrator-Workers patterns](https://v1-18.docs.dapr.io/developing-ai/dapr-agents/dapr-agents-patterns/), and what we observed building `sveltekit-game-goal-showcase`. Pairs with [[agent-node-and-workflow-sandbox-architecture]].

## The problem: self-judged completion is unreliable

Today, a goal is "complete" when the **doer agent says so** — native CLIs via `/goal` / `codex_update_goal`, custom-loop runtimes via the goal-MCP `update_goal(complete)`. The doer is judge of its own work. Our 4-runtime run proved how badly this fails:

- **codex-cli** called `update_goal(complete)` having built a *client-only SPA that never renders* — it did **not** meet the explicit "prerender the hooks" criterion, but self-declared done (3×).
- **agy-cli** marked the goal complete at **iteration 1**, before anything playable existed.

Anthropic names this exactly: *"agents tend to respond by confidently praising the work—even when, to a human observer, the quality is obviously mediocre"* when self-evaluating. The fix both sources converge on: **separate the doer from the evaluator.**

## The two reference patterns

**Anthropic — adversarial / GAN-inspired harness.** Three roles: **Planner** (specifies a "sprint contract" of explicit, testable criteria upfront), **Generator** (does the work), **Evaluator** (independently grades against the criteria via *active testing* — "click[s] through the running application the way a user would, testing UI features, API endpoints, and database states"). The evaluator "caught critical gaps the generator missed, such as non-functional game mechanics or stubbed-out features presented as complete." Work fails if any criterion is below threshold → revision loop with detailed feedback.

**Dapr-agents — Evaluator-Optimizer.** Dual-LLM loop: generator produces → evaluator scores against criteria + returns `feedback[]` + a `meets_criteria` boolean → generator refines on the feedback → repeat `while iteration <= max_iterations and not meets_criteria`. Backed by `DurableAgent` (Dapr workflows, durable activities, survives restarts). The **Orchestrator-Workers** pattern adds a coordinator `DurableAgent` that decomposes a task, delegates to workers, and synthesizes.

**The mapping is almost 1:1 with what we already have** — our goal-loop *is* the optimizer loop (idle → inject continuation), and `browser/validate` *is* the active-testing evaluator (Playwright clicking start/rotate/move/drop). The defect is **ordering + authority**: validation runs as a workflow step *after* the agent already self-declared done, instead of being the *gate* on completion.

## Proposed structure: evaluator-gated completion

Make `update_goal(complete)` / native goal-complete a **request for evaluation**, not the completion itself. An independent evaluator holds completion authority.

```
 generator (doer agent)  ──idle / "I think I'm done"──▶  EVALUATOR (critic)
        ▲                                                    │
        │  inject feedback[] as next continuation            │ judges criteria vs EVIDENCE
        └──────────────  not met  ◀──────────────────────────┤  (transcript + workspace state
                                                              │   + active tests)
                              met  ─────────────▶  terminate (truly complete)
        guardrails: maxIterations / tokenBudget cap the loop
```

Three concrete pieces:

1. **Structured acceptance criteria (the "sprint contract").** Extend `goalSpec` from prose into testable checks:
   ```
   goalSpec: {
     objective: "...",
     acceptanceCriteria: [ "npm run build emits build/index.html",
                           "grep data-test build/index.html shows game-root,start,board,...",
                           "clicking start renders the board; score increments on drop" ],
     evidence: { commands?: ["npm run build", "grep ..."], browser?: <validate steps> },
     maxIterations, tokenBudget
   }
   ```
   The criteria we hand-wrote into the game objective (prerender, playable) become first-class, machine-checkable items.

2. **An independent evaluator** that runs when the doer claims done (and/or each idle). It judges each criterion against **evidence**, returning `{ met: bool, perCriterion: [...], feedback: [...] }`:
   - **Cheap evidence first** — run the declared `evidence.commands` (build, grep, type-check) in the retained workspace; deterministic, no LLM needed for these.
   - **Active testing** — reuse `browser/validate` as the evaluator's UI probe (it already exists), promoted from a post-hoc step to a completion gate.
   - **LLM critic** — a single, cheap LLM call whose *sole role is to be skeptical*: given the criteria + the evidence (command output, screenshots, transcript), does this genuinely meet the bar? Prompt it to **default to "not met"** unless the evidence is conclusive (the Anthropic anti-sycophancy framing).

3. **The optimizer loop.** If `met=false`, inject the evaluator's `feedback[]` as the next continuation (`"Your completion was rejected. Failures: …. Fix and continue."`) — this is exactly today's continuation mechanism, just fed by the critic instead of a generic "keep going." If `met=true`, terminate. Existing `maxIterations`/`tokenBudget` guardrails prevent endless reject loops.

## Where it runs — and why this is runtime-agnostic (the key win)

Put the evaluator in the **BFF goal-loop driver**, not in any one runtime. Then it covers **all four runtimes uniformly** (codex/claude/agy/dapr) — codex's false "done" gets rejected with "game-root not in static HTML"; agy's iteration-1 "done" gets rejected with "not playable."

This also **simplifies** the per-runtime leak identified in [[agent-node-and-workflow-sandbox-architecture]]: instead of trusting each runtime's heterogeneous self-judged completion signal (event vs MCP-DB-write), **completion authority becomes a single BFF verdict**. The `goalLifecycle` adapter's `completionSignal` collapses to "doer *requests* eval; BFF evaluator decides" — one path for everyone. And the **sandbox standardization** (shared retained workspace) is what gives the evaluator a place to run its active tests — the two proposals are prerequisites for this one.

| Option | Covers | Notes |
|---|---|---|
| **BFF-orchestrated evaluator (recommended)** | codex + claude + agy + dapr | One impl; reuses goal-loop + browser/validate; unifies completion authority |
| Dapr-agents native Evaluator-Optimizer / Orchestrator (`DurableAgent`) | dapr-agent-py only | More integrated *for dapr* (generator+evaluator as DurableAgents); doesn't help CLI — layer it *under* the BFF evaluator later, not instead |
| Per-workflow evaluator node (a `durable/run` critic agent) | any | Heavier; good when the evaluator itself needs full agent tooling/MCP |

**Recommendation:** build the **BFF-orchestrated evaluator** as the primary, runtime-agnostic mechanism. Use the Dapr-agents native pattern only as an optional dapr-specific optimization once the contract is proven — the doer agent on dapr could be wrapped as a `DurableAgent` orchestrating a generator+evaluator pair, but the BFF evaluator already delivers the value across every runtime.

## Independent evaluation: isolated LLM call vs separate agent (decision)

> Status (2026-06-18): Phase 1 (deterministic evidence) **shipped**. The LLM-judgment tier below is the open question — "does our architecture give us *independent* evaluation, or do we need a separate agent / separate LLM call with isolated context?"

**What we already have is independent — in the strongest form, for what it covers.** The deterministic evaluator (`evaluateGoalCompletion`) runs **in the BFF, out of band** from the doer, holds completion authority, and judges **ground-truth workspace output** (files / exit codes) — **not the doer's transcript or self-claims**, and it shares **zero context** with the doer. That is *more* independent than an LLM judge that reads the agent's transcript, and stronger than Claude's native `/goal` (transcript-judged). The architecture's shape — independent, output-grounded, authority-holding, isolated — is already correct. The **gap is coverage, not independence**: it's deterministic-only, so subjective / open-ended criteria currently have *no* independent evaluation (they fall back to self-judged when no `evidence.commands` are declared).

**For the LLM-judgment tier, the load-bearing property is ISOLATED CONTEXT + an adversarial stance — not "agent vs not-agent".** A same-context self-evaluation is just self-judging (the failure mode we're fixing); an LLM that reads the doer's chain-of-thought tends to rubber-stamp it (sycophancy).

| Option | When it fits | Trade-offs |
|---|---|---|
| **Isolated LLM call** (stateless judge: criteria + produced artifacts + deterministic-evidence output → structured per-criterion verdict) | **Default** — judging the quality of a produced artifact | Cheap, simple, deterministic to orchestrate, no tool/runaway risk; a fresh thread *guarantees* independence |
| **Separate evaluator agent** (own loop + tools/MCP) | Evaluation needs **autonomous investigation** — run tests, click the live app, query DB state | Heavier/slower/costlier; but we already do "active testing" deterministically (`evidence.commands` + `browser/validate`), so the judge can *consume* those outputs instead of re-investigating |
| Same-context / doer self-eval | never | identical to today's self-judged completion |

**Decision:** implement the Phase-3 critic as a **separate LLM call with isolated context**, not a full agent. Non-negotiable rules:
1. **Fresh thread, separate from the doer's** — never share the doer's context window.
2. **Inputs = the goal + acceptance criteria + the produced artifacts/diff + the deterministic-evidence results.** Do **not** feed it the doer's reasoning/transcript (avoids sycophancy).
3. **Adversarial, default-reject prompt** — "find why this *fails* the goal" (Anthropic anti-sycophancy framing).
4. Prefer a **different model** than the doer for judgment diversity.
5. **Gate behind the cheap deterministic checks** (only call the LLM when commands pass) and cap with `tokenBudget`/`maxIterations`.

Reserve a separate evaluator **agent** only for goals that genuinely need autonomous probing (or the optional dapr-native Evaluator-Optimizer in the row above). Either way it stays **BFF-orchestrated** so completion authority remains a single, runtime-agnostic verdict.

## Phasing

1. **Acceptance criteria + deterministic evidence gate.** Add `acceptanceCriteria`/`evidence.commands` to `goalSpec`; on completion-request, run the commands in the retained workspace; reject with the failing command output as feedback. (No LLM; catches codex's "build/index.html missing the hooks" instantly. Cheapest, highest-leverage.) **— SHIPPED** (#190–#209). Note (#209): the rejection feedback shows the failing check's *output only*, not the command text, so the doer can't read/hardcode the checks — this is also what makes isolated judging meaningful.
2. **Promote `browser/validate` to a completion gate** for UI goals (active testing), feeding pass/fail + screenshots into the verdict.
3. **LLM critic** for criteria that aren't mechanically checkable, prompted to default-reject. Single cheap call per evaluation, budgeted.
4. **(Optional, dapr-only)** native Evaluator-Optimizer via `DurableAgent`.

## Risks / guardrails
- **Cost/latency:** an LLM critic per idle is expensive — gate it behind the cheap deterministic evidence (only call the LLM when commands pass), and cap with `tokenBudget`/`maxIterations`.
- **Over-strict evaluator → never completes:** the iteration/budget caps already wrap-up the loop; surface the last evaluator verdict so a human sees *why* it didn't finish.
- **Criteria authoring burden:** default criteria can be inferred from the objective (an LLM "planner" step that drafts the sprint contract from the prose objective — the Anthropic Planner role); the user edits if needed.
- **Determinism:** all evaluator calls are BFF-side side effects (not inside the Dapr workflow body), consistent with how the goal-loop already runs off `appendEvent`.

## Bottom line
We already have the optimizer loop (continuations) and an active-testing evaluator (`browser/validate`); we're just trusting the doer to grade itself. Flipping completion authority to an **independent, skeptical evaluator gated on explicit criteria + real evidence** is a small, runtime-agnostic change that directly fixes the false-completion failures we saw, and it *simplifies* the per-runtime completion contract rather than adding to it.
