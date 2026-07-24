# Pydantic-AI Agent Spec: declarative agent definitions for pydantic-ai-agent-py

**Status: EVALUATION (verified against pinned versions) — recommends phased adoption.**

Evaluates pydantic-ai's declarative **Agent Spec** feature
(<https://pydantic.dev/docs/ai/core-concepts/agent-spec/>) as the definition
format for our `pydantic-ai-agent-py` runtime: can we define agents at
runtime from data, host multiple agent definitions in one Dapr application,
and cut over from today's `agentConfig` assembly?

Every mechanical claim below was **probed against our locked dependencies**
(`pydantic-ai-slim 2.13.0`, `pydantic-ai-harness 0.7.1`) — not just read from
docs.

---

## 1. What Agent Spec is

`AgentSpec` is a pydantic model describing an agent declaratively (YAML/JSON/
dict), loaded via `Agent.from_file(...)` / `Agent.from_spec(...)`. Fields in
our pinned 2.13.0:

```
model, name, description, instructions, deps_schema, output_schema,
model_settings, retries, end_strategy, tool_timeout, metadata, capabilities
```

Capabilities are named entries in three forms — `'Name'`,
`{'Name': positional}`, `{'Name': {kwargs}}` — each resolved to a capability
class and instantiated via `cls.from_spec(*args, **kwargs)`.

**Resolution is an explicit registry, not magic**: built-in
`pydantic_ai.capabilities.CAPABILITY_TYPES` (`MCP`, `WebSearch`, `Thinking`,
`PrefixTools`, …) **plus whatever the host passes as
`custom_capability_types`**. There is no entry-point auto-discovery. A spec
can only name what the host process registered — the registry **is** the
security boundary, and we control it.

## 2. Verified compatibility (probes run against our lockfile)

| Probe | Result |
|---|---|
| `AgentSpec` / `Agent.from_spec` / `Agent.from_file` present in pinned 2.13.0 | ✅ |
| Harness `FileSystem`, `Shell`, `RepoContext`, `OverflowingToolOutput`, `ClampOversizedMessages`, `SlidingWindow` are `@dataclass` capabilities with `from_spec` + `get_serialization_name` → spec-referenceable via `custom_capability_types` | ✅ |
| Built-in `MCP` capability carries `url`, `headers`, `authorization_token`, `allowed_tools` | ✅ (replaces our hand-rolled `mcpServers` loop, including the team-token headers) |
| **Spec → capability *instances* without constructing/running an `Agent`** (`get_capability_registry(...)` + `load_from_registry(...)`) | ✅ — the cutover-critical seam; our `ToolRouter` consumes the resolved list unchanged |
| `AgentSpec.model_json_schema_with_capabilities([...])` builds a JSON Schema including our registered capability arg schemas | ✅ (BFF-side validation / editor autocompletion) |
| Spec round-trips to plain JSON (`model_dump(mode='json')`) | ✅ (storable in the `agents` table as-is) |

Field-name gotcha: capability args are the dataclass field names —
`FileSystem(root_dir=…)` not `root` (a `root:` spec entry fails with
"unexpected keyword argument", loudly, at load time — good).

## 3. Fit with our architecture — the one big nuance

Our runtime **does not call `Agent.run()`**. The Dapr workflow *is* the run
loop (one `call_llm` activity per LLM message, one `execute_tool` per tool
call); `ToolRouter` consumes capabilities through their seams
(`get_toolset` / `get_instructions` / model-request + tool hooks).

So the correct adoption is **Agent Spec as the definition format + capability
resolver**, not `Agent.from_spec().run()`:

```
spec (JSON, from agentConfig.agentSpec)
  → AgentSpec.model_validate            (schema check)
  → load_from_registry(platform registry)  (named capabilities → instances)
  → platform guardrail pass             (§6 — clamp paths, merge deny-lists, stamp tokens)
  → ToolRouter(capabilities)            (existing durable loop, unchanged)
```

This preserves everything we've built (per-activity durability, MCP listing
cache + negative cache, network-call timeouts, hook hosting inside
activities, OTEL spans) while making *which* capabilities/instructions/model
an agent gets fully data-driven.

### Spec fields vs. our loop

| Spec field | Maps to | Notes |
|---|---|---|
| `instructions` | system-prompt bootstrap in `call_llm` (today: `agentConfig.systemPrompt`) | clean |
| `capabilities` | `build_capabilities()` replacement | the core win |
| `model_settings` | merged over `build_model_settings()` | K3 constraints (temp=1, freq=0) enforced platform-side, spec can't undo them |
| `model` | **platform model KEY** (like dynamic-script `opts.model`), resolved by our `build_model()` seam | do NOT use pydantic-ai's provider inference — our gateway/base-url/key wiring stays authoritative; dovetails with the deferred multi-provider work |
| `name` / `description` / `metadata` | passthrough (events, spans) | clean |
| `output_schema` | **ignore** — spec's version is instruction-only (explicitly not validated upstream) | our provider-native structured-output lane (`responseJsonSchema`) is strictly stronger; keep it |
| `retries`, `end_strategy`, `tool_timeout` | **not honored in v1** | these configure `Agent.run`'s internal loop; our durability/retry story is Dapr activity retries + `MCP_TIMEOUT_SECONDS`. Document as no-ops (validate-but-warn) |
| `deps_schema` / `{{template}}` strings | unused v1 | optional later: platform variables (`{{workspace}}`, `{{session_id}}`) resolved at load |

### What stays outside the spec (platform envelope, not agent definition)

`maxTurns`/`maxIterations` (loop budget), `hooks` (portable
`agentConfig.hooks` contract shared across runtimes), lifecycle/cancellation,
goal wiring, `workflowMcpSessionToken` (a *credential*, stamped by the
platform — never authored in a spec).

## 4. "Multiple agents from the same Dapr application"

Three tiers, first one essentially free:

1. **Already true today**: per-session sandbox pods are agent-agnostic —
   `agentConfig` arrives at dispatch, so one *image/app* already serves any
   number of agent definitions across sessions. Spec formalizes the format.
2. **Multiple specs in one process** (small change): the `ToolRouter` cache
   is already keyed by config hash. Key it on the canonical spec JSON hash and
   one process hosts N distinct agents concurrently — relevant for the
   legacy-style long-lived Deployment shape, warm pools (spec arrives at
   claim time, pod stays generic), and Agent Teams (lead + teammates with
   different personas sharing one image).
3. **Dynamic-script inline specs**: `agent(prompt, {agentSpec: {...}})` — a
   script authors a bespoke persona per call without a pre-registered DB
   agent, validated by the same schema, subject to the same guardrails.

## 5. Options

### Option A — status quo (imperative `build_capabilities`)
- ✅ No work; known-good.
- ❌ Capability set is hard-coded per image build; per-agent variation only via
  env flags + `mcpServers`; every new knob = code change in the runtime;
  personas can't differ in tools/compaction/limits.

### Option B — spec as **runtime input** (additive; `agentConfig.agentSpec`)
BFF keeps `agentConfig` as the cross-runtime envelope; pydantic runtime
prefers an embedded spec when present, falls back to today's assembly.
- ✅ Verified-feasible now; zero impact on the other 4 runtimes and the
  swap-safety gate; unlocks tiers 2+3 above; UI/scripts get schema-validated
  authoring immediately.
- ❌ Two definition dialects live side by side until B→C.

### Option C — spec as the **platform SSOT** for pydantic-family agents
`agents` rows for `runtime: pydantic-ai-agent-py` store an `AgentSpec`
document as *the* definition; BFF translates spec→legacy `agentConfig` only
at the swap boundary (an agent moved to another runtime gets a lossy-swap
WARN/REJECT from the existing gate, now spec-aware).
- ✅ One authored artifact; JSON-schema-validated editor; export/import =
  upstream-standard YAML; per-agent tool/compaction/limit tuning without
  image builds.
- ❌ Cross-runtime translation layer to maintain **as long as agents are
  runtime-swappable**; premature if pydantic doesn't become the default
  runtime.

**Recommendation: B now, C gated on the default-runtime decision**
(`docs/pydantic-ai-default-runtime-evaluation.md`). Full-cutover-over-shims
applies *within* the pydantic runtime (once `agentSpec` lands, delete the
legacy assembly path there); it does not justify forcing a pydantic-shaped
SSOT onto four non-pydantic runtimes.

## 6. Security / guardrails (specs are user-authored data)

Applied **after** resolution, on the instances — a spec can *narrow* but
never *widen* platform policy:

- **Registry allowlist**: only
  `{FileSystem, Shell, RepoContext, OverflowingToolOutput,
  ClampOversizedMessages, SlidingWindow}` + built-in `MCP` registered.
  Notably **not** CodeMode (durability-incompatible) and not the built-in
  `WebSearch`/`WebFetch`/`XSearch` (provider-native tools we don't provision).
  Unknown names fail validation at the BFF before dispatch.
- **Path clamp**: `FileSystem.root_dir`, `Shell.cwd`,
  `RepoContext.workspace_dir` re-rooted under `WORKSPACE_ROOT`
  (realpath-checked) regardless of spec values.
- **Deny-list merge**: platform `SHELL_DENIED_ENV_PATTERNS` (provider keys,
  `INTERNAL_API_TOKEN`, …) merged into every `Shell` — spec additions
  allowed, removals impossible. Same for `protected_patterns`.
- **Credential stamping stays platform-side**: `X-Wfb-Session-Token` folding
  and Playwright-sidecar MCP rewrite run on the resolved `MCP` capabilities
  exactly as today; a spec-authored `authorization_token` may add *user*
  auth but platform tokens are never spec-supplied.
- `deps`/template injection: unused in v1 (`deps=None`), so Handlebars
  templates are inert.

## 7. Cutover plan

- **P1 — runtime accepts `agentConfig.agentSpec`** (services/pydantic-ai-agent-py):
  validate → resolve → guardrail pass → `ToolRouter`; router cache keyed on
  spec hash; `spec.model` resolved through `build_model()`; delete-path for
  legacy assembly once green. Registry module exports the platform
  `custom_capability_types` list + the generated JSON schema.
- **P2 — BFF authoring**: schema (from
  `model_json_schema_with_capabilities`) checked into `services/shared/`
  (sync-script drift-guarded like the runtime registry); agent editor
  validates; `create_agent` MCP tool accepts a spec; spawn path passes it
  through verbatim.
- **P3 — dynamic scripts + teams**: `agent(..., {agentSpec})` inline specs;
  team lead/teammate personas as specs.
- **P4 (conditional on default-runtime GO) — SSOT flip** per Option C:
  migrate pydantic-family `agents` rows to spec documents, translate at the
  swap boundary, teach swap-safety to derive required capabilities from the
  spec.

## 8. Bottom line

Yes on both questions. Agent Spec is present and working in our pinned
versions; our harness capabilities are already spec-compatible dataclasses;
and the resolver works standalone, so it slots into our durable loop without
touching `Agent.run`. "Multiple agents per Dapr app" is mostly already our
architecture — the spec makes the definitions portable, validatable data and
extends per-agent variation to tools/compaction/limits, not just prompt +
MCP list. The only genuine cutover cost is the cross-runtime translation
question, which is why the SSOT flip (P4) should ride the default-runtime
decision rather than lead it.
