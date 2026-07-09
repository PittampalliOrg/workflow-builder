export const meta = {
  name: 'dynamic-script-spec-alignment-audit',
  description: 'Audit the workflow-builder dynamic-script engine against the Claude Code Workflow tool spec, per dimension, with file:line evidence',
  phases: [
    { title: 'Audit', detail: 'one finder per spec dimension checks the real implementation' },
    { title: 'Synthesize', detail: 'consolidate genuine gaps vs by-design divergences vs doc-deltas' },
  ],
}

const ROOT = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/dynamic-script-engine'

const COMMON = `
You are auditing a REIMPLEMENTATION of Claude Code's dynamic-workflow (Workflow tool) engine
on the "workflow-builder" platform (Dapr workflows + a stateless Node "script-evaluator" vm
sandbox). Repo root: ${ROOT}

The authoritative Claude Code spec is at: docs/claude-code-workflow-tool-spec.md (READ IT).
The platform SSOT is: docs/dynamic-script-workflows.md (READ IT).

Your job: for the dimension assigned below, compare what the SPEC promises a script author vs
what the IMPLEMENTATION actually does, reading the REAL code. Classify each check:
  - "aligned": script-observable behavior matches the spec.
  - "divergent-by-design": differs, but only in INFRASTRUCTURE (Dapr replay vs journal, cap
    VALUES, storage) — a script author sees the same behavior. Note it but it's fine.
  - "genuine-gap": a script written to the spec would OBSERVABLY misbehave on this engine
    (wrong return value, silent no-op of an opt, different semantics). THESE ARE BUGS/RISKS.
  - "doc-gap": behavior differs from Claude Code in a way a script author MUST know to write a
    correct script here (e.g. opts value vocabulary, budget unit), but it's a documentation/
    guidance need, not a code bug.

Ground EVERY check in real evidence: cite file:line you actually read (use Read/Grep). Do NOT
speculate — if you can't find the code, say so and mark evidence "NOT FOUND".

Key implementation files (read the ones relevant to your dimension):
- Evaluator sandbox (the dialect enforcer): services/script-evaluator/src/sandbox.ts, call-id.ts, index.ts
- Orchestrator pump: services/workflow-orchestrator/workflows/dynamic_script_workflow.py
- Agent dispatch (interprets opts): services/workflow-orchestrator/workflows/script_agent_dispatch.py
- Journal / structured output: services/workflow-orchestrator/activities/script_call_journal.py
- Budget usage: services/workflow-orchestrator/activities/aggregate_script_usage.py
- BFF validation: src/lib/server/workflows/dynamic-script-validation.ts
- BFF start/resume: src/lib/server/workflows/start-run.ts and workflow-execution-control.ts
- MCP authoring tool: services/workflow-mcp-server/src/script-tools.ts, index.ts
- Frozen callId contract: services/shared/contracts/script-evaluator-evaluate.contract.json
- Example fixtures (current authoring style): scripts/fixtures/dynamic-scripts/*.js
`

const FINDING_SCHEMA = {
  type: 'object',
  required: ['dimension', 'checks', 'notes'],
  additionalProperties: false,
  properties: {
    dimension: { type: 'string' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['item', 'specSays', 'implDoes', 'evidence', 'classification', 'portabilityImpact', 'recommendation'],
        additionalProperties: false,
        properties: {
          item: { type: 'string' },
          specSays: { type: 'string' },
          implDoes: { type: 'string' },
          evidence: { type: 'string', description: 'file:line references you actually read' },
          classification: { type: 'string', enum: ['aligned', 'divergent-by-design', 'genuine-gap', 'doc-gap'] },
          portabilityImpact: { type: 'string', description: 'what breaks for a spec-authored script; "none" if aligned' },
          recommendation: { type: 'string' },
        },
      },
    },
    notes: { type: 'string' },
  },
}

const DIMENSIONS = [
  {
    key: 'primitives-return-semantics',
    prompt: `DIMENSION: Primitives & return semantics.
Verify against the spec: agent() returns final text | schema-validated object | null (skip/death/
max-retries); parallel() is a BARRIER and a thunk that throws resolves to null (call never rejects);
pipeline() is per-item with NO barrier, each stage callback receives (prevResult, originalItem, index),
and a stage that throws drops that item to null and skips its remaining stages; phase()/log()/console.log.
Check sandbox.ts (the hook implementations) AND script_call_journal.py (how a completed call's value is
resolved back into the script — done→value, null/skipped/error→null). Confirm the (prev, original, index)
stage-arg contract is really passed. Confirm orphan-pending drop-on-done behavior.`,
  },
  {
    key: 'globals-args-budget',
    prompt: `DIMENSION: Globals args & budget.
Verify: args is the verbatim input, deep-frozen. budget.total (null if unset), budget.spent(),
budget.remaining() (Infinity if no total); budget is a HARD ceiling — once spent>=total, agent() THROWS.
CRITICAL: determine the UNIT of budget.spent() on THIS platform vs the spec. Spec says budget.spent()
returns OUTPUT tokens. Read aggregate_script_usage.py and how DYNAMIC_SCRIPT_USAGE / goal-loop tokensFromUsage
computes it (input+output+cache_creation net of cache reads?). If the unit differs, that is a doc-gap an
author MUST know (budgets sized for Claude Code will behave differently). Also confirm in-flight overshoot
semantics (budget exhaustion stops NEW dispatch; already-running children still complete).`,
  },
  {
    key: 'opts-vocabulary',
    prompt: `DIMENSION: opts vocabulary — THE HIGH-RISK AREA. Read script_agent_dispatch.py CAREFULLY.
For EACH of opts.{label, phase, schema, model, effort, isolation, agentType}, determine:
(a) does the evaluator forward it (sandbox.ts toTask)? (b) does the orchestrator dispatch actually HONOR it,
and HOW is it interpreted on this platform?
Spec meanings to compare against:
  - model: a model TIER/key; agent inherits main-loop model by default.
  - effort: 'low'|'medium'|'high'|'xhigh'|'max' reasoning effort.
  - isolation: 'worktree' → fresh git worktree (default = isolated per-agent).
  - agentType: a custom SUBAGENT TYPE/persona (e.g. 'Explore','code-reviewer') from the Agent registry.
Report the ACTUAL platform interpretation. In particular I suspect: model must be a platform model KEY
(e.g. 'zai/glm-5.2','anthropic/claude-opus-4-8') NOT a tier alias like 'opus'; isolation uses value 'shared'
(not 'worktree'); agentType is interpreted as an agent RUNTIME (dapr-agent-py/claude-agent-py/...) not a
persona; effort may be a silent no-op. Confirm or refute each with file:line. Any opt that is silently
dropped/no-op is at least a doc-gap; if it changes callId hashing but does nothing, note that too.`,
  },
  {
    key: 'meta-and-phases',
    prompt: `DIMENSION: meta block & phases.
Verify: 'export const meta = {...}' must be a PURE LITERAL (no vars/calls/spreads/interpolation); required
name+description; optional whenToUse, phases, per-phase model. Read extractMeta() in sandbox.ts — confirm how
pure-literal is enforced (fresh null-context eval → ReferenceError on any variable ⇒ meta undefined) and what
happens when meta is missing/invalid. Read dynamic-script-validation.ts (BFF) for what it requires. Check:
does the platform surface meta.whenToUse anywhere? does it honor per-phase model? are phase() titles matched
to meta.phases? Classify each as aligned/doc-gap. Also confirm the '/validate' path returns meta+estimatedAgentCalls.`,
  },
  {
    key: 'determinism-limits-caps',
    prompt: `DIMENSION: Determinism bans, limits, caps.
Spec bans in scripts: Date.now(), Math.random(), argless new Date(), timers, import, fetch, require, process;
standard built-ins (JSON, Math, Array) available. Caps: concurrency min(16, cores-2); 1000-agent LIFETIME cap;
4096 items per parallel()/pipeline() call; script size limit. Read sandbox.ts (the WRAPPER_PREFIX Date/Math
proxies, the null-proto context, import bans, MAX_TASKS_PER_RESPONSE) AND orchestrator env / dynamic_script_workflow.py
for the concurrency + lifetime-agent caps (DYNAMIC_SCRIPT_MAX_CONCURRENCY, DYNAMIC_SCRIPT_MAX_AGENT_CALLS) AND
BFF DYNAMIC_SCRIPT_MAX_BYTES. Report: are timers/fetch/require/process truly unavailable (even if only via
ReferenceError rather than a friendly message)? What are the ACTUAL cap VALUES vs spec's 16/1000/4096, and are
value differences by-design or a gap? Is passing >4096 an explicit error (not silent truncation)?`,
  },
  {
    key: 'resume-structured-nesting',
    prompt: `DIMENSION: Resume, structured output, workflow() nesting.
Verify: (1) Resume — spec uses runId/resumeFromRunId with longest-unchanged-prefix caching; platform uses Dapr
replay (crash) + journal import (resume-after-edit). Read workflow-execution-control.ts resume branch + the
journal import. Confirm script-observable behavior: unchanged calls resolve instantly, only edited calls re-run.
(2) Structured output — schema-forced; on mismatch the model retries; bounded max retries then agent() returns
null. Read script_call_journal.py (fence-strip + jsonschema validate + retry_structured + error_max_structured_
output_retries). Confirm the retry CAP value and that exceeding it yields null to the script (spec parity).
(3) workflow() — one level only; nested workflow() throws. Confirm in sandbox.ts (nested flag) and how the
kind:'workflow' result resolves to the child returnValue (not extracted text). Classify each.`,
  },
  {
    key: 'authoring-mechanism-inventory',
    prompt: `DIMENSION: Authoring-mechanism inventory (informs the SECOND deliverable — an agent-usable way to
author syntactically-correct scripts). Inventory what EXISTS today for an agent to author + validate a script:
- MCP tools: read services/workflow-mcp-server/src/script-tools.ts + index.ts. Does run_workflow_script exist?
  Is there ANY validate/lint/spec-fetch tool? What does the tool DESCRIPTION currently tell an authoring agent
  about the primitives/dialect? (quote it)
- Evaluator endpoints: read services/script-evaluator/src/index.ts. Is there a POST /validate that returns
  {ok, meta, estimatedAgentCalls, error}? What does it check (syntax+meta, no execution)?
- Docs/skills: is there any SKILL.md or authoring guide for the JS dialect (NOT the SW-1.0 workflow-builder skill)?
- Fixtures: are scripts/fixtures/dynamic-scripts/*.js good, current exemplars an agent could pattern-match?
Report the GAP: what's missing for "give an agent a spec + a validate loop so it authors correct scripts."
Recommend the mechanism (MCP validate tool + spec-serving tool/resource, a skill, embedding the mini-spec into
the run tool description, etc.) with concrete file targets.`,
  },
]

phase('Audit')
const findings = (await parallel(
  DIMENSIONS.map((d) => () =>
    agent(COMMON + '\n\n' + d.prompt, { label: `audit:${d.key}`, phase: 'Audit', schema: FINDING_SCHEMA }),
  ),
)).filter(Boolean)

phase('Synthesize')
const SYNTH_SCHEMA = {
  type: 'object',
  required: ['alignmentVerdict', 'genuineGaps', 'docDeltas', 'authoringMechanism', 'summary'],
  additionalProperties: false,
  properties: {
    alignmentVerdict: { type: 'string', description: 'overall: is the engine script-behavior-aligned with the spec? one paragraph' },
    genuineGaps: {
      type: 'array', description: 'script-observable bugs/risks to FIX in code, most impactful first',
      items: {
        type: 'object',
        required: ['item', 'impact', 'fix', 'file', 'effort'],
        additionalProperties: false,
        properties: {
          item: { type: 'string' }, impact: { type: 'string' }, fix: { type: 'string' },
          file: { type: 'string' }, effort: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
        },
      },
    },
    docDeltas: {
      type: 'array', description: 'platform-vs-ClaudeCode differences an AUTHORING agent must know (opts vocab, budget unit, cap values, model key format, isolation/agentType meaning)',
      items: {
        type: 'object',
        required: ['topic', 'claudeCodeSays', 'platformReality', 'authoringRule'],
        additionalProperties: false,
        properties: {
          topic: { type: 'string' }, claudeCodeSays: { type: 'string' },
          platformReality: { type: 'string' }, authoringRule: { type: 'string', description: 'the concrete rule to tell an author' },
        },
      },
    },
    authoringMechanism: { type: 'string', description: 'concrete recommendation for the agent-usable authoring+validate mechanism, with file targets' },
    summary: { type: 'string' },
  },
}

const synthesis = await agent(
  `You are the synthesis lead. Below are ${findings.length} per-dimension audit reports (JSON) comparing the
workflow-builder dynamic-script engine against the Claude Code Workflow tool spec. Consolidate them.

Produce: (1) an overall alignment verdict; (2) genuineGaps = script-OBSERVABLE bugs to fix in code, ranked;
(3) docDeltas = the platform-vs-Claude-Code differences an AUTHORING agent must know (opts vocabulary, budget
unit, cap values, model-key format, isolation/agentType meaning) — each with the concrete authoring rule;
(4) authoringMechanism = a concrete recommendation for a tool/mechanism that lets an agent author
SYNTACTICALLY-CORRECT scripts (consider: an MCP validate tool calling the evaluator /validate, an MCP tool or
resource that serves the platform-dialect spec, embedding a compact spec in the run tool description, a skill),
with specific file targets in this repo.

Be decisive and concrete. Drop any finding whose evidence was "NOT FOUND" or speculative. De-duplicate.

REPORTS:
${JSON.stringify(findings, null, 2)}`,
  { label: 'synthesis', phase: 'Synthesize', schema: SYNTH_SCHEMA },
)

return { findings, synthesis }
