import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

// ---------------------------------------------------------------------------
// POST /api/workflows/executions/[executionId]/analyst-session
//
// Start an interactive Kimi K3 TRACE-ANALYST session bound to one execution.
// The agent investigates via the trace_* MCP tools (digest → targeted span/
// LLM-turn/log reads) instead of receiving a trace dump, and cites evidence
// with [call:<callId>] / [session:<sessionId>] / [span:<spanId>] tokens the
// run-view renders as clickable chips. Mirrors the author-session pattern
// (per-project agent, experiment-config persona pinning, X-Wfb-Session-Id
// scoping of the MCP tools).
// ---------------------------------------------------------------------------

const ANALYST_SLUG = 'trace-analyst';
const WORKFLOW_MCP_URL =
	process.env.WORKFLOW_MCP_SERVER_URL ??
	'http://workflow-mcp-server.workflow-builder.svc.cluster.local:3200/mcp';

function analystSystemPrompt(executionId: string, workflowName: string | null): string {
	return [
		'You are the trace analyst embedded in the workflow run page. You explain what',
		`happened in workflow execution "${executionId}"${workflowName ? ` (workflow "${workflowName}")` : ''} using its OpenTelemetry trace.`,
		'',
		'Method — investigate, never guess:',
		`1. ALWAYS start with trace_get_digest(executionId: "${executionId}") — status, phases,`,
		'   durations, tokens/cost, cache hit, critical path, budget, and the issues list.',
		'2. Drill only where the question needs it: trace_search_spans (errorsOnly for',
		'   failures), trace_get_llm_turn (what an agent was asked / replied — by spanId or',
		'   the call\'s child sessionId from the digest), trace_get_logs.',
		`3. Only analyze THIS execution ("${executionId}"). Refuse other execution ids.`,
		'',
		'Answer style: lead with the answer in 1-3 sentences, then the evidence.',
		'',
		'CITATIONS ARE MANDATORY — every answer MUST contain at least one inline',
		'citation token; the UI turns them into clickable chips that highlight the',
		'graph. Emit the token EXACTLY in this bracket form (not backticks, not prose):',
		'  [call:<callId>]       — a script call (callIds come from the digest)',
		'  [session:<sessionId>]  — an agent child session (sessionIds come from the digest)',
		'  [span:<spanId>]        — a specific span',
		'Example: "The judge dominated wall clock at 68s [session:dsw-example__run__0]."',
		'Numbers matter: quote durations, token counts, and costs exactly as the tools',
		'report them. If the data does not support an answer, say so.'
	].join('\n');
}

function analystConfig(executionId: string, workflowName: string | null) {
	return {
		model: 'kimi/kimi-k3',
		modelSpec: 'kimi/kimi-k3',
		reasoningEffort: 'max',
		contextWindowTokens: 1_048_576,
		runtime: 'dapr-agent-py',
		maxTurns: 40,
		timeoutMinutes: 60,
		tools: [],
		skills: [],
		systemPrompt: analystSystemPrompt(executionId, workflowName),
		mcpServers: [
			{
				url: WORKFLOW_MCP_URL,
				name: 'trace-analysis',
				transport: 'streamable_http'
			}
		]
	};
}

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const userId = locals.session.userId;
	const projectId = locals.session.projectId ?? null;
	if (!projectId) return error(400, 'No active project');

	const app = getApplicationAdapters();
	// Scope check: the execution must be visible in the caller's workspace.
	const context = await app.workflowData.getObservabilityServiceGraphContext({
		userId,
		projectId,
		executionId: params.executionId
	});
	if (!context?.execution) return error(404, 'Execution not found');
	const workflowName = null;

	let agentId: string | null = null;
	try {
		const existing = (
			await app.agentCatalog.listAgents({
				query: { projectId, q: ANALYST_SLUG },
				currentProjectId: projectId
			})
		).find((agent) => agent.slug === ANALYST_SLUG);
		agentId = existing?.id ?? null;
	} catch (err) {
		console.error('[analyst-session] agent lookup failed:', err);
	}

	if (!agentId) {
		const created = await app.agentCatalog.createAgent({
			userId,
			currentProjectId: projectId,
			body: {
				name: 'Trace Analyst (Kimi K3)',
				slug: ANALYST_SLUG,
				description:
					'Explains workflow runs from their OpenTelemetry traces via the trace_* MCP tools.',
				runtime: 'dapr-agent-py',
				tags: ['trace-analyst'],
				projectId,
				config: analystConfig(params.executionId, workflowName)
			}
		});
		if (created.status === 'invalid') return error(400, created.message);
		agentId = created.agent.id;
	}

	const result = await app.sessionCommands.createInteractiveSession({
		userId,
		projectId,
		body: {
			agentId,
			agentConfig: analystConfig(params.executionId, workflowName),
			title: `Analyst · ${params.executionId.slice(0, 8)}`,
			initialMessage: `Analyze workflow execution "${params.executionId}". Start with trace_get_digest, then give me a crisp summary of what happened (phases, timing, cost) and flag anything unusual — with citations.`
		}
	});

	switch (result.status) {
		case 'created':
			return json({ sessionId: result.session.id, agentId }, { status: 201 });
		case 'precondition_failed':
			return json({ code: result.code, message: result.message }, { status: 412 });
		case 'not_found':
			return error(404, result.message);
		case 'conflict':
			return error(409, result.message);
		case 'invalid':
			return error(400, result.message);
	}
};
