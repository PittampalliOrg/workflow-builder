# Dynamic Script Authoring Guide (platform dialect)

**Audience:** an agent (or a human) authoring a `dynamic-script` workflow to run on
workflow-builder. This is the SOURCE OF TRUTH for *how to write a script that runs
correctly here.*

This platform runs the **Claude Code Workflow-tool dialect** (`agent()`, `parallel()`,
`pipeline()`, `phase()`, `log()`, `workflow()`, globals `args`/`budget`). The full upstream
contract is in [`claude-code-workflow-tool-spec.md`](./claude-code-workflow-tool-spec.md);
the engine internals are in [`dynamic-script-workflows.md`](./dynamic-script-workflows.md).

**A script written to the Claude Code spec is ~portable here — with a handful of deltas that
change what a script *observes*.** Those deltas are almost all in the `opts` vocabulary and the
`budget` unit. Read [§ Platform deltas](#platform-deltas-read-this) before you write anything;
the rest of the dialect matches the upstream spec exactly.

---

## The one-minute version

```js
export const meta = {
  name: 'my-workflow',                 // REQUIRED, must be a pure literal (no vars/calls)
  description: 'What this does',        // shown in the run UI + permission dialog
  phases: [{ title: 'Draft' }, { title: 'Judge' }],
}

const topic = typeof args?.topic === 'string' ? args.topic : 'default topic'

phase('Draft')
const drafts = await parallel(
  ['mvp', 'risk', 'scale'].map((lens) => () =>
    agent(`Draft a plan for ${topic}, framed around ${lens}.`, { label: `draft:${lens}`, phase: 'Draft' }),
  ),
)

phase('Judge')
const SCORE = { type: 'object', required: ['score'], properties: { score: { type: 'number' } } }
const best = (await parallel(
  drafts.filter(Boolean).map((d) => () =>
    agent(`Score 0-10:\n${d}`, { phase: 'Judge', schema: SCORE }).then((s) => ({ d, score: s?.score ?? 0 })),
  ),
)).filter(Boolean).sort((a, b) => b.score - a.score)[0]

return { winner: best?.d }
```

Working, idiomatic exemplars live in `scripts/fixtures/dynamic-scripts/`:
`best-of-n.js` (judge panel), `audit-fanout.js` (map-reduce + adversarial verify),
`iterate-until-approved.js` (generator/critic loop), `discover-until-dry.js` (loop-until-dry),
`nested-parent.js` + `summarize-child.js` (`workflow()` composition), `demo-review.js`.

---

## Primitives (identical to the Claude Code spec)

These behave exactly as the upstream spec describes — no deltas:

| Primitive | Contract |
| --- | --- |
| `agent(prompt, opts?)` | Returns the agent's final text (string), or — with `opts.schema` — the schema-validated object, or `null` (skipped / died / exceeded structured-retry cap). `.filter(Boolean)` results you fan out. |
| `parallel(thunks)` | **Barrier.** Runs all thunks concurrently, awaits all. A thunk that throws (or whose agent errors) resolves to `null` — the call itself never rejects. `.filter(Boolean)` before use. |
| `pipeline(items, ...stages)` | **Per-item, NO barrier.** Each item flows through all stages independently. Each stage callback receives `(prevResult, originalItem, index)`. A stage that throws drops that item to `null` and skips its remaining stages. Default for multi-stage work. |
| `phase(title)` | Starts a progress phase; subsequent `agent()` calls group under it. |
| `log(msg)` / `console.log(...)` | Emits a progress line (persisted to the run's logs). |
| `workflow(nameOrRef, args?)` | Runs another saved dynamic-script workflow as a sub-step and returns its `returnValue`. **Throws** on an unknown name / child error (catch to handle gracefully); user-skip resolves `null`. **One level only** — calling `workflow()` inside a nested run throws. |
| `args` | The verbatim run input (deep-frozen JSON). |
| `budget` | `{ total: number|null, spent(): number, remaining(): number }`. `total` is `null` if no budget was set; `remaining()` is `Infinity` then. See the budget delta below for the UNIT. |

Determinism, `meta`, and structured output are covered in their own sections below.

---

## Platform deltas (READ THIS)

Everything here differs from the Claude Code spec in a way a script author must know. Get these
wrong and the script is still *syntactically valid* — it just does the wrong thing silently.

### 1. `opts.model` is a platform model KEY, not a tier alias

Claude Code accepts tier aliases like `'opus'`, `'sonnet'`, `'haiku'`, `'fable'`. **Here, `model`
is passed straight through as the agent's `modelSpec`/`model`** (`script_agent_dispatch.py`
`_build_agent_config`). It must be a key the runtime resolves:

- ✅ `{ model: 'zai/glm-5.2' }`, `{ model: 'anthropic/claude-opus-4-8' }`, `{ model: 'openai/gpt-5.5' }`
- ❌ `{ model: 'opus' }` — not a resolvable key → the runtime **falls back to its default model**, silently.

Omit `model` to inherit the run default. The default is set by the BFF env
`DYNAMIC_SCRIPT_DEFAULT_MODEL` (dev = `zai/glm-5.2`) and is applied **only when the resolved
runtime is `dapr-agent-py`** — a per-call `agentType` selecting an Anthropic-only runtime never
inherits a cross-provider default. `dapr-agent-py` reads `modelSpec` (not `model`); the dispatch
stamps both.

### 2. `opts.agentType` selects the agent RUNTIME, not a persona

In Claude Code `agentType` is a subagent persona (`'Explore'`, `'code-reviewer'`, …). **Here it
selects the agent runtime** (`script_agent_dispatch.py`: `agentType or defaults.agentRuntime` →
`runtime_registry.resolve()`). Valid values are runtime ids from `services/shared/runtime-registry.json`:

- `dapr-agent-py` (default; multi-provider, per-activity durability, OpenShell tools)
- `claude-agent-py` (Claude Agent SDK, Anthropic-only, supports MCP)
- `adk-agent-py` (Google ADK)
- `browser-use-agent` (vision/browser, warm-pool)
- `claude-code-cli` (real Claude Code TUI in a sandbox; requires a linked CLI credential)

There is no persona/subagent-type dimension in the script surface. To vary *behavior*, vary the
prompt (and `model`); to vary the *engine*, set `agentType`. An **unresolvable** `agentType` (a
persona name, or a typo'd runtime id) makes **that one `agent()` call resolve to `null`** (with a
warning in the run logs) — it no longer crashes the whole run. So `.filter(Boolean)` still protects
you, but a silently-null agent usually means a bad `agentType`.

### 3. `opts.isolation`: use `'shared'`; `'worktree'` is a no-op

Claude Code uses `isolation: 'worktree'` to give an agent an isolated git worktree (the default
being shared). **Here it is inverted and different:** each agent is isolated in its own per-session
sandbox by **default**, and the only meaningful value is `isolation: 'shared'`, which puts the
agents on one shared workspace (`ws_script_<executionId>`) so they can hand files to each other
(`script_agent_dispatch.py` line ~200). Any other value — including `'worktree'` — is a silent
no-op (you get the default per-agent isolation).

- ✅ `{ isolation: 'shared' }` → all agents in the run share one workspace.
- ⚠️ `{ isolation: 'worktree' }` → no effect (already isolated per-agent).

Note: `isolation` participates in the callId hash, so changing it changes a call's identity for
resume purposes — but only `'shared'` changes runtime behavior.

### 4. `opts.effort` is honored — mapped per provider

`effort` (`'low' | 'medium' | 'high' | 'xhigh' | 'max'`) is stamped as
`agentConfig.reasoningEffort` and **wired through the dapr-agent-py adapters** (per-agent value
wins over the provider env default). Each provider clamps to its accepted set:

| Provider | `low`/`medium`/`high` | `xhigh`/`max` |
| --- | --- | --- |
| GLM (`zai/*`) | `high` | `max` |
| DeepSeek | `high` | `max` |
| OpenAI (gpt-5/o-series) | as given | `high` |
| Anthropic / Kimi | ignored (adaptive thinking) | ignored |

So `effort` differentiates only between the ≤`high` band and `xhigh`/`max` on GLM/DeepSeek, and
low/medium/high on OpenAI. It participates in the callId hash — changing it between resume
attempts re-runs that call.

### 5. `budget` counts more than output tokens

The Claude Code spec says `budget.spent()` returns **output** tokens. **Here `spent()` is the
codex/goal-loop token measure: `input + output + cache_creation`, net of cache reads**
(`goal-loop.ts` `tokensFromUsage`, summed over the whole execution tree by `aggregate_script_usage`).
So a budget sized for Claude Code will be reached **sooner** here. Size `budgetTotal` accordingly.

Semantics that DO match the spec: `budget` is a hard ceiling — once the run has spent `>= total`,
unresolved `agent()` calls **throw** (`BudgetExhaustedError`) so the script can `catch` and wrap up.
**In-flight overshoot is by design:** exhaustion stops *new* dispatch, but agents already running
complete and their tokens still count. Guard loops with `while (budget.total && budget.remaining() > N)`.

### 6. Caps

| Cap | Claude Code | Here |
| --- | --- | --- |
| Concurrent agents | `min(16, cores−2)` | `DYNAMIC_SCRIPT_MAX_CONCURRENCY` (dev **5**); a politeness cap above Kueue admission |
| Lifetime agents | 1000 | code default **1000** (spec-aligned), narrowed per-deployment via `DYNAMIC_SCRIPT_MAX_AGENT_CALLS` (dev **50**) |
| Items per `parallel()`/`pipeline()` | 4096 | **4096** (identical); passing more is an explicit error, not a silent truncation |
| Script size | — | `DYNAMIC_SCRIPT_MAX_BYTES` (default **256 KiB**) |

When the lifetime cap is hit, further `agent()` calls throw `AgentLimitError` — same handling as
budget exhaustion. **Don't assume 1000 in dev — assume the deployment's `DYNAMIC_SCRIPT_MAX_AGENT_CALLS`.**

### 7. Resume is not `resumeFromRunId`

There is no `runId`/`resumeFromRunId`. Crash-resume is automatic (Dapr replay). **Resume-after-edit**
is `POST /api/workflows/executions/[id]/resume {}` — it starts a fresh execution of the CURRENT
script and imports the prior run's `done` journal rows, so unchanged `agent()` calls resolve
instantly (zero new sessions) and only edited/new calls dispatch. The determinism rules below are
what make this work — do not defeat them.

### 8. MCP tools inside spawned agents

Agents dispatched by a script get their runtime's configured MCP tools. `run_workflow_script` is
**suppressed** inside script-spawned sessions (recursion guard via `X-Wfb-Script-Depth`), so a
script cannot recursively launch scripts through that tool — use `workflow()` for composition.

### 9. `args` is any JSON value, verbatim (spec parity)

`args` accepts **any JSON value** — object, array, string, number, bool, or null — passed verbatim
and deep-frozen. `args: ["a.ts", "b.ts"]` and `args: "a research question"` work as the upstream
spec documents (`args.map(...)` on a top-level array is fine). When no input is provided at all,
the `args` global is **`undefined`** (spec parity) — so guard with `args?.topic` / `Array.isArray(args)`
rather than assuming an object. An explicit `null` stays `null`. The same verbatim rule applies to
the `args` you pass to `workflow(name, args)` — omitted args means the child sees `undefined`.

### 10. `workflow()` THROWS on child failure (spec parity)

Per the upstream contract, `workflow()` **throws** on an unknown/unresolvable workflow name, a child
script error, or a failed child run — so `try/catch` works for graceful fallback. The thrown
message carries the reason (e.g. `workflow() could not resolve 'name': …`). A **user skip** of a
workflow call still resolves `null` (same as `agent()`). On success it returns the child's
`returnValue`.

- ✅ `try { r = await workflow('summarize', {...}) } catch (e) { /* fallback, e.message says why */ }`
- Inside a `parallel()` thunk or `pipeline()` stage, the throw follows the normal rule: that
  thunk/item resolves to `null`.

### 11. Nested `workflow()` children SHARE the parent budget (spec parity)

A `workflow()`-nested child inherits the run's `budgetTotal`, and since usage aggregates over the
shared executionId, the child's `budget.spent()` is the **whole tree's** spend. Budget-scaling
loops (`while (budget.total && budget.remaining() > N)`) work inside nested children. One residual
per-level detail: concurrency/lifetime caps are enforced per workflow level, so a two-level tree
can run up to 2× the per-level concurrency cap.

---

## `meta` block rules

- Must be `export const meta = { ... }` as a **pure object literal** — no variables, function
  calls, spreads, or template interpolation. (It is extracted and evaluated in an empty context;
  any identifier reference makes it invalid and the workflow fails validation.)
- `name` is **required** (non-empty string). `description` is **optional here** (the spec calls it
  required) but recommended — it's the run/permission-dialog line. `phases` optional
  (`[{ title }]` or `[string]`). Extra keys are preserved.
- Use the same phase titles in `meta.phases` as in your `phase()` calls.
- **`meta.phases[].model` is honored** (spec parity): an agent whose phase matches an entry with a
  `model` uses it when the call has no `opts.model`. Resolution order:
  `opts.model` → `meta.phases[phase].model` → `defaults.model` (the last only for dapr-agent-py).
  The value is a platform model KEY (same rule as `opts.model`).
- **`meta.whenToUse` is accepted and persisted but not yet surfaced** in any workflow list UI.
- `estimatedAgentCalls` is a heuristic (text count of `agent(` occurrences), computed by the
  evaluator and stamped into the saved spec — you don't set it.

## Determinism (required for replay + resume-after-edit)

These **throw** inside a script — the engine re-executes the whole script each round, so
non-determinism would corrupt resume:

- `Date.now()`, `new Date()` with no args, `Date()` as a function, `Math.random()`
- `import` (static or dynamic), `require`, `fetch`, `process`, timers (`setTimeout`, …)
- `eval`, `new Function(...)`, and `WebAssembly` (runtime code-generation is disabled)

Standard pure built-ins are available: `JSON`, `Math` (except `random`), `Array`, `Object`,
`String`, `Number`, etc. `log()` **and** `console.log`/`console.error`/`console.warn`/`console.info`/
`console.debug` all work (they write to the run log). Need a timestamp or randomness? Pass it in via
`args`, or derive variation from the item index. Scripts are plain **JavaScript** — no TypeScript
syntax (type annotations/interfaces/generics fail to parse).

## Structured output

Pass `opts.schema` (a JSON Schema) to get a validated object back. `agent(prompt, {schema})` returns
a schema-valid object or `null` — never an invalid object. Enforcement is layered (all keyed off the
same `opts.schema`; the return contract is identical regardless of which tier fires):

- **Tier 1 — OpenAI strict `json_schema` (the default for schema'd calls).** By default a schema'd
  call is **routed to a configured OpenAI structured model** (`DYNAMIC_SCRIPT_STRUCTURED_MODEL`,
  default `openai/gpt-5.5`) and enforced with strict constrained decoding — essentially guaranteed
  schema-valid on the first attempt (no retries). This is **hybrid routing**: only *schema'd* calls
  move to OpenAI; open-ended (non-schema) calls stay on GLM.
- **Tier 2 — GLM `json_object`.** If you route a schema'd call to GLM explicitly (`opts.model:
  'zai/glm-5.2'` or a per-phase model), GLM forces valid JSON via `json_object` (GLM has no strict
  json_schema mode) — not shape-enforced, but it kills "prose instead of JSON" failures, and GLM's
  thinking stays on.
- **Tier 3 — universal fallback (always on).** The `<output-contract>` prompt block +
  `jsonschema` validation + **corrective retry session** (up to `maxStructuredRetries`, default **5**;
  then `null` with `error_max_structured_output_retries`) run for *every* schema'd call regardless of
  provider. This is the response-side authority — native enforcement (Tiers 1-2) is a request-side
  optimization that just makes it pass first try.

**Controls & cost:** a per-call `opts.model` (or per-phase `meta.phases[].model`) always wins over the
Tier-1 routing — set it to keep a schema'd call on GLM (Tier 2), or to pick a different strict model.
Because Tier-1 routes schema'd calls to OpenAI, **schema'd calls bill OpenAI** (open-ended calls stay
on the cheap GLM default). The whole native path is behind `DYNAMIC_SCRIPT_NATIVE_STRUCTURED_OUTPUT`
(default on) — set it off to revert every schema'd call to GLM + the prompt-contract.

## Validate before you run

The evaluator has an authoritative `/validate` (syntax + `meta` + `estimatedAgentCalls`, no
execution). Author → validate → run:

- **Agents:** call the MCP tool `validate_workflow_script` (workflow-mcp-server) with your source;
  it returns `{ ok, meta, estimatedAgentCalls, error }`. Call `get_workflow_script_spec` for a
  compact copy of this dialect reference. Then `run_workflow_script` with `script` (inline) or
  `workflowName` (saved).
- **Humans/CLI:** `POST {SCRIPT_EVALUATOR_URL}/validate { script }`, or
  `node scripts/upsert-dynamic-script-workflow.mjs --file <file.js>` (create/update also validates),
  then execute via the UI or `POST /api/workflows/[id]/execute { input, budgetTotal? }`.

## Patterns

Compose freely; these map onto the primitives (and have fixtures):

- **Map-reduce + adversarial verify** — `pipeline(items, find, verify)`: each finding verifies as
  soon as its finder returns (no barrier). See `audit-fanout.js`.
- **Judge panel / best-of-N** — `parallel` drafts from diverse framings → `parallel` schema'd
  judges → synthesize from the winner. See `best-of-n.js`.
- **Generator/critic loop** — `while (!approved && rounds < cap)` alternating a generator and a
  schema'd critic. See `iterate-until-approved.js`.
- **Loop-until-dry** — keep spawning finders until K consecutive rounds surface nothing new; dedup
  against a `seen` set (plain code, not an agent). See `discover-until-dry.js`.
- **Composition** — a parent `workflow()`-s child scripts and combines their `returnValue`s. See
  `nested-parent.js` + `summarize-child.js`.
- **Budget-scaled depth** — `while (budget.total && budget.remaining() > N) { ... }`.

Barrier vs pipeline: default to `pipeline()`. Reach for a `parallel()` barrier only when a later
stage genuinely needs ALL prior results at once (dedup/merge across the full set, early-exit on
zero, or "compare against the others").

## Recipes: mimicking the built-in Claude Code workflows

The two flagship built-ins port directly onto these primitives — and, importantly, our
dapr-agent-py GLM agents ship the **full Claude Code tool set** (`WebSearch`, `WebFetch`, `Read`,
`Grep`, `Glob`, `Bash`, …), so the research recipe does *genuine* web research, not just knowledge
synthesis. (Script-spawned `agent()`s set no `allowedTools`, so they get every default tool.)

- **deep-research** (`deep-research.js`) — decompose → parallel web sweep (`WebSearch`+`WebFetch`)
  → completeness critic → loop until saturated/budget → synthesize a sourced brief. Shape:
  `agent(plan, schema)` → `while (rounds && budget) { parallel(research) → agent(critic, schema) }`
  → `agent(synthesize)`. The critic (`{saturated, gaps}`) is what makes it *deep* — gaps become the
  next round's sub-questions. Verified live on GLM 5.2: cited real URLs, 4 phases, saturated in 1
  round on a well-scoped question.
- **code-review** (`code-review.js`) — the canonical `pipeline()` pattern: one finder per review
  DIMENSION (correctness/security/perf/tests/readability), each finding then challenged by N
  **adversarial skeptics** (`parallel` of refuters, majority-`real` survives), then a severity-ranked
  report of only the confirmed findings. `pipeline(DIMENSIONS, finder(schema), review =>
  parallel(findings → parallel(refuters)))`. Reviews inline code via `args.code` (or point the finder
  prompt at `Read`/`Grep` on a mounted repo). Mind the lifetime-agent cap: dimensions × findings ×
  votes + report must stay under the deployment cap (dev 50) — trim dimensions or `verifyVotes` for
  large diffs.

Both default to GLM 5.2 (the platform `DYNAMIC_SCRIPT_DEFAULT_MODEL`); set `agent(..., {model})` or
a per-phase `meta.phases[].model` to run a heavier synthesis/verify step on a different key.
