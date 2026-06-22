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

## Structured-output conformance (why `read_contract`/`read_verdict` normalize)

A CLI agent free-writes `contract.json`/`verdict.json` to disk — it can NOT use the
Anthropic API's enforced **structured outputs** or the Agent SDK's schema-validation
loop (those aren't exposed to the Claude Code CLI), and even structured outputs
don't enforce **cardinality** (e.g. "≤12 criteria"). In practice the Evaluator
honors the *spirit* (skeptical, testable criteria, `passes` flags, an `agreed`
gate) but drifts on the *exact schema* — e.g. it emitted `{id, feature, text,
verify, accepted, passes}` instead of `{id, dimension, description, verify,
passes}`, and produced far more criteria than asked.

Per Anthropic's guidance ("don't fight the model with prose; use validation
loops") and the `coleam00/adversarial-dev` reference (file-based JSON contracts;
"models are less likely to tamper with structured JSON than prose"), the fix is a
**deterministic normalizer + validator**, not stricter prompting:
- **`read_contract`** is schema-tolerant: it maps the agent's field names
  (`feature`/`text` → `dimension`/`description`, etc.) to the canonical shape,
  back-fills `dimension` heuristically, **writes the canonical contract back** so
  the build-loop critic reads clean data, and **gates `agreed` on validity**
  (≥3 criteria, each with a description) — a bogus `agreed:true` over garbage is
  overridden, which keeps the negotiation loop going. The negotiate loop is itself
  the recommended validation-feedback loop (`propose → review → read_contract`).
- **`read_verdict`** likewise normalizes per-criterion results → `meets_criteria`.

The Evaluator's prose is kept light (focused/perceptual guidance, a convergence
nudge) and relies on the normalizer rather than brittle caps/bans.

## Reliability notes (carried from `coding-redesign-cli-showcase`)

- Agent-written JSON (`contract.json`, `verdict.json`) is **normalized by
  deterministic steps** that read from disk and emit tiny JSON (avoids the CLI
  workspace 8 KiB stdout truncation); parse failure → not-agreed / not-pass,
  bounded by the loop caps.
- The deterministic `gate` restores `package-lock.json` after `npm install`; the
  evaluator is told to IGNORE build-artifact churn.
- The screenshot artifact uploads via the `cli-workspace-command` image-readFile →
  files API path (renders inline; see `docs/coding-redesign-playwright-critic.md`).

## Parameterized build/verify convention (reusable across coding workflows)

The build is **not hardcoded to npm**. This harness exposes three optional trigger
inputs so the same DAG drives any framework (Vite/SvelteKit/Next/Cargo/Make/…),
and any other coding workflow should adopt the same convention:

| Trigger input | Default | Meaning |
| --- | --- | --- |
| `installCommand` | `"auto"` | Dependency install. `auto` → detect (pnpm-lock→`pnpm install --frozen-lockfile`, package.json→`npm install`, Cargo.toml→`cargo fetch`, requirements.txt→`pip install -r`). |
| `buildCommand` | `"auto"` | Build the deterministic `gate` runs. `auto` → detect (pnpm→`pnpm build`, package.json→`npm run build`, Cargo.toml→`cargo build --release`, Makefile `build:`→`make build`). |
| `previewCommand` | `"auto"` | Preview/serve the Playwright critic views. `auto` → `npm run preview` (else `true`). |

Conventions (so other workflows stay uniform):

- **Defaults are the literal string `"auto"`, never empty.** `collectRequiredTriggerFields`
  (`src/lib/utils/trigger-fields.ts`) treats every `.trigger.X` referenced in the
  spec as required and `hasPresentValue` rejects empty/whitespace — but
  `applyWorkflowInputDefaults` runs **before** the required-field check in
  `execute/+server.ts`, so a non-empty default (`"auto"`) satisfies it. An empty
  default would 400 with "Missing required workflow input fields".
- **Auto-detection is shell-side, not jq-side** (jq can't `stat` files in the
  sandbox). Each `workspace/command` node carries a shared prelude that resolves
  `WFB_INSTALL`/`WFB_BUILD`/`WFB_PREVIEW`: an override wins, else (`-z` **or**
  `= auto`) it auto-detects by lockfile/manifest presence in `/sandbox/work/repo`.
- **Overrides reach the shell via jq `@sh`**, per the full-string jq rule
  (`is_expression_string`): the command value is one `${ ... }` that concatenates
  `export WFB_BUILD_OVERRIDE=<(.trigger.buildCommand // "") | @sh>; … ; <prelude+body>`.
  `@sh` safely quotes arbitrary user command strings.
- **Build runs in a `workspace/command` node, NOT a hook.** Hooks are runtime-uneven
  — only `dapr-agent-py` executes `agentConfig.hooks`; the CLI runtimes (claude/
  codex/agy) use a separate native HTTP hook system and the `Stop` hook is
  advisory-only. A node is uniform across all four runtimes, and the refine loop's
  `while`/`if` already gates on the node's `OBJECTIVE PASS`/`OBJECTIVE FAIL` stdout.
- **Deps are pre-installed once in `init_state`** (so the generator can run the
  build itself to self-verify each turn instead of building blind); the `gate` then
  runs **build-only** (install only if `node_modules` is missing). This is the
  cross-runtime substitute for an "in-turn build hook".

Precedent: `scripts/fixtures/async-coding-task.workflow.json` already parameterizes
its verify command via a trigger input + `[ -f package.json ]` detection — it can
be migrated to these exact param names.

## Deferred (additive on this same structure)

- **Two-pass design process**: Generator emits a `design-tokens.json` (4–6 named
  hex values, display/body typefaces) + ASCII wireframe BEFORE writing CSS; the
  Evaluator reviews the design plan first and rejects generic "AI slop" defaults.
- **Evaluator restart authority**: the critic can force the Generator to discard
  fundamentally broken work (`git reset --hard <baseline>`) and restart.
- **Multi-sprint contracts** (per `coleam00/adversarial-dev`): decompose into
  several sprints, each with its own negotiated contract + build + score, instead
  of one contract for the whole redesign.
- **Parallel voting critics**: spawn 2–3 independent Evaluators (different lenses)
  and converge by majority / "any-FAIL" to counter evaluator sycophancy (the
  dynamic-workflows "agents cross-check each other" pattern).

## References

- `GANs.md` — Anthropic long-running-agent analysis (Planner/Generator/Evaluator,
  negotiate-the-contract, skeptical interactive Evaluator, JSON-over-Markdown).
- Anthropic *Building Effective Agents* + *Claude Code best practices* — evaluator-
  optimizer pattern, "don't fight the model with prose; use validation loops."
- Anthropic **structured outputs** + **strict tool use** — enforce shape, not
  cardinality; not exposed to the Claude Code CLI (hence the deterministic
  normalizer here).
- `coleam00/adversarial-dev` — three-agent (Planner/Generator/Evaluator) reference
  harness with file-based JSON contracts + machine-readable verdicts; closely
  mirrors this workflow.
- Claude Code **dynamic workflows** — orchestration-as-code over many subagents;
  our SW 1.0 workflow DAG is the analogous explicit orchestrator (vs. an in-session
  agent deciding next).

## V1 vs V2

This keeps our per-iteration `durable/run` model (V1-style separate contexts per
turn), which is what works on our runtime, combined with filesystem-anchored state
+ the agentic-memory log to combat context amnesia. The doc's V2 simplification
("single cohesive Generator session with server-side compaction") maps to our
goal-loop multi-turn session mode and is a separate, larger architectural option.
