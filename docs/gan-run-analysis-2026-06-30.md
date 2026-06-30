# Preview-GAN Workflow — Evidence-First Run Analysis & Improvement Plan (2026-06-30)

Trace-read post-mortem of the three concurrent `preview-gan-redesign` runs (codex / agy / claude),
each isolated in its own CNPG Tier-2 preview, graded against Anthropic's GAN harness ideal
(`GANs.md`: Planner / Generator / skeptical-interactive Evaluator + contract negotiation + 4-criterion
frontend rubric + two-pass design) and the agentic-engineering principles in `Day_1_v3.md`
(context engineering, verification-at-every-stage, guardrails/hooks).

Evidence = `workflow_executions` + `sessions` + `session_events` (per-node agent messages, tool_use,
llm_usage) + the parsed critique verdicts, per run. Raw dumps: `/tmp/run-{codex,agy,claude}.txt`.

## 0. Outcome table

| run | exec | wall | iters | scores (crit0..N) | result | PR | tokens (out / cache) |
|---|---|---|---|---|---|---|---|
| **codex** | JfDTu2ge… | **58 min** | 2 | 72 → **88✓** | clean early-exit | #374 | out 44k / cc 6M |
| **agy** | 4qO2159P… | 61 min | 3 | 0 → 85 → **98✓** | clean early-exit | #375 | uninstrumented |
| **claude** | JS7Bxyag… | **163 min** | 5 | 4 → 88✓ → 4 → 91✓ → 88✓ | **ran to for-cap** | #376 | out **625k** / cc 48M |

Quality (critic score): **agy 98 > claude 91 > codex 88**. Efficiency: **codex ≫ agy ≫ claude**.
Best redesign came from agy; cheapest/cleanest run from codex; claude was 2.8× slower and ~14× the
output tokens of codex for a middle score.

## 1. What worked (keep / reinforce)

- **The GAN scaffold itself works.** All three: Planner wrote `/sandbox/work/contract.json` and
  **wrote no app code** (codex plan msg: *"I only read the exported dashboard/API context and did not
  modify app source"*) — the GANs.md anti-overspecification Planner role held. The `design_review`
  second pass produced a real rubric/token review (codex: *"Verdict: pass, with cautions around
  accessible state encoding, contrast, reduced-motion…"*). All three reached a passing, clean-diff PR.
- **The skeptical, INTERACTIVE critic is the MVP.** Every critique booted the live page via Playwright
  MCP and *interacted* (resize to 390px, fill_form login, click/expand, `browser_evaluate`,
  `browser_console_messages`, `browser_network_requests`) — exactly the GANs.md "no static diffs"
  mandate. It caught real, high-value defects static review never would:
  - codex crit0 (score 72): *"Mobile fails… the 224px sidebar stays visible in a 390px viewport"* +
    *"system health… says Healthy with no capacity blockers while Capacity… is Unavailable / fetch failed"*.
  - agy crit0 (score 0): *"completely broken… 'ReferenceError: Badge is not defined' at +page.svelte:705:9"*.
  - claude crit0/crit2 (score 4): *"/dashboard returns HTTP 500… the route's +page.server.ts load is throwing unhandled"*.
  Feedback was specific and actionable every time; generators that received it fixed exactly those points.
- **Per-CLI role personas + the contract** kept roles separated and graded against consistent criteria
  (the 6 `sections` map to the contract's 5 resources + visual-excellence). The 4-criterion rubric
  intent ("focused, unified, real data, visually stunning, AA contrast, keyboard focus") came through
  in the feedback.
- **CNPG-isolated previews + HTTPS dev-pod exposure** let all three run concurrently with zero
  cross-talk and be reviewed live. No infra contention during the runs.

## 2. What did NOT work (the costly failures)

### 2.1 Loop-exit is fragile — it depends on the model emitting *pure* JSON (ROOT CAUSE of claude's 2.7h)
The refine loop exits via `while: .loop.accepted != true`; the orchestrator sets `accepted=true` only
when the critique's output parses (via `_loose_extract_json`, `sw_workflow.py:688-709`) to a dict with
`meets_criteria===true` (`sw_workflow.py:3188`). The critique prompt says **"Return ONLY this strict JSON."**
- **codex & agy obeyed** → pure JSON (`startsWithBrace=true`, ~750 chars) → parsed by candidate-0 →
  exited on first pass. ✓
- **claude disobeyed** → ~2700 chars of prose ("I now have comprehensive evidence… Summary of
  findings…") then the verdict in a ``` fence at the very end (`startsWithBrace=false, hasFence=true,
  LEN=3106`). The orchestrator failed to surface `meets_criteria` for crit1/crit3/crit4 (all
  `meets=true`) → **`accepted` never tripped → the loop ran the full `for:[0..4]` (5 iterations,
  2.7 h)** instead of stopping at crit1 (88) after ~60 min.
  (A standalone regex repro extracts claude's fenced JSON fine, so it is recoverable — but the live
  path did not, plausibly because the verdict sits after a long preamble / arrives as content-blocks.)
**Impact:** ~2× wasted wall-clock and ~14× output tokens vs codex, for no quality gain. This is the
single highest-value fix.

### 2.2 Generators ship build-breaking code; a whole critique iteration is spent discovering it
- agy generate-0 → `ReferenceError: Badge is not defined` (missing import) → critic score 0.
- claude generate-0 AND generate-2 → unguarded `/api/v1` fetch in `+page.server.ts` → SSR **HTTP 500**
  → critic score 4 **twice** (generate-2 was a **regression** — it re-broke what generate-1 fixed).
- codex never broke the build — its `+page.server.ts` used a defensive `readSource()` try/catch wrapper
  per source from the start.
The critic *does* catch these (good), but each costs a full generate+critique round-trip (~15-25 min).
The generators' own "verification" was a **parse/type check only** (codex: *"Svelte 5 compiler parse
check passed. TypeScript parse check passed"*) — which does NOT catch runtime 500s or template
ReferenceErrors. No one boots the page before the critic does.

### 2.3 Model-quality variance dominates outcomes
- **codex**: defensive, JSON-compliant, terse, never broke the build, but lowest score (88) — touched
  extra files (sidebar, workflow-canvas).
- **agy**: best design (98) but left **debug cruft in the PR** (`src/routes/api/v1/debug-db/+server.ts`)
  and broke the build once. Token usage **uninstrumented** (emits ~0).
- **claude**: most focused diff (2 files) and strong design (91), but ignored "JSON-only", broke the
  build twice (incl. a regression), and was by far the most expensive.

### 2.4 Observability gaps
- **Previews disable tracing** (`runner.sh` sets `MLFLOW_ENABLED=false`, `OTEL_SDK_DISABLED=true`), so
  there are **no MLflow/OTEL traces** for these runs — `session_events` is the only trace. Post-mortem
  analysis worked but was manual.
- **agy (agy-cli) emits no real token usage** — cost is invisible for that runtime.

## 3. Comparison to the GANs.md ideal

| GAN ideal | Our implementation | Gap |
|---|---|---|
| Planner: high-level, no code | ✅ contract.json only, no app edits | none |
| Generator↔Evaluator **contract negotiation** (back-and-forth before building) | ⚠️ one-way: planner writes contract, generator consumes; design_review is a 2nd pass but not a generator↔critic negotiation | no negotiation loop on the contract itself |
| Two-pass design (token system + ASCII wireframe BEFORE CSS, critic reviews the plan) | ⚠️ design_review exists but reviews the contract, not a generator-produced token/wireframe plan | generator doesn't emit a reviewable design plan pre-build |
| Skeptical **interactive** evaluator | ✅ excellent (Playwright boot + interact + console/network) | none — this is our strength |
| Codified 4-criterion rubric (Design/Originality/Craft/Functionality) | ⚠️ our 6 `sections` cover functionality + "visualExcellence" but don't explicitly score **Originality** (anti-AI-slop) or **Craft** as separate gates | rubric less granular than GANs.md |
| Compilation backpressure / smoke test before QA | ❌ none — parse-check only; the critic is the first boot | add a build/smoke gate (§4) |
| Verdict via durable structured signal | ❌ free-text JSON parsed from prose | brittle (§2.1) |

## 4. Ranked improvements (evidence-cited)

**P0 — Make loop-exit deterministic (fixes §2.1; saves ~2× time/cost on prose-heavy models).**
- Replace prose-JSON parsing with a **structured verdict the critic MUST emit as a tool call** — a
  dedicated `submit_verdict(meets_criteria, score, sections, feedback)` MCP tool (mirror the goal MCP
  `update_goal` pattern already auto-wired), so acceptance is a typed event, not a regex on free text.
- Belt-and-suspenders until then: harden `_loose_extract_json` to take the **LAST** balanced JSON
  object (not greedy first-`{`-to-last-`}`) and to handle content-blocks; and add to the critic
  persona an explicit "your FINAL message must be the JSON and nothing else — no preamble, no fences."
  Evidence: codex/agy (pure JSON) exited; claude (prose+fence) did not.

**P0 — Add a deterministic build/smoke gate between `generate` and `critique` (fixes §2.2).**
- After each `generate`, before `critique`, run a cheap check: boot the dev pod route and assert HTTP
  200 + no console error (the dev pod is already live; a 1-call `curl`/headless check suffices). On
  failure, loop straight back to `generate` with the error — do **not** spend a Playwright critique to
  learn "it's 500". This is GANs.md "compilation backpressure"/"smoke test". Evidence: 3 of the wasted
  iterations (agy crit0, claude crit0 & crit2) were pure build-break discovery.

**P1 — Strengthen the generator persona/contract to prevent the recurring break classes (§2.2/2.3).**
- Hard rule in the generator persona + contract: *"Every server `load`/`+page.server.ts` data fetch
  MUST be individually guarded (try/catch or `Promise.allSettled`) and degrade to an empty state;
  a single failing `/api/*` source must never 500 the page. Import every component you reference."*
  Evidence: claude's two 500s and agy's missing-import were exactly these; codex avoided both via
  `readSource()`.
- Add "leave NO debug/scratch routes or files in the final diff" (agy shipped `debug-db/+server.ts`).

**P1 — Tighten loop economics independent of the exit bug.**
- Add an objective **no-progress / regression stop**: if score does not improve for K iterations, or a
  passing iteration is followed by a build-break regression (claude: 88 → 4), stop and promote-best.
- Consider lowering `for:[0..4]` to `[0..3]` once the smoke gate + structured verdict land (most value
  was captured by iteration 2).

**P2 — Close the rubric gap toward GANs.md.**
- Split the critic rubric to score **Originality (anti-AI-slop)** and **Craft (spacing/contrast/focus)**
  as explicit sections, and add the GANs.md **two-pass design**: have the generator emit a compact
  token system + ASCII wireframe artifact that `design_review` critiques **before** any CSS — catching
  generic/"AI-slop" direction before build cost.

**P2 — Observability.**
- Re-enable lightweight tracing for previews (or persist a structured per-iteration trace artifact) so
  post-mortems aren't manual `session_events` archaeology.
- Instrument agy-cli token usage (currently ~0) so cost is comparable across runtimes.

**P3 — Per-phase model routing.** Evidence supports mixing: use a terse, JSON-compliant, defensive
model (codex-class) for `generate` + the verdict-emitting `critique`, and a strong-design model for the
design direction. The current free choice produced a 2.8×/14× cost spread for ≤10-point score deltas.

## 5b. Implemented in this pass (safe, re-seed on next run, no live impact)
- **Critic persona + critique prompt → hard JSON-only output contract** (`scripts/seed-workflows.ts`
  `GAN_CRITIC_PERSONA`; `scripts/fixtures/generator-critic/preview-gan-redesign.json` critique prompt):
  the FINAL message must be EXACTLY the JSON (start `{`, end `}`, no preamble, no ``` fence, reasoning
  inside `feedback`). Directly targets claude's loop-exit failure by forcing the codex/agy pure-JSON
  pattern that parses reliably. (Fixture structure test still 4/4; JSON valid; seed TS compiles.)
- **Generator persona → build-safety hard rules** (`GAN_GENERATOR_PERSONA`): guard every server fetch
  (try/catch / `Promise.allSettled`, degrade to empty state, never 500); import every referenced
  component; a CHEAP pre-STOP smoke check (curl route → HTTP 200, no ReferenceError); don't regress
  prior guards; leave no debug/scratch routes. Targets agy's missing-import and claude's two 500s.

Still TODO (need a validation GAN run, hence not done blindly): structured-verdict MCP tool +
orchestrator content-path/parser hardening (robust §2.1 fix); deterministic build/smoke **gate node**
between generate↔critique (§4 P0); no-progress/regression early-stop; rubric split + two-pass design
(§4 P2); preview tracing + agy token instrumentation (§2.4).

## 5. Net
The harness is sound and the interactive critic is genuinely excellent. The losses are all in
**determinism around the edges**: a prose-tolerant exit check (cost claude ~100 extra minutes) and the
absence of a cheap build gate (cost ~3 wasted Playwright critiques across the cohort). Fixing those two
(P0) plus the generator guard-rails (P1) would have turned claude's 2.7 h / 625k-token run into a
~3-iteration ~70-minute run at similar quality, and removed every build-break iteration cohort-wide.
