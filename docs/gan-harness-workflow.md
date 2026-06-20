# GAN-style long-running harness workflow

`gan-harness-cli-showcase` is a coding generator/critic workflow whose structure
maps 1:1 to the GAN-inspired, multi-agent harness in Anthropic's long-running-agent
research (see `GANs.md` — "Architecting Autonomous Agent Systems for Extended
Execution"). It extends the proven `coding-redesign-cli-showcase` (Planner →
Generator → Playwright-MCP critic → PR) with the doc's **central innovations** that
the redesign workflow lacked.

- **Fixture**: `scripts/fixtures/generator-critic/gan-harness-cli-showcase.json`
- **Demo**: clone `PittampalliOrg/sveltekit-landing-demo`, redesign its landing
  page, open a PR — same demo as the redesign showcase, so the Playwright visual
  critic + 4-dimension design rubric apply.
- **Runtime**: interactive-cli family (claude-code-cli by default; per-phase
  selectable via `planAgent` / `generatorAgent` / `criticAgent` trigger inputs).
  Reuses the seeded `cli-evaluator-critic-agent` (plan/generator) and
  `cli-playwright-critic-agent` (evaluator). No new agents, no orchestrator/BFF
  code — pure SW 1.0 authoring over existing primitives.

## What it adds over `coding-redesign-cli-showcase`

| GAN doc concept | This workflow |
| --- | --- |
| **Planner abstracts the spec** (avoid the overspecification trap) | `plan` writes a HIGH-LEVEL `SPEC.md` (product context, mood, the 4 design dimensions) and is explicitly told NOT to enumerate granular criteria. |
| **Generator↔Evaluator "Negotiation Phase" / sprint contract** | `negotiate` loop: the Generator proposes features + per-feature verification + acceptance criteria (`proposal.md`); the skeptical Evaluator pushes back (`contract-review.md`) and writes the agreed, browser-testable criteria to `contract.json`; repeats until `agreed:true`. |
| **Grade against the negotiated contract, not the vague spec** | The build-loop `evaluate` critic grades the running app against EACH `contract.json` criterion (interactive Playwright QA) and updates its `passes` flag. |
| **Durable JSON state with `passes` flags** (JSON > Markdown) | `contract.json` is JSON; every criterion starts `"passes": false`; the loop exits only when the deterministic build gate passes AND every criterion passes. |
| **Agentic memory / progress log** ("getting up to speed") | `progress.json` is initialized deterministically (`init_state`), read by the Generator at the start of every turn (plus `git log`), and appended to by `read_verdict` after each iteration. |
| **Skeptical, isolated, interactive Evaluator** | The Evaluator runs in its own context, drives Playwright MCP (real Chromium) to navigate/snapshot/screenshot/click, and defaults to reject. |

## Node-by-node (`do`)

1. **`plan`** (`durable/run`, planAgent) — clone repo, write high-level `SPEC.md`.
2. **`init_state`** (`workspace/command` `cliWorkspace:true`) — write
   `progress.json` `{"baseline":<git sha>,"log":[]}` (deterministic, reliable memory).
3. **`approve_goal_spec`** (`listen`) — human sign-off on the SPEC (timeout PT2H).
4. **`negotiate`** (`for [0..3]`, `while` not-`agreed`):
   - `propose` (Generator) → `/sandbox/work/proposal.md`
   - `review` (Evaluator, skeptical) → `contract-review.md` + `contract.json`
     (`{agreed, criteria:[{id,dimension,description,verify,passes:false}]}`)
   - `read_contract` (deterministic) → small `{agreed, criteriaCount}` the loop reads.
5. **`refine`** (`for [0..5]`, `while` NOT (gate `OBJECTIVE PASS` AND all criteria pass)):
   - `generate` (Generator) — getting-up-to-speed (`progress.json` + `git log`),
     then implement toward the FAILING `contract.json` criteria.
   - `gate` (deterministic build) — `npm install` + `npm run build` → `OBJECTIVE PASS/FAIL`.
   - `evaluate` (Evaluator + Playwright) — grade each criterion in the browser;
     write `verdict.json` (`criteria[].passes`, `allPass`, `score`, `meets_criteria`)
     and update `contract.json` passes flags.
   - `read_verdict` (deterministic) — normalize → `{meets_criteria, score, passed,
     total}`; append the iteration to `progress.json.log`.
6. **`publish_shot`** — deterministic `playwright screenshot` → inline image artifact.
7. **`publish_contract`** — read `contract.json` (full, via `readFile`) → JSON artifact
   so the negotiated contract is visible in the run's Outputs tab.
8. **`pr`** — branch, commit, push, open PR via `$GITHUB_TOKEN`.
9. **`summary`** — `terminalState` (`satisfied` / `max_iterations_reached`),
   `criteriaPassed`/`criteriaTotal`, `negotiationRounds`, `iterations`, PR output.

## Durable state (filesystem, not context — shared `/sandbox/work` JuiceFS)

`SPEC.md` (planner) · `proposal.md` (generator) · `contract-review.md` (evaluator
pushback) · **`contract.json`** (negotiated criteria + passes — the grading target)
· **`progress.json`** (agentic memory) · `verdict.json` (per-iteration, per-criterion)
· `critic-shot.png` (screenshot artifact).

## Reliability notes (carried from `coding-redesign-cli-showcase`)

- Agent-written JSON (`contract.json`, `verdict.json`) is **normalized by
  deterministic steps** that read from disk and emit tiny JSON (avoids the CLI
  workspace 8 KiB stdout truncation); parse failure → not-agreed / not-pass,
  bounded by the loop caps.
- The deterministic `gate` restores `package-lock.json` after `npm install`; the
  evaluator is told to IGNORE build-artifact churn.
- The screenshot artifact uploads via the `cli-workspace-command` image-readFile →
  files API path (renders inline; see `docs/coding-redesign-playwright-critic.md`).

## Deferred (Full-harness, later — both additive on this same structure)

- **Two-pass design process**: Generator emits a `design-tokens.json` (4–6 named
  hex values, display/body typefaces) + ASCII wireframe BEFORE writing CSS; the
  Evaluator reviews the design plan first and rejects generic "AI slop" defaults.
- **Evaluator restart authority**: the critic can force the Generator to discard
  fundamentally broken work (`git reset --hard <baseline>`) and restart, instead
  of endlessly patching.

## V1 vs V2

This keeps our per-iteration `durable/run` model (V1-style separate contexts per
turn), which is what works on our runtime, combined with filesystem-anchored state
+ the agentic-memory log to combat context amnesia. The doc's V2 simplification
("single cohesive Generator session with server-side compaction") maps to our
goal-loop multi-turn session mode and is a separate, larger architectural option.
