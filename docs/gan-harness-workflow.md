# GAN-style long-running harness workflow

`gan-harness-cli-showcase` is a coding generator/critic workflow whose structure
maps 1:1 to the GAN-inspired, multi-agent harness in Anthropic's long-running-agent
research (see `GANs.md` — "Architecting Autonomous Agent Systems for Extended
Execution"). It extends the proven `coding-redesign-cli-showcase` (Planner →
Generator → Playwright-MCP critic → PR) with the doc's **central innovations** that
the redesign workflow lacked.

It is now a **general coding harness**: the same Planner→negotiate→refine loop runs
arbitrary coding tasks via an **evaluation profile** (see "Profile-based evaluator"
below). The web-UI redesign is the default `ui-web` preset; all generalization
inputs default to that exact (validated) behavior.

- **Fixture**: `scripts/fixtures/generator-critic/gan-harness-cli-showcase.json`
- **Default demo** (`ui-web`): clone `PittampalliOrg/sveltekit-landing-demo`, redesign
  its landing page, open a PR — the Playwright visual critic + design rubric apply.
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

## Profile-based evaluator (general coding harness)

Grounded in `GANs.md`: the **evaluator role is constant** ("the Planner and Evaluator
roles were retained … to enforce high-level project scope and rigorous, adversarial QA
testing") — always independent, default-skeptical, graded against the **negotiated
contract** (not the vague spec), with hard thresholds + restart authority, and it
**grounds in the running artifact, never static diffs/screenshots.** What varies by use
case are two orthogonal knobs, so the harness exposes them as inputs:

- **Grounding modality** — `GANs.md`: "boots the application, navigates the live DOM …
  *tests API endpoints, and reads database states*." Selected by `evaluationProfile`:
  - `ui-web` (default) — `evaluate_ui` boots a preview server + drives **Playwright MCP**
    (DOM/click/responsive) with the **design rubric** (design_quality/originality/craft).
  - `library` — `evaluate_code` runs the **test suite + typecheck/lint** and exercises the
    **public API** in a scratch script (no browser); dims correctness/tests/code_quality/
    maintainability/performance.
  - `service` — `evaluate_code` **boots the service + curls its endpoints** + integration
    tests; same code dims.
  The two evaluator families are mutually-exclusive sibling nodes gated by task-level `if`
  on `evaluationProfile`; both write the same `verdict-<i>.json`, so `read_verdict`
  aggregates mode-agnostically (skeptical any-fail, vote-gated).
- **Objective vs subjective criteria coexist** — `GANs.md`: "objective functionality is
  easily verifiable via tests" *and* taste is "gradable … armed with a highly opinionated,
  codified rubric." Each negotiated criterion carries `kind: objective|subjective` +
  `verify`. The deterministic **`gate`** is the objective hard threshold (build for
  `ui-web`; **build + tests** for `library`/`service`); the LLM critic grounds subjective
  ones against the profile rubric. `read_contract` normalizes `kind` + picks
  profile-appropriate dimensions (it reads `/sandbox/work/.wfb_profile`, written by
  `init_state`).

**Generalization trigger inputs** (all default to today's `ui-web` behavior, so an
unchanged trigger reproduces the validated run):

| input | default | purpose |
| --- | --- | --- |
| `repoUrl` | `PittampalliOrg/sveltekit-landing-demo` | owner/repo to clone + (optionally) PR |
| `repoRef` | `main` | branch to clone + PR base |
| `evaluationProfile` | `ui-web` | `ui-web` \| `library` \| `service` (modality + rubric) |
| `outputMode` | `pr` | `pr` \| `branch` \| `none` (remote-write policy; `pr` node gated on it) |
| `testCommand` | `auto` | objective verify the gate runs for code profiles (`auto`-detected) |
| `taskScope` | (UI hint) | free-form what/where-to-change for the generator |

The `pr` node is a plain shell reading the repo/base/outputMode/intent dotfiles
`init_state` writes (avoids the "string must be entirely `${…}` to be jq-evaluated" rule
+ nested-quote escaping). `cli-tool` / `data` (DB) profiles and a `dapr-agent-py`
(openshell-backend) variant are deferred.

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

## Runtime / workspace-backend compatibility (CLI-family only)

This workflow is **interactive-cli-family only** (`claude-code-cli`, `codex-cli`,
`agy-cli`). Verified e2e on ryzen for all three: each reaches `success` with per-node
diffs captured at every node (plan → 4-round negotiate → refine generate+evaluate →
publish → summary).

It is **not** runnable on `dapr-agent-py` as authored. The deterministic spine is 7
`workspace/command` nodes with **`cliWorkspace: true`** (`init_state`, `read_contract`,
`gate`, `read_verdict`, `publish_shot`, `publish_contract`, `pr`) — these route to a
cli-agent-py pod and read/write the per-execution **JuiceFS** mount `/sandbox/work`.
`dapr-agent-py` uses the **openshell-shared** workspace backend, so a dapr generator's
files are invisible to those juicefs nodes (the gate/read_contract/read_verdict can't
observe the agent's work) → the loop stalls with sparse diffs. This is the
`workspaceBackend` family split described in
[`interchangeable-agents-and-per-phase-selection.md`](./interchangeable-agents-and-per-phase-selection.md):
cross-family mixing is blocked by the interactive-cli-only `/sandbox/work` mount.

A `dapr-agent-py` variant would require re-authoring the 7 `cliWorkspace` nodes to the
openshell backend (`workspace/*` on `openshell-agent-runtime`, no `cliWorkspace`) — a
separate fixture, out of scope here. (Timeouts are not the blocker; the
[parameterized build/verify](#parameterized-buildverify-convention-reusable-across-coding-workflows)
+ end-to-end `timeoutMs` threading fixed the CLI build path.)

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

## Refine-loop reliability (PR #262)

A deep review of 5 dev runs (2 converged: codex 41-criteria, agy distinctive design;
3 errored in `refine`) showed the failures were **reliability, not logic** — three
mechanical causes, all fixed below. A post-fix codex run then converged end-to-end
(`success` @ summary, PR opened) in **~94 min vs the prior ~285 min**.

- **`allowFailure` is honored on call tasks.** The deterministic `gate`'s
  `cli_workspace_command` deliberately surfaces a transient dispatch/transport error
  as `success:false` (so the loop treats it as a build failure) — but
  `_handle_call_task` used to raise regardless, killing the whole run. It now returns
  the failed result when the node sets `with.allowFailure: true`, so a transient blip
  becomes a tolerated iteration.
- **No orchestrator per-turn parent timer on `durable/run` (agent-led).** The old
  `_child_workflow_result_with_timeout` raced the agent's OWN self-timeout
  (`timeout_minutes` is also passed to `session_workflow`); when the parent timer won
  it fatally killed a multi-hour run and could leave the parent `RUNNING` via stale
  Scheduler reminders. Non-benchmark `durable/run` now uses the agent-led
  `_child_workflow_result_or_cancel_event` (the benchmark path already did, for the
  same reason): the agent self-terminates gracefully → the loop gets a partial result
  and continues; cancellation still works; the lifecycle reaper is the global backstop.
  Restore the old hard timer with `SW_DURABLE_RUN_PARENT_TIMER=true`.
- **Contract size is capped.** CLI agents emit 30–40+ criteria; an oversized contract
  makes each generate/evaluate turn run for HOURS (the root driver of the per-turn
  timeouts). `read_contract` caps to `WFB_MAX_CRITERIA` (default 24) after dedupe,
  keeping the most-important first N (the critic orders by importance).
- **Preview installs deps if missing.** `startCliPreview` runs `npm/pnpm install` when
  `node_modules` is absent, so a partial/errored run (whose `gate` never completed) is
  still previewable.

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

## Implemented (the three GANs.md elements added on this structure)

All three are **additive and toggleable via trigger inputs** (defaults below give the
new behavior; set them to recover the original loop). Each agent-emitted JSON is still
canonicalized by a deterministic `workspace/command` normalizer (never trust prose).

- **Two-pass design process** (trigger `designPass`, default `true`) — a `design`
  loop runs after `approve_goal_spec`, before `negotiate`:
  - `design_propose` (generatorAgent) writes `/sandbox/work/design-tokens.json`
    (`{palette:[{name,hex}×4–6], typography:{display,body}, spacing, motif}`) +
    `/sandbox/work/wireframe.txt` (ASCII layout) — **no code**.
  - `design_review` (criticAgent) grades the design *plan* on Originality + Craft and
    rejects generic "AI slop"; writes `design-review.json {approved, feedback}`.
  - `design_read` normalizes → gates `approved` (also requires the tokens file). The
    loop (cap 3) repeats until approved; `refine/generate` then treats the tokens +
    wireframe as the AUTHORITATIVE visual direction. `designPass=false` skips it.
- **Parallel voting critics** (trigger `criticVotes`, default `2`) — the build loop's
  single evaluator becomes N independent votes (`evaluate` always; `evaluate_2` runs
  only when `criticVotes>=2`), each writing `verdict-<i>.json`. `read_verdict`
  aggregates **skeptically** (a criterion passes only if ALL votes agree —
  any-fail → fail), updates `contract.json` passes, and logs vote count to
  `progress.json`. `criticVotes=1` reduces to the original single critic.
- **Evaluator restart authority** (trigger `maxRestarts`, default `2`) — verdicts
  carry `recommend_restart` (TRUE only when work is fundamentally broken). When the
  vote majority flags it and `resetCount < maxRestarts`, `maybe_restart` (last node in
  the refine loop) does `git -C /sandbox/work/repo reset --hard <baseline> && git
  clean -fd`, bumping `resetCount` in `progress.json`. The contract / design tokens /
  memory live at the `/sandbox/work` ROOT (outside `repo/`), so they survive the
  reset — only the broken code is discarded.

## Deferred (additive on this same structure)

- **Multi-sprint contracts** (per `coleam00/adversarial-dev`): decompose into
  several sprints, each with its own negotiated contract + build + score, instead
  of one contract for the whole redesign.
- **dapr-agent-py GAN variant**: re-author the 7 `cliWorkspace` JuiceFS nodes to the
  `openshell-shared` backend (`workspace/*` on `openshell-agent-runtime`, no
  `cliWorkspace`) so the canonical pattern also runs on `dapr-agent-py` (the CLI
  fixture can't — `WorkspaceBackendMismatchError`).

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
