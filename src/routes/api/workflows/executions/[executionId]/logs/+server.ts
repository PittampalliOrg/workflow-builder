import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { extractExecutionTraceIds } from '$lib/server/otel/clickhouse';
import { isResourceInScope } from '$lib/server/workflows/project-scope';

export interface NormalizedLog {
	stepName: string;
	label: string;
	actionType: string;
	status: 'success' | 'error' | 'running' | 'pending' | 'unknown';
	input: unknown;
	output: unknown;
	error: string | null;
	durationMs: number | null;
}

/**
 * GET /api/workflows/executions/[executionId]/logs
 *
 * Returns normalized per-step logs for the execution.
 * Sources: workflowExecutionLogs table, then falls back to output.outputs from the execution record.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const { executionId } = params;
	const workflowData = getApplicationAdapters().workflowData;

	// Fetch the execution record
	const execution = await workflowData.getExecutionById(executionId);

	if (!execution) {
		return error(404, 'Execution not found');
	}

	// CMA scoping: return 404 when the caller's active workspace doesn't own
	// this execution. Pre-CMA rows (null project_id) fall back to ownership.
	if (
		locals.session?.userId &&
		!isResourceInScope(
			{ projectId: execution.projectId ?? null, userId: execution.userId },
			locals.session
		)
	) {
		return error(404, 'Execution not found');
	}

	// Try workflowExecutionLogs table first
	const dbLogs = await workflowData.listExecutionLogs(executionId);

	let logs: NormalizedLog[];

	if (dbLogs.length > 0) {
		logs = dbLogs.map((log) => ({
			stepName: log.nodeId,
			label: log.nodeName,
			actionType: log.activityName ?? log.nodeType,
			status: log.status === 'success' || log.status === 'error' || log.status === 'running' || log.status === 'pending'
				? log.status
				: 'unknown',
			input: log.input,
			output: log.output,
			error: log.error,
			durationMs: log.duration ? parseInt(log.duration, 10) : null
		}));
	} else {
		// Fallback: parse from execution output.outputs
		const execOutput = execution.output as Record<string, unknown> | null;
		const stepOutputs = execOutput?.outputs as Record<string, unknown> | undefined;

		logs = stepOutputs
			? Object.entries(stepOutputs).map(([name, val]) => {
					const v = val as Record<string, unknown>;
					const d = v.data as Record<string, unknown> | undefined;
					return {
						stepName: name,
						label: (v.label as string) || name,
						actionType: (v.actionType as string) || '',
						status: (d?.success === false || d?.error
							? 'error'
							: d?.success === true
								? 'success'
								: 'unknown') as NormalizedLog['status'],
						input: d?.input ?? null,
						output: d?.output ?? d ?? null,
						error: (d?.error as string) ?? null,
						durationMs: (d?.duration_ms as number) ?? null
					};
				})
			: [];
	}

	// Deduplicate by stepName (keep first occurrence)
	const seen = new Set<string>();
	logs = logs.filter((log) => {
		if (seen.has(log.stepName)) return false;
		seen.add(log.stepName);
		return true;
	});

	// Filter out virtual steps (trigger, state) that aren't real workflow nodes
	logs = logs.filter((log) => !['trigger', 'state'].includes(log.stepName));

	// Extract all traceIds from output (recursive extraction like Next.js app)
	const execOutput = execution.output as Record<string, unknown> | null;
	const traceId = (execOutput?.traceId as string) ?? null;
	const allTraceIds = extractExecutionTraceIds(execution.output);

	// Phase 4 Step 2: agent events come from session_events via the
	// sessions.workflow_execution_id join. `durable/run` nodes now spawn a
	// session per node and that session's event stream is the authoritative
	// agent log.
	const agentEvents = await workflowData.listExecutionAgentEvents(executionId);

	function pickString(source: Record<string, unknown>, ...keys: string[]): string | null {
		for (const k of keys) {
			const v = source[k];
			if (typeof v === 'string' && v.trim()) return v;
		}
		return null;
	}

	// event_publisher.py in dapr-agent-py renames internal agent events to the
	// CMA-shape types the /sessions/[id] UI expects. The run-detail Timeline
	// and Canvas graph still filter on the raw dapr-agents names, so reverse
	// the mapping here for Timeline-tab consumption. `data._internalType`
	// already carries the pre-rename type when present.
	const CMA_TO_INTERNAL: Record<string, string> = {
		"agent.message": "llm_complete",
		"agent.tool_use": "tool_call_start",
		"agent.tool_result": "tool_call_end",
	};
	function toInternalType(cmaType: string, data: Record<string, unknown>): string {
		const stashed = data["_internalType"];
		if (typeof stashed === "string" && stashed.trim()) return stashed;
		return CMA_TO_INTERNAL[cmaType] ?? cmaType;
	}

	// CMA rename also reshapes the data payload; the run-detail UI still
	// reads the pre-rename field names, so reverse the reshape here.
	// tool_call_start CMA: {name, input} → internal: {toolName, args}
	// tool_call_end  CMA: {tool_name, output, ...} → internal: {toolName, output, ...}
	// llm_complete  CMA: {content:[{text,type:"text"}], toolCalls} → internal: {content: string, toolCalls}
	function toInternalData(
		internalType: string,
		data: Record<string, unknown>,
	): Record<string, unknown> {
		const out: Record<string, unknown> = { ...data };
		if (internalType === "tool_call_start") {
			if (!("toolName" in out) && typeof out.name === "string") out.toolName = out.name;
			if (!("args" in out) && out.input !== undefined) out.args = out.input;
		} else if (internalType === "tool_call_end" || internalType === "tool_call_error") {
			if (!("toolName" in out)) {
				const tn = out.tool_name ?? out.toolName ?? out.name;
				if (typeof tn === "string") out.toolName = tn;
			}
		} else if (internalType === "llm_complete") {
			if (Array.isArray(out.content)) {
				const joined = out.content
					.map((block) => {
						if (block && typeof block === "object") {
							const text = (block as Record<string, unknown>).text;
							if (typeof text === "string") return text;
						}
						return "";
					})
					.join("");
				out.content = joined;
			}
		}
		return out;
	}

	// Stamp each event with the linking ids the client-side filters look for.
	// For sessions-bridged runs, workflow_agent_runs.id === sessions.id ===
	// dapr_instance_id, so setting both to e.sessionId lets
	// eventsForAgentRun() match by run.id or run.daprInstanceId.
	return json({
		logs,
		agentEvents: agentEvents.map((e) => {
			const rawData = (e.data && typeof e.data === 'object' ? (e.data as Record<string, unknown>) : {});
			const internalType = toInternalType(e.type, rawData);
			const data = toInternalData(internalType, rawData);
			return {
				id: e.id,
				type: internalType,
				sourceEventId: e.sourceEventId,
				workflowAgentRunId: e.sessionId,
				daprInstanceId: e.sessionId,
				sessionId: e.sessionId,
				toolName: pickString(data, 'toolName', 'tool_name', 'name'),
				phase: pickString(data, 'phase'),
				data,
				timestamp: e.createdAt?.toISOString() ?? ''
			};
		}),
		traceId,
		traceIds: allTraceIds,
		executionStatus: execution.status,
		input: execution.input,
		output: execution.output
	});
};
