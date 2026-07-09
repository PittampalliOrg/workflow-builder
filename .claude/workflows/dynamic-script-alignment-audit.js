export const meta = {
  name: 'dynamic-script-alignment-audit',
  description: 'Audit the workflow-builder dynamic-script engine against the Claude Code Workflow tool spec, dimension by dimension, with adversarial verification of claimed gaps',
  phases: [
    { title: 'Audit', detail: 'one auditor per spec dimension + whole-spec sweep' },
    { title: 'Verify', detail: 'adversarially verify each claimed divergence/missing item' },
  ],
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/dynamic-script-engine'
const SPEC = REPO + '/docs/claude-code-workflow-tool-spec.md'
const STACKS = '/home/vpittamp/repos/PittampalliOrg/stacks/main'

const FINDINGS = {
  type: 'object',
  required: ['dimension', 'aligned', 'divergent', 'missing', 'authoringNotes'],
  additionalProperties: false,
  properties: {
    dimension: { type: 'string' },
    aligned: { type: 'array', items: { type: 'object', required: ['item', 'evidence'], additionalProperties: false, properties: {
      item: { type: 'string', description: 'spec behavior that our implementation matches' },
      evidence: { type: 'string', description: 'file:line citations proving it' },
    } } },
    divergent: { type: 'array', items: { type: 'object', required: ['item', 'spec', 'ours', 'evidence', 'likelyIntentional'], additionalProperties: false, properties: {
      item: { type: 'string' },
      spec: { type: 'string', description: 'what the Claude Code spec says' },
      ours: { type: 'string', description: 'what our implementation does instead' },
      evidence: { type: 'string', description: 'file:line citations' },
      likelyIntentional: { type: 'boolean', description: 'true if this looks like a deliberate platform adaptation rather than a bug' },
    } } },
    missing: { type: 'array', items: { type: 'object', required: ['item', 'spec', 'impact'], additionalProperties: false, properties: {
      item: { type: 'string' },
      spec: { type: 'string' },
      impact: { type: 'string', description: 'what breaks or confuses a script author because of the absence' },
    } } },
    authoringNotes: { type: 'array', items: { type: 'string' }, description: 'facts a script AUTHOR must be told about this dimension on OUR platform (exact semantics, keys, limits, error strings)' },
  },
}

const VERDICT = {
  type: 'object',
  required: ['verdict', 'reason'],
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['CONFIRMED', 'REFUTED', 'PARTIAL'] },
    reason: { type: 'string' },
    correction: { type: 'string', description: 'if REFUTED or PARTIAL, the accurate statement with file:line evidence' },
  },
}

const COMMON = `You are auditing the workflow-builder "dynamic-script" engine — a reimplementation of Claude Code's internal Workflow tool on Dapr — for alignment with the authoritative spec.

STEP 1: Read the spec at ${SPEC} (the verbatim Claude Code Workflow tool contract).
STEP 2: Read the implementation files listed below (repo root ${REPO}).
STEP 3: Compare ONLY your assigned focus areas. For every point: classify as aligned / divergent / missing, with file:line evidence. Author-visible DIALECT semantics (what someone writing a script experiences) matter most; infra internals only matter where they change author-visible behavior. Platform adaptations that are deliberate (different model keys, env-tunable caps, Dapr instead of in-process) should be marked divergent with likelyIntentional=true, NOT missing.
STEP 4: Fill authoringNotes with the exact facts a script author on OUR platform needs (semantics, opts keys, limits with actual values, error behaviors). Be precise — these seed an authoring guide.

Be exhaustive within your focus. Do not speculate: every claim needs code evidence. Return ONLY the structured object.`

const DIMENSIONS = [
  {
    key: 'sandbox-dialect',
    focus: `The script dialect as executed by the vm sandbox: the required "export const meta" block (which fields required? pure-literal enforced? phases matching?); presence and exact signatures of agent()/parallel()/pipeline()/phase()/log()/workflow() and globals args/budget; pipeline stage callbacks receiving (prevResult, originalItem, index); pipeline stage throw -> item null + remaining stages skipped; parallel is a barrier, thunk throw -> null in results, call never rejects; plain JS not TS; top-level await; determinism bans (Date.now, Math.random, zero-arg new Date, timers) and what error the author sees; no fs/node/fetch/import; the 4096 items-per-call guard; orphan pending handling; deadlock classification.`,
    files: ['services/script-evaluator/src/sandbox.ts', 'services/script-evaluator/src/sandbox.test.ts', 'services/script-evaluator/src/index.ts', 'services/script-evaluator/src/conformance.test.ts'],
  },
  {
    key: 'agent-opts-dispatch',
    focus: `agent(prompt, opts) option handling end-to-end: which of {label, phase, schema, model, effort, isolation, agentType} are honored, how each maps to platform dispatch (model->modelSpec+model stamping, agentType->runtime/agent resolution, isolation->workspaceRef, effort->?), which are accepted-but-ignored and whether the author is warned; agent() returning final text without schema / validated object with schema / null on skip or terminal death; default model inheritance (DYNAMIC_SCRIPT_DEFAULT_MODEL, dapr-agent-py only); callId derivation including which opts participate in the hash.`,
    files: ['services/workflow-orchestrator/workflows/script_agent_dispatch.py', 'services/script-evaluator/src/call-id.ts', 'services/shared/contracts/script-evaluator-evaluate.contract.json', 'services/workflow-orchestrator/workflows/dynamic_script_workflow.py'],
  },
  {
    key: 'budget',
    focus: `The budget global: budget.total (null when unset), budget.spent(), budget.remaining() returning Infinity with no target; HARD ceiling — agent() throws once spent >= total (what error class/message?); in-flight children still complete and count (overshoot by design); what "tokens" means on our platform (goal-loop net-of-cache formula: input+output+cache_creation) vs the spec's "output tokens this turn"; whether the pool is shared across nested workflow() children; the usage-settle timer; how budgetTotal enters (MCP tool, execute API, UI).`,
    files: ['services/script-evaluator/src/sandbox.ts', 'services/workflow-orchestrator/workflows/dynamic_script_workflow.py', 'services/workflow-orchestrator/activities/aggregate_script_usage.py', 'src/lib/server/goals/goal-loop.ts', 'src/lib/server/application/adapters/dapr.ts'],
  },
  {
    key: 'nesting-workflow-fn',
    focus: `workflow(nameOrRef, args): saved-name resolution (our platform resolves saved dynamic-script workflow rows — confirm exact lookup semantics and error on unknown name); {scriptPath} support or its absence; one-level-only nesting enforcement (where enforced, what the author sees); child sharing the parent's budget/limits/agent counter; the child's returnValue becoming the parent's workflow() result (the workflow-kind journal branch); args passed to the child as its args global.`,
    files: ['services/script-evaluator/src/sandbox.ts', 'services/workflow-orchestrator/workflows/dynamic_script_workflow.py', 'services/workflow-orchestrator/workflows/script_agent_dispatch.py', 'services/workflow-orchestrator/activities/resolve_script_workflow.py', 'services/workflow-orchestrator/activities/script_call_journal.py', 'services/workflow-orchestrator/tests/test_script_call_journal.py'],
  },
  {
    key: 'caps-limits',
    focus: `All numeric limits vs the spec: concurrent agent cap (spec min(16, cores-2), queue-not-fail — ours DYNAMIC_SCRIPT_MAX_CONCURRENCY; confirm queuing behavior), lifetime agent cap (spec 1000 — ours DYNAMIC_SCRIPT_MAX_AGENT_CALLS; what happens at the cap), 4096 items per parallel()/pipeline() call (explicit error not truncation), script byte size (spec tool param 524288 — ours SCRIPT_MAX_BYTES/DYNAMIC_SCRIPT_MAX_BYTES), evaluator deadline, structured-retry max. Report the ACTUAL deployed env values from the stacks manifests at ${STACKS}/packages/components/workloads/workflow-builder/manifests/ (Deployment-workflow-orchestrator.yaml, Deployment-workflow-builder.yaml, Deployment-script-evaluator.yaml).`,
    files: ['services/script-evaluator/src/index.ts', 'services/script-evaluator/src/sandbox.ts', 'services/workflow-orchestrator/workflows/dynamic_script_workflow.py', 'src/lib/server/workflows/dynamic-script-validation.ts'],
  },
  {
    key: 'structured-output',
    focus: `Schema-forced output: spec = subagent forced to call a StructuredOutput tool, validation at the tool-call layer, model retries on mismatch, agent() returns the validated object. Ours = prompt output-contract block + jsonschema validation in record_script_call_result + bounded corrective retry sessions (__r<N>) up to 5 -> error_max_structured_output_retries -> agent() returns null. Verify each step: how the schema reaches the agent prompt, fence-stripping/JSON extraction rules, the retry decision + feedback content, the cap, and what the script author observes in each case.`,
    files: ['services/workflow-orchestrator/activities/script_call_journal.py', 'services/workflow-orchestrator/workflows/script_agent_dispatch.py', 'services/workflow-orchestrator/workflows/dynamic_script_workflow.py', 'services/workflow-orchestrator/tests/test_script_call_journal.py'],
  },
  {
    key: 'resume-skip-control',
    focus: `Run control vs the spec Resume section: our resume-after-edit = fresh execution importing done journal rows (longest-unchanged-prefix cache; unchanged callIds resolve with zero new sessions) vs spec resumeFromRunId; which row statuses import (done only? skipped/error dropped?); per-call skip via script.call.control -> journal skipped -> script sees null; cancel via workflow.cancel; stop via Lifecycle Controller; determinism bans as the enabler. Confirm each in code, including the user-facing routes.`,
    files: ['src/lib/server/workflows/workflow-execution-control.ts', 'src/routes/api/workflows/executions/[executionId]/script-calls/[callId]/skip/+server.ts', 'src/routes/api/internal/workflows/executions/[executionId]/script-calls/import/+server.ts', 'services/workflow-orchestrator/workflows/dynamic_script_workflow.py', 'services/workflow-orchestrator/tests/test_dynamic_script_workflow.py'],
  },
  {
    key: 'authoring-surface',
    focus: `The AUTHORING experience vs the spec's own self-describing contract. The Claude Code Workflow tool teaches its dialect through its tool description (the whole spec doc). Audit what OUR authoring surfaces teach: the run_workflow_script MCP tool description + input schema descriptions (services/workflow-mcp-server/src/script-tools.ts); the BFF validation errors an author sees for common mistakes — TS syntax, missing meta, non-literal meta, Date.now, oversized script, bad nesting (src/lib/server/workflows/dynamic-script-validation.ts + the evaluator /validate handler in services/script-evaluator/src/index.ts and sandbox.ts); the execute-script internal route; the fixtures as examples (scripts/fixtures/dynamic-scripts/). Enumerate precisely which spec facts an authoring agent CANNOT currently learn from these surfaces (meta requirements, opts semantics, determinism bans, caps, budget behavior, pipeline-vs-parallel guidance, patterns). This dimension seeds the design of a spec-guidance tool.`,
    files: ['services/workflow-mcp-server/src/script-tools.ts', 'src/lib/server/workflows/dynamic-script-validation.ts', 'services/script-evaluator/src/index.ts', 'src/routes/api/internal/agent/workflows/execute-script/+server.ts', 'scripts/fixtures/dynamic-scripts/demo-review.js', 'scripts/fixtures/dynamic-scripts/audit-fanout.js'],
  },
  {
    key: 'spec-sweep',
    noVerify: true,
    focus: `Coverage sweep: read ONLY the spec at ${SPEC} end to end and enumerate EVERY author-visible contract point (each primitive behavior, each opts key, each limit, each error semantic, each pattern, the meta rules, the resume rules). Do NOT read implementation code. Output every contract point as an authoringNotes entry (one per line, terse). Put nothing in aligned/divergent/missing (empty arrays) — this list is used to cross-check that the other auditors covered the whole spec.`,
    files: [],
  },
]

phase('Audit')
const results = await pipeline(
  DIMENSIONS,
  (d) => agent(
    COMMON + '\n\nDIMENSION: ' + d.key + '\nFOCUS: ' + d.focus + (d.files.length ? '\nFILES (relative to ' + REPO + '):\n' + d.files.map((f) => '- ' + f).join('\n') : ''),
    { label: 'audit:' + d.key, phase: 'Audit', schema: FINDINGS },
  ),
  (findings, d) => {
    if (!findings) return null
    if (d.noVerify) return { key: d.key, findings, verdicts: [] }
    const claims = [
      ...(findings.divergent || []).map((c) => ({ type: 'divergent', claim: c })),
      ...(findings.missing || []).map((c) => ({ type: 'missing', claim: c })),
    ]
    if (!claims.length) return { key: d.key, findings, verdicts: [] }
    return parallel(claims.map((cl) => () =>
      agent(
        `Adversarially verify this audit claim about the workflow-builder dynamic-script engine (repo ${REPO}, spec ${SPEC}). Read the actual code cited (and neighboring code) and try to REFUTE it.\n\nClaim type: ${cl.type}\nClaim: ${JSON.stringify(cl.claim)}\n\nCONFIRMED only if the code genuinely behaves as claimed. REFUTED if the code contradicts it (give the correction with file:line). PARTIAL if directionally right but materially imprecise (give the precise version). If you cannot find concrete evidence supporting the claim, it is REFUTED.`,
        { label: 'verify:' + d.key, phase: 'Verify', schema: VERDICT },
      ).then((v) => ({ type: cl.type, item: cl.claim.item, verdict: v }))
    )).then((verdicts) => ({ key: d.key, findings, verdicts: verdicts.filter(Boolean) }))
  },
)

return { results: results.filter(Boolean) }