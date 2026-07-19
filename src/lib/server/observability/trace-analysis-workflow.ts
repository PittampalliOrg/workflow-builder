/**
 * The `trace-deep-analysis` dynamic-script workflow — the platform analyzing
 * itself. v2 replaces the four digest-reading lens reviewers with the
 * post-mortem harness: collect a run skeleton once, deep-read a bounded set of
 * session transcripts in parallel. trace_get_llm_turn is the ground truth;
 * digest-level review misses blind grading, lost grounding, and fabricated
 * content. Adversarial
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
    additionalProperties: false,
    properties: {
      executionId: { type: 'string', title: 'Execution to analyze' },
      maxSessions: { type: 'integer', minimum: 1, maximum: 16, default: 8, title: 'Max agent sessions to deep-read (top by duration+tokens)' },
      maxVerifiers: { type: 'integer', minimum: 0, maximum: 6, default: 3, title: 'Max adversarial verifications of high-severity findings' },
      script: { type: 'string', title: 'Target workflow source script (optional — enables kind=script improvements with a complete revisedScript)' },
      workflowName: { type: 'string', title: 'Target workflow name (optional, for the report)' },
    },
    required: ['executionId'],
  },
}

const t = args ?? {}
const target = t.executionId ? String(t.executionId) : null
if (!target) return { error: 'args.executionId is required' }
const requestedSessions = Number(t.maxSessions ?? 8)
const requestedVerifiers = Number(t.maxVerifiers ?? 3)
const maxSessions = Number.isFinite(requestedSessions) ? Math.max(1, Math.min(16, Math.floor(requestedSessions))) : 8
const maxVerifiers = Number.isFinite(requestedVerifiers) ? Math.max(0, Math.min(6, Math.floor(requestedVerifiers))) : 3
const targetScript = t.script ? String(t.script) : null
const targetWorkflow = t.workflowName ? String(t.workflowName) : 'the workflow'

const TOOLS = [
  'You have MCP trace tools for this platform:',
  '- debug_workflow_execution({executionId}) — bounded run state, failure evidence, and browser screenshot storage refs.',
  '- trace_get_digest({executionId}) — status, phases, durations, tokens/cost, cache hit rate, critical path, issues.',
  '- trace_search_spans({executionId, query?, errorsOnly?, limit?}) — find spans by substring (agent sessions, tool calls, activities).',
  '- trace_get_span({executionId, spanId}) — exact bounded tool/MCP/runtime span attributes and input/output evidence.',
  '- trace_get_llm_turn({executionId, sessionId|spanId}) — an agent session\\'s ACTUAL LLM input/output messages: the ground truth of what the agent saw, said, and did.',
  '- trace_get_logs({executionId, spanId?, errorsOnly?}) — correlated log lines.',
  '- trace_get_browser_screenshot({executionId, storageRef}) — captured browser pixels; use a storageRef from debug_workflow_execution when visual claims matter.',
  'Analyze ONLY execution "' + target + '". EVIDENCE DISCIPLINE: every claim must cite a span/session id, a timestamp, or a VERBATIM quote from a transcript. Never infer what an agent "probably" did — read its turns.',
].join('\\n')

// ---------- Collect (once — downstream stages reuse this skeleton) ----------
phase('Collect')
const skeleton = await agent(
  'You are the trace collector. ' + TOOLS + '\\n\\nBuild the run skeleton: call debug_workflow_execution first to inventory persisted state and browser screenshot refs, then call trace_get_digest and enumerate agent sessions with trace_search_spans. For each session capture selectorType="session" with its session id when available; otherwise selectorType="span" with a span id that trace_get_llm_turn can resolve. Also capture a human label, wall duration seconds, total tokens, and per-session issues. Capture only real kind="screenshot" assets as screenshots. List run-level issues and the critical path. Do NOT judge anything yet. Use 0, an empty string, or an empty array for unavailable values; never invent them.',
  {
    label: 'collect',
    model: 'kimi/kimi-k3',
    effort: 'max',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'durationSeconds', 'totalTokens', 'criticalPath', 'sessions', 'screenshots', 'issues'],
      properties: {
        status: { type: 'string' },
        durationSeconds: { type: 'number' },
        totalTokens: { type: 'number' },
        criticalPath: { type: 'string' },
        sessions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['selectorType', 'selectorId', 'label', 'durationSeconds', 'tokens', 'issues'],
            properties: {
              selectorType: { type: 'string', enum: ['session', 'span'] },
              selectorId: { type: 'string' },
              label: { type: 'string' },
              durationSeconds: { type: 'number' },
              tokens: { type: 'number' },
              issues: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        screenshots: {
          type: 'array',
          maxItems: 8,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['storageRef', 'label'],
            properties: {
              storageRef: { type: 'string' },
              label: { type: 'string' },
            },
          },
        },
        issues: { type: 'array', items: { type: 'string' } },
      },
    },
  },
)
if (!skeleton || !Array.isArray(skeleton.sessions)) {
  return { error: 'collector failed to produce a run skeleton', skeleton }
}

// Top sessions by (duration + tokens) — budget-aware cap.
const scored = skeleton.sessions
  .map((s) => ({ s, w: (Number(s.durationSeconds) || 0) + (Number(s.tokens) || 0) / 1000 }))
  .sort((a, b) => b.w - a.w)
let cap = maxSessions
const selectedScreenshots = (skeleton.screenshots || []).slice(0, 4)
const COLLECTOR_RESERVE = 40000
const TRANSCRIPT_RESERVE = 40000
const LENS_RESERVE = 40000
const VISUAL_RESERVE = selectedScreenshots.length ? 40000 : 0
const VERIFIER_RESERVE = 30000
const SYNTHESIS_RESERVE = 70000
const mandatoryReserve = COLLECTOR_RESERVE + LENS_RESERVE + VISUAL_RESERVE + maxVerifiers * VERIFIER_RESERVE + SYNTHESIS_RESERVE
if (budget.total) cap = Math.min(cap, Math.max(0, Math.floor((budget.total - mandatoryReserve) / TRANSCRIPT_RESERVE)))
const picked = scored.slice(0, cap).map((x) => x.s)
const dropped = skeleton.sessions.length - picked.length
if (dropped > 0) log('Deep-reading ' + picked.length + '/' + skeleton.sessions.length + ' sessions (top by duration+tokens; ' + dropped + ' skipped)')

// ---------- Analyze: per-session transcript analysts + a skeleton-fed cost/reliability lens ----------
phase('Analyze')
const ANALYST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sessionLabel', 'summary', 'whatWorked', 'whatFailed', 'quotes', 'classification', 'candidateFindings'],
  properties: {
    sessionLabel: { type: 'string' },
    summary: { type: 'string', description: 'what this agent actually did, turn by turn, and how well' },
    whatWorked: { type: 'array', items: { type: 'string' } },
    whatFailed: { type: 'array', items: { type: 'string' } },
    quotes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'text', 'why'],
        properties: {
          ref: { type: 'string' },
          text: { type: 'string' },
          why: { type: 'string' },
        },
      },
    },
    classification: { type: 'string', description: 'LOGIC (workflow design) / QUALITY (model output) / ENVIRONMENT (infra) breakdown' },
    candidateFindings: {
      type: 'array',
      description: 'findings worth surfacing run-level; severity high = would change the run outcome or invalidate its result',
      items: {
        type: 'object',
        additionalProperties: false,
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
	    'You are the transcript analyst for agent session "' + (s.label || s.selectorId) + '" (' + s.selectorType + ' selector ' + s.selectorId + ') of execution ' + target + '.\\n' + TOOLS + '\\n\\nRead the session\\'s ACTUAL turns with trace_get_llm_turn: pass sessionId when selectorType is session, or spanId when selectorType is span. Use scoped trace_search_spans, trace_get_span, and trace_get_logs for its tool calls and errors. Available browser screenshot refs: ' + JSON.stringify(selectedScreenshots) + '. For browser or UI claims, call trace_get_browser_screenshot for the relevant ref and inspect its pixels rather than trusting a textual claim. Reconstruct what the agent really did: did its tools work (durations? timeouts? errors?), did it see what it claimed to see, did it follow its instructions, where did its wall-time go, and is its output grounded in what it observed (quote the decisive lines VERBATIM)? Watch for grades or claims made without observation, fabricated-but-plausible content, tool failures misattributed to the app or network, honest-failure reports, wasted or looping calls, and state the agent assumed but was never given. Classify each problem LOGIC vs QUALITY vs ENVIRONMENT.',
    {
      label: 'analyze:' + (s.label || s.selectorId).slice(0, 40),
      model: 'kimi/kimi-k3',
      effort: 'max',
      schema: ANALYST_SCHEMA,
    },
  ),
)
const lensCall = () =>
  agent(
    'You are the run-level cost+reliability reviewer for execution ' + target + '. Work from this collected skeleton (do NOT re-fetch the digest):\\n' + JSON.stringify(skeleton) + '\\n\\n' + TOOLS + '\\n\\nJudge where tokens and wall-clock concentrated and whether that spend produced surviving value; triage every skeleton issue as benign vs actionable; use trace_get_logs or trace_search_spans only to settle specific questions; flag retry storms, dead waits, and cache-hostile patterns. Return the analyst schema with sessionLabel="run-level", empty quotes when none are needed, and candidateFindings supported by concrete evidence.',
    {
      label: 'lens:cost+reliability',
      model: 'kimi/kimi-k3',
      effort: 'max',
      schema: ANALYST_SCHEMA,
    },
  )
const visualCall = selectedScreenshots.length ? () =>
  agent(
    'You are the browser-vision reviewer for execution ' + target + '. ' + TOOLS + '\\n\\nInspect each of these captured screenshots with trace_get_browser_screenshot: ' + JSON.stringify(selectedScreenshots) + '. Judge only what the pixels establish: visible failures, incomplete rendering, layout problems, and whether transcript claims match the UI. Return the analyst schema with sessionLabel="browser-vision". Put storage refs in quote ref fields; never claim pixels you did not inspect.',
    {
      label: 'analyze:browser-vision',
      model: 'kimi/kimi-k3',
      effort: 'max',
      schema: ANALYST_SCHEMA,
    },
  ) : null
const analyses = (await parallel([
  ...analystCalls,
  lensCall,
  ...(visualCall ? [visualCall] : []),
])).filter(Boolean)

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
const verifierCalls = toVerify.map((f) => () =>
  agent(
    'You are an ADVERSARIAL VERIFIER for execution ' + target + '. Try to REFUTE this finding using the trace evidence:\\nFINDING: ' + f.title + '\\nEVIDENCE OFFERED: ' + f.evidence + '\\n(from analyst of: ' + f.from + ')\\n\\n' + TOOLS + '\\n\\nRe-derive it independently: read the relevant session turns/logs yourself. If the mechanism is subtly different (e.g. a shared-resource wedge vs contention, an input typo vs a real defect, a model excuse vs an infra fault), say exactly what the evidence supports instead. Do not rubber-stamp.',
    {
      label: 'verify:' + (f.title || '').slice(0, 40),
      model: 'kimi/kimi-k3',
      effort: 'max',
      schema: {
        type: 'object',
        additionalProperties: false,
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
)
const verdicts = verifierCalls.length ? (await parallel(verifierCalls)).filter(Boolean) : []
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
    model: 'kimi/kimi-k3',
    effort: 'max',
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

	const existing = (await app.workflowData.getScopedWorkflowByName({
		workflowName: TRACE_ANALYSIS_WORKFLOW_NAME,
		userId: input.userId,
		projectId: input.projectId
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
