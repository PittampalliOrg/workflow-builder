/**
 * The `trace-deep-analysis` dynamic-script workflow — the platform analyzing
 * itself. v2 replaces the four digest-reading lens reviewers with the
 * post-mortem harness proven in docs/gan-ui-improve-run-analysis-2026-07-16.md:
 * collect-once (digest + session inventory), parallel PER-SESSION transcript
 * analysts (trace_get_llm_turn is the ground truth — digest-level review
 * misses blind grading, lost grounding, and fabricated content), adversarial
 * verification of high-severity findings, then a schema'd synthesis producing
 * a TraceAnalysisReport with ranked improvements — including complete revised
 * scripts the UI can apply after user confirmation.
 *
 * Seeded per project on first use (upsert by name, save-script semantics).
 */
import { getApplicationAdapters } from '$lib/server/application';

export const TRACE_ANALYSIS_WORKFLOW_NAME = 'trace-deep-analysis';

/** Bump when ANALYSIS_SCRIPT changes — drives the seeded-workflow upsert. */
const SCRIPT_VERSION = 'v2';

export const ANALYSIS_SCRIPT = `export const meta = {
  name: 'trace-deep-analysis',
  description: 'Trace-grounded post-mortem (${SCRIPT_VERSION}): collect-once digest + session inventory, parallel per-session transcript analysts (verbatim-quote discipline, LOGIC/QUALITY/ENVIRONMENT classification), adversarial verification of high-severity findings, and a synthesized quality report with ranked, appliable improvements.',
  phases: [
    { title: 'Collect' },
    { title: 'Analyze' },
    { title: 'Verify' },
    { title: 'Synthesize' },
  ],
  input: {
    type: 'object',
    properties: {
      executionId: { type: 'string', title: 'Execution to analyze' },
      maxSessions: { type: 'number', default: 8, title: 'Max agent sessions to deep-read (top by duration+tokens)' },
      maxVerifiers: { type: 'number', default: 3, title: 'Max adversarial verifications of high-severity findings' },
      script: { type: 'string', title: 'Target workflow source script (optional — enables kind=script improvements with a complete revisedScript)' },
      workflowName: { type: 'string', title: 'Target workflow name (optional, for the report)' },
    },
    required: ['executionId'],
  },
}

const t = args ?? {}
const target = t.executionId ? String(t.executionId) : null
if (!target) return { error: 'args.executionId is required' }
const maxSessions = Math.max(1, Math.min(16, Number(t.maxSessions ?? 8) || 8))
const maxVerifiers = Math.max(0, Math.min(6, Number(t.maxVerifiers ?? 3) || 3))
const targetScript = t.script ? String(t.script) : null
const targetWorkflow = t.workflowName ? String(t.workflowName) : 'the workflow'

const TOOLS = [
  'You have MCP trace tools for this platform:',
  '- trace_get_digest({executionId}) — status, phases, durations, tokens/cost, cache hit rate, critical path, issues.',
  '- trace_search_spans({executionId, query?, errorsOnly?, limit?}) — find spans by substring (agent sessions, tool calls, activities).',
  '- trace_get_llm_turn({executionId, sessionId|spanId}) — an agent session\\'s ACTUAL LLM input/output messages: the ground truth of what the agent saw, said, and did.',
  '- trace_get_logs({executionId, spanId?, errorsOnly?}) — correlated log lines.',
  'Analyze ONLY execution "' + target + '". EVIDENCE DISCIPLINE: every claim must cite a span/session id, a timestamp, or a VERBATIM quote from a transcript. Never infer what an agent "probably" did — read its turns.',
].join('\\n')

// ---------- Collect (once — downstream stages reuse this skeleton) ----------
phase('Collect')
const skeleton = await agent(
  'You are the trace collector. ' + TOOLS + '\\n\\nBuild the run skeleton: call trace_get_digest first, then enumerate the agent sessions (trace_search_spans for session/agent spans as needed). For each session capture: an identifying sessionId (or span id usable with trace_get_llm_turn), a human label (node label/phase if visible), wall duration seconds, total tokens if visible, and any per-session issues. Also list run-level issues and the critical path. Do NOT judge anything yet — this is inventory.',
  {
    label: 'collect',
    schema: {
      type: 'object',
      required: ['status', 'sessions', 'issues'],
      properties: {
        status: { type: 'string' },
        durationSeconds: { type: 'number' },
        totalTokens: { type: 'number' },
        criticalPath: { type: 'string' },
        sessions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['sessionId', 'label'],
            properties: {
              sessionId: { type: 'string' },
              label: { type: 'string' },
              durationSeconds: { type: 'number' },
              tokens: { type: 'number' },
              issues: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        issues: { type: 'array', items: { type: 'string' } },
      },
    },
  },
)
if (!skeleton || !Array.isArray(skeleton.sessions) || !skeleton.sessions.length) {
  return { error: 'collector produced no session inventory', skeleton }
}

// Top sessions by (duration + tokens) — budget-aware cap.
const scored = skeleton.sessions
  .map((s) => ({ s, w: (Number(s.durationSeconds) || 0) + (Number(s.tokens) || 0) / 1000 }))
  .sort((a, b) => b.w - a.w)
let cap = maxSessions
if (budget.total && budget.remaining() < cap * 40000) cap = Math.max(2, Math.floor(budget.remaining() / 40000))
const picked = scored.slice(0, cap).map((x) => x.s)
const dropped = skeleton.sessions.length - picked.length
if (dropped > 0) log('Deep-reading ' + picked.length + '/' + skeleton.sessions.length + ' sessions (top by duration+tokens; ' + dropped + ' skipped)')

// ---------- Analyze: per-session transcript analysts + a skeleton-fed cost/reliability lens ----------
phase('Analyze')
const ANALYST_SCHEMA = {
  type: 'object',
  required: ['sessionLabel', 'summary', 'whatFailed', 'quotes', 'classification', 'candidateFindings'],
  properties: {
    sessionLabel: { type: 'string' },
    summary: { type: 'string', description: 'what this agent actually did, turn by turn, and how well' },
    whatWorked: { type: 'array', items: { type: 'string' } },
    whatFailed: { type: 'array', items: { type: 'string' } },
    quotes: { type: 'array', items: { type: 'object', required: ['ref', 'text'], properties: { ref: { type: 'string' }, text: { type: 'string' }, why: { type: 'string' } } } },
    classification: { type: 'string', description: 'LOGIC (workflow design) / QUALITY (model output) / ENVIRONMENT (infra) breakdown' },
    candidateFindings: {
      type: 'array',
      description: 'findings worth surfacing run-level; severity high = would change the run outcome or invalidate its result',
      items: {
        type: 'object',
        required: ['severity', 'title', 'evidence'],
        properties: {
          severity: { type: 'string', enum: ['info', 'low', 'medium', 'high'] },
          title: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
  },
}
const analystCalls = picked.map((s) => () =>
  agent(
    'You are the transcript analyst for agent session "' + (s.label || s.sessionId) + '" (sessionId ' + s.sessionId + ') of execution ' + target + '.\\n' + TOOLS + '\\n\\nRead the session\\'s ACTUAL turns with trace_get_llm_turn (plus scoped trace_search_spans / trace_get_logs for its tool calls and errors). Reconstruct what the agent really did: did its tools work (durations? timeouts? errors?), did it see what it claimed to see, did it follow its instructions, where did its wall-time go, and is its output grounded in what it observed (quote the decisive lines VERBATIM)? Watch for: grades/claims made without observation (blind grading), fabricated-but-plausible content (paths, data), tool failures misattributed to the app/network, honest-failure reports, wasted or looping calls, and state the agent assumed but was never given. Classify each problem LOGIC vs QUALITY vs ENVIRONMENT.',
    { label: 'analyze:' + (s.label || s.sessionId).slice(0, 40), schema: ANALYST_SCHEMA },
  ),
)
const lensCall = () =>
  agent(
    'You are the cost+reliability reviewer for execution ' + target + '. Work from this collected skeleton (do NOT re-fetch the digest):\\n' + JSON.stringify(skeleton) + '\\n\\n' + TOOLS + '\\n\\nJudge: where tokens/wall-clock concentrated and whether that spend produced surviving value; triage every skeleton issue as benign vs actionable (use trace_get_logs/trace_search_spans only to settle specific questions); flag retry storms, dead waits, and cache-hostile patterns. Return candidateFindings the same way the analysts do.',
    { label: 'lens:cost+reliability', schema: ANALYST_SCHEMA },
  )
const analyses = (await parallel([...analystCalls, lensCall])).filter(Boolean)

// ---------- Verify: adversarial refuters on the high-severity findings ----------
phase('Verify')
const candidates = []
for (const a of analyses) for (const f of a.candidateFindings || []) {
  if (f.severity === 'high') candidates.push({ ...f, from: a.sessionLabel })
}
const seen = new Set()
const toVerify = candidates.filter((f) => {
  const k = (f.title || '').toLowerCase().slice(0, 60)
  if (seen.has(k)) return false
  seen.add(k)
  return true
}).slice(0, maxVerifiers)
const verdicts = (await parallel(toVerify.map((f) => () =>
  agent(
    'You are an ADVERSARIAL VERIFIER for execution ' + target + '. Try to REFUTE this finding using the trace evidence:\\nFINDING: ' + f.title + '\\nEVIDENCE OFFERED: ' + f.evidence + '\\n(from analyst of: ' + f.from + ')\\n\\n' + TOOLS + '\\n\\nRe-derive it independently: read the relevant session turns/logs yourself. If the mechanism is subtly different (e.g. a shared-resource wedge vs contention, an input typo vs a real defect, a model excuse vs an infra fault), say exactly what the evidence supports instead. Do not rubber-stamp.',
    {
      label: 'verify:' + (f.title || '').slice(0, 40),
      schema: {
        type: 'object',
        required: ['title', 'verdict', 'evidence', 'corrections'],
        properties: {
          title: { type: 'string' },
          verdict: { type: 'string', enum: ['CONFIRMED', 'REFUTED', 'CORRECTED'] },
          evidence: { type: 'string' },
          corrections: { type: 'string' },
        },
      },
    },
  ),
))).filter(Boolean)
log(verdicts.length + ' high-severity findings verified: ' + verdicts.map((v) => v.verdict).join(', '))

// ---------- Synthesize (TraceAnalysisReport-compatible) ----------
phase('Synthesize')
const corpus =
  '## Skeleton\\n' + JSON.stringify(skeleton) +
  '\\n\\n## Per-session analyses\\n' + analyses.map((a) => JSON.stringify(a)).join('\\n') +
  '\\n\\n## Adversarial verdicts on high-severity findings (REFUTED/CORRECTED verdicts OVERRIDE the original claim)\\n' + JSON.stringify(verdicts)
const scriptSection = targetScript
  ? '\\n\\nThe target workflow\\'s SOURCE SCRIPT (dynamic-script dialect):\\n\`\`\`js\\n' + targetScript + '\\n\`\`\`\\nWhere an improvement is a SCRIPT change, set kind="script" and include the COMPLETE revised script in revisedScript. Otherwise revisedScript=null.'
  : ''
const report = await agent(
  'You are the lead analyst. Synthesize ONE quality report for execution "' + target + '" of workflow "' + targetWorkflow + '" from the material below. Findings must survive the adversarial verdicts (drop or rewrite anything REFUTED/CORRECTED). Keep only evidence-cited findings; put verbatim quotes in evidence[]. healthScore 0-100 judges the RUN (fast, cheap, reliable, output genuinely grounded + correct) — a run whose output LOOKS good but is ungrounded scores low. Rank improvements by impact; each must be concrete enough to act on.\\n\\n' + corpus + scriptSection,
  {
    label: 'synthesis',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'healthScore', 'findings', 'improvements'],
      properties: {
        summary: { type: 'string' },
        healthScore: { type: 'integer', minimum: 0, maximum: 100 },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['lens', 'severity', 'title', 'detail', 'evidence'],
            properties: {
              lens: { type: 'string', enum: ['performance', 'cost', 'reliability', 'quality'] },
              severity: { type: 'string', enum: ['info', 'low', 'medium', 'high'] },
              title: { type: 'string' },
              detail: { type: 'string' },
              evidence: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        improvements: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'rationale', 'impact', 'kind', 'revisedScript'],
            properties: {
              title: { type: 'string' },
              rationale: { type: 'string' },
              impact: { type: 'string', enum: ['high', 'medium', 'low'] },
              kind: { type: 'string', enum: ['script', 'config', 'suggestion'] },
              revisedScript: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
  },
)
if (!report) return { error: 'synthesis failed', skeleton, analyses, verdicts }
log('Health ' + report.healthScore + '/100 — ' + report.findings.length + ' findings, ' + report.improvements.length + ' improvements, ' + verdicts.length + ' verified')
return { ...report, verifiedFindings: verdicts, sessionsAnalyzed: picked.length, sessionsTotal: skeleton.sessions.length }
`;

/**
 * Upsert the per-project analysis workflow (save-script semantics) and return
 * its id. Re-seeds only when the embedded script text changed (SCRIPT_VERSION).
 */
export async function ensureTraceAnalysisWorkflow(input: {
	userId: string;
	projectId: string;
}): Promise<{ workflowId: string } | { error: string }> {
	const app = getApplicationAdapters();
	const spec = { engine: 'dynamic-script', script: ANALYSIS_SCRIPT, meta: {} };

	const existing = (await app.workflowData.getWorkflowByRef({
		workflowName: TRACE_ANALYSIS_WORKFLOW_NAME,
		lookup: 'name'
	})) as {
		id: string;
		engineType?: string | null;
		projectId?: string | null;
		spec?: { script?: unknown } | null;
	} | null;

	if (
		existing &&
		existing.engineType === 'dynamic-script' &&
		existing.projectId === input.projectId
	) {
		if (existing.spec?.script === ANALYSIS_SCRIPT) {
			return { workflowId: existing.id };
		}
		const updated = await app.workflowDefinitionCommands.updateWorkflow({
			workflowId: existing.id,
			body: { name: TRACE_ANALYSIS_WORKFLOW_NAME, engineType: 'dynamic-script', spec }
		});
		if (updated.status === 'error') {
			return {
				error: typeof updated.body === 'string' ? updated.body : JSON.stringify(updated.body)
			};
		}
		return { workflowId: existing.id };
	}

	const created = await app.workflowDefinitionCommands.createWorkflow({
		body: {
			name: TRACE_ANALYSIS_WORKFLOW_NAME,
			nodes: [],
			edges: [],
			engineType: 'dynamic-script',
			spec
		},
		userId: input.userId,
		projectId: input.projectId
	});
	if (created.status === 'error') {
		return {
			error: typeof created.body === 'string' ? created.body : JSON.stringify(created.body)
		};
	}
	return { workflowId: (created.body as { id: string }).id };
}
