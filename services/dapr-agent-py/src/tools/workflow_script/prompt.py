"""The Workflow tool's description — the spec injection.

Mirrors Claude Code's Workflow tool, whose (very long) description IS the
authoring spec for the script dialect. The dialect section below is kept in
sync with the workflow-mcp-server's PLATFORM_SCRIPT_DIALECT_GUIDE
(services/workflow-mcp-server/src/script-tools.ts) and
docs/dynamic-script-authoring-guide.md — those are the SSOTs; edit there first.
"""

from __future__ import annotations

_DIALECT_GUIDE = """# Dynamic Script dialect (workflow-builder platform)

Write plain JavaScript (NOT TypeScript). The script starts with a PURE-LITERAL
`export const meta = { name, description?, phases? }` (name required; no variables/calls
inside it), then a body using these globals/hooks. The engine RE-EXECUTES the whole script
each round, so it must be deterministic.

PRIMITIVES (identical to Claude Code). The script body is ASYNC — every hook returns a
Promise and MUST be awaited (`const x = await agent(...)`, `const [a, b] = await
parallel([...])`). A forgotten await is a hard script_error (the engine detects completed
scripts with un-awaited calls, Promises in the returnValue, and "[object Promise]" in prompts):
- agent(prompt, opts?) -> final text (string), or schema-validated object (with opts.schema),
  or null (skipped/died/exceeded structured-retry cap). .filter(Boolean) fanned-out results.
- parallel(thunks) -> BARRIER; runs all, a throwing thunk becomes null, never rejects.
- pipeline(items, ...stages) -> per-item, NO barrier; stage gets (prevResult, originalItem, index);
  a throwing stage drops that item to null + skips its remaining stages. DEFAULT for multi-stage.
- phase(title); log(msg)/console.log(...).
- workflow(nameOrRef, args?) -> runs another SAVED dynamic-script workflow, returns its returnValue.
  THROWS on unknown name / child error (catch to handle gracefully); user-skip resolves null.
  ONE LEVEL ONLY (nested workflow() throws). Nested children SHARE the parent's token budget.
- args -> the run's VERBATIM input: ANY JSON value (object/array/string/number/bool/null),
  deep-frozen; undefined when no input was provided (guard with args?.x / Array.isArray(args)).
- budget -> { total:number|null, spent():number, remaining():number }.
- Return a value at the end (bare top-level `return {...}`) — it becomes the run's output.

PLATFORM RULES (get these right):
1. opts.model = a platform MODEL KEY (e.g. 'zai/glm-5.2', 'anthropic/claude-opus-4-8'), NOT a tier
   alias ('opus'/'sonnet' silently fall back to the default). Omit to inherit the run default.
   meta.phases[].model IS honored as a fallback: opts.model > meta.phases[phase].model >
   defaults.model.
2. opts.agentType = the agent RUNTIME id (dapr-agent-py | claude-agent-py | adk-agent-py |
   browser-use-agent | claude-code-cli), NOT a persona. Vary behavior via the prompt.
   An unresolvable agentType makes THAT call resolve to null (logged), not crash the run.
3. opts.isolation: use 'shared' to put agents on ONE shared workspace; default is per-agent
   isolated. 'worktree' is a no-op here.
4. opts.effort ('low'|'medium'|'high'|'xhigh'|'max') is honored, clamped per provider.
5. budget.spent() counts input+output+cache_creation (net of cache reads), NOT output-only.
   Exhaustion makes unresolved agent() calls throw; in-flight agents still finish.
   Guard loops: while (budget.total && budget.remaining() > N) {...}.
6. STRUCTURED OUTPUT: pass opts.schema (JSON Schema, object-shaped). The platform enforces it
   natively (StructuredOutput tool / strict json_schema by provider) + validates + retries;
   still-invalid -> that call resolves to null.

DETERMINISM (these THROW in the script): Date.now(), argless new Date(), Date(), Math.random(),
import, require, fetch, process, timers, eval, new Function(), WebAssembly. Pure built-ins
(JSON, Math except random, Array, Object, String, Number) are OK. Need time/randomness ->
pass via `args` or derive from the item index.
"""

_TOOL_INTRO = """Execute a workflow script that orchestrates multiple subagents deterministically, \
and return its result when it completes.

A workflow structures work across many agents — to be comprehensive (decompose and cover in \
parallel), to be confident (independent perspectives and adversarial checks before committing), \
or to take on scale one context can't hold (audits, broad sweeps, migrations). The script encodes \
that structure: what fans out, what verifies, what synthesizes. Prefer a workflow over inline work \
when the task decomposes into 3+ independent agent-sized pieces or needs adversarial verification; \
for a single delegated task use your other tools instead.

This tool BLOCKS until the workflow reaches a terminal state (bounded by timeoutMinutes) and \
returns {status, output} — `output` is the script's return value, ready to digest. On timeout it \
returns {status:"timeout", executionId}; call the tool again with just {executionId} to re-attach \
and keep waiting (the run continues server-side either way). If the script fails validation the \
result carries the validator's error — fix the script and call again.

Quality patterns that transfer: map-reduce + adversarial verify (pipeline items -> find -> \
refute-with-N-votes), judge panel / best-of-N, generator/critic loop, loop-until-dry discovery, \
completeness critic. Scale finder/verifier counts to how thorough the caller asked you to be.
"""

_MECHANICS = """INPUT: exactly ONE of `script` (inline source), `workflowName` (a saved \
dynamic-script workflow), or `executionId` (re-attach to a run you started earlier). \
`args` is passed verbatim as the script's `args` global (any JSON value; omit for undefined). \
`budgetTotal` caps the run's token spend (input+output+cache_creation). `timeoutMinutes` \
(default 30, max 120) bounds how long THIS call waits — not the run itself.

Nesting: ONE level only. Agents running inside a workflow do not get this tool; use the \
script-level workflow() hook for child workflows instead."""


def get_workflow_tool_description() -> str:
    return f"{_TOOL_INTRO}\n{_DIALECT_GUIDE}\n{_MECHANICS}"
