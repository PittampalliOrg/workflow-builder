import {
	getMultiTraceLlmSpans,
	getMultiTraceLogs,
	getMultiTraceSpans,
	getMultiTraceToolSpans,
	getSessionLlmSpans,
	getSessionLogs,
	getSessionToolSpans,
	getSessionTraceSpans,
	getTraceLlmSpans,
	getTraceLogs,
	getTraceSpans,
	getTraceToolSpans,
	sanitizeTraceIds
} from '$lib/server/otel/clickhouse';
import { isBenignControlPlaneError } from '$lib/server/otel/service-graph';
import { buildWorkflowTimeline } from '$lib/server/observability/workflow-timeline';
import { buildGoalFlow } from '$lib/server/observability/goal-flow';
import type {
	ObservabilityAgentDecisionDiagram,
	ObservabilityAgentDecisionDiagramEdge,
	ObservabilityAgentDecisionDiagramNode,
	ObservabilityAgentDecisionSummary,
	ObservabilityAgentDecisionToolCall,
	ObservabilityAgentDecisionToolResult,
	ObservabilityAgentDecisionTurn,
	ObservabilityInvestigationEvent,
	ObservabilityInvestigationPayload,
	ObservabilityIssueMarker,
	ObservabilityLogEntry,
	ObservabilityLlmMessage,
	ObservabilityLlmSpan,
	ObservabilitySessionSummary,
	ObservabilityToolSpan,
	ObservabilityTraceSpan,
	ObservabilityWorkflowStep
} from '$lib/types/observability';

type TraceBackendData = {
	traceSpans: ObservabilityTraceSpan[];
	logs: ObservabilityLogEntry[];
	llmSpans: ObservabilityLlmSpan[];
	toolSpans: ObservabilityToolSpan[];
	warningMessage: string | null;
};

export type ObservabilityExecutionResolution = {
	executionId: string | null;
	sessionId: string | null;
};

export type ObservabilityWorkflowStepInfo = {
	steps: ObservabilityWorkflowStep[];
	status: string | null;
	startedAt: string | null;
	completedAt: string | null;
};

export type ObservabilityInvestigationWorkflowReader = {
	resolveExecutionForInvestigation(identifier: string): Promise<ObservabilityExecutionResolution>;
	getWorkflowSteps(executionOrSessionId: string): Promise<ObservabilityWorkflowStepInfo>;
};

type ObservabilityInvestigationOptions = {
	workflowReader?: ObservabilityInvestigationWorkflowReader;
};

let defaultWorkflowReader: ObservabilityInvestigationWorkflowReader | null = null;

async function getWorkflowReader(
	override?: ObservabilityInvestigationWorkflowReader
): Promise<ObservabilityInvestigationWorkflowReader> {
	if (override) return override;
	if (!defaultWorkflowReader) {
		const adapter = await import('$lib/server/application/adapters/observability-investigation');
		defaultWorkflowReader = adapter.postgresObservabilityInvestigationWorkflowReader;
	}
	return defaultWorkflowReader;
}

function formatMetric(value: number | null | undefined, suffix = 'ms'): string | null {
	if (value == null || !Number.isFinite(value)) return null;
	if (suffix === 'tokens') return `${value} ${suffix}`;
	if (value < 1000) return `${Math.round(value)}${suffix}`;
	return `${(value / 1000).toFixed(2)}s`;
}

function previewText(value: unknown, fallback = ''): string {
	if (typeof value === 'string') return value;
	if (value == null) return fallback;
	try {
		return JSON.stringify(value);
	} catch {
		return fallback;
	}
}

function clampPreview(value: string | null | undefined, max = 180): string | null {
	if (!value) return null;
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function firstMessageContent(messages: ObservabilityLlmMessage[]): string | null {
	for (const message of messages) {
		if (message.content?.trim()) return message.content.trim();
		if (message.toolCalls?.length) {
			const names = message.toolCalls
				.map((toolCall) => toolCall.function?.name ?? toolCall.id)
				.filter(Boolean);
			if (names.length > 0) return `Tool calls: ${names.join(', ')}`;
		}
	}
	return null;
}

function severityFromLog(log: ObservabilityLogEntry): ObservabilityInvestigationEvent['severity'] {
	const severity = log.severityText.toLowerCase();
	if (severity.includes('fatal') || severity.includes('error')) return 'error';
	if (severity.includes('warn')) return 'warning';
	return 'info';
}

function severityFromStep(step: ObservabilityWorkflowStep): ObservabilityInvestigationEvent['severity'] {
	if (step.status === 'error') return 'error';
	if (step.status === 'success') return 'success';
	if (step.status === 'running' || step.status === 'pending') return 'warning';
	return 'info';
}

function summarizeLlmSpan(span: ObservabilityLlmSpan): string | null {
	const prompt = firstMessageContent(span.inputMessages);
	const output = firstMessageContent(span.outputMessages);
	if (prompt && output) return clampPreview(`${prompt} -> ${output}`);
	return clampPreview(prompt ?? output);
}

function summarizeToolSpan(span: ObservabilityToolSpan): string | null {
	return clampPreview(previewText(span.toolResult, previewText(span.toolArguments, null as never)));
}

function parseTimestamp(value: string | null | undefined): number {
	if (!value) return 0;
	const parsed = new Date(value).getTime();
	return Number.isFinite(parsed) ? parsed : 0;
}

function emptyTraceBackendData(warningMessage: string | null): TraceBackendData {
	return {
		traceSpans: [],
		logs: [],
		llmSpans: [],
		toolSpans: [],
		warningMessage
	};
}

function formatTraceBackendWarning(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	if (message === 'fetch failed') {
		return 'Trace details unavailable: ClickHouse trace backend is unreachable';
	}
	return `Trace details unavailable: ${message}`;
}

function traceBackendWarningIssue(args: {
	scope: 'session' | 'trace';
	identifier: string;
	warningMessage: string | null;
	timestamp: string | null;
}): ObservabilityIssueMarker | null {
	if (!args.warningMessage) return null;
	return {
		id: `issue-trace-backend-unavailable-${args.scope}-${args.identifier}`,
		label: args.warningMessage,
		severity: 'warning',
		timestamp: args.timestamp ?? new Date().toISOString(),
		serviceName: 'otel-clickhouse'
	};
}

async function loadSessionTraceBackend(sessionId: string): Promise<TraceBackendData> {
	try {
		const [traceSpans, logs, llmSpans, toolSpans] = await Promise.all([
			getSessionTraceSpans(sessionId),
			getSessionLogs(sessionId),
			getSessionLlmSpans(sessionId),
			getSessionToolSpans(sessionId)
		]);
		return { traceSpans, logs, llmSpans, toolSpans, warningMessage: null };
	} catch (err) {
		const warningMessage = formatTraceBackendWarning(err);
		console.warn('[observability] Session trace backend query failed', { sessionId, warningMessage });
		return emptyTraceBackendData(warningMessage);
	}
}

async function loadTraceBackend(traceId: string): Promise<TraceBackendData> {
	try {
		const [traceSpans, logs, llmSpans, toolSpans] = await Promise.all([
			getTraceSpans(traceId),
			getTraceLogs(traceId),
			getTraceLlmSpans(traceId),
			getTraceToolSpans(traceId)
		]);
		return { traceSpans, logs, llmSpans, toolSpans, warningMessage: null };
	} catch (err) {
		const warningMessage = formatTraceBackendWarning(err);
		console.warn('[observability] Trace backend query failed', { traceId, warningMessage });
		return emptyTraceBackendData(warningMessage);
	}
}

function firstNonEmptyMessage(messages: ObservabilityLlmMessage[]): string | null {
	for (const message of messages) {
		if (message.content?.trim()) return message.content.trim();
	}
	return null;
}

function flattenToolCalls(messages: ObservabilityLlmMessage[]): ObservabilityAgentDecisionToolCall[] {
	return messages.flatMap((message) =>
		(message.toolCalls ?? []).map((toolCall) => ({
			name: toolCall.function?.name ?? toolCall.id,
			arguments: toolCall.function?.arguments ?? null,
			id: toolCall.id ?? null
		}))
	);
}

function summarizeDecisionOutput(span: ObservabilityLlmSpan): string | null {
	const firstOutput = firstNonEmptyMessage(span.outputMessages);
	if (firstOutput) return clampPreview(firstOutput, 220);
	const toolCalls = flattenToolCalls(span.outputMessages);
	if (toolCalls.length > 0) {
		return clampPreview(`Tool calls: ${toolCalls.map((toolCall) => toolCall.name).join(', ')}`, 220);
	}
	return null;
}

function summarizeDecisionInput(span: ObservabilityLlmSpan): string | null {
	return clampPreview(firstNonEmptyMessage(span.inputMessages), 220);
}

function inferWaitOrApproval(span: ObservabilityLlmSpan, toolCalls: ObservabilityAgentDecisionToolCall[]): boolean {
	const combined = [
		summarizeDecisionInput(span) ?? '',
		summarizeDecisionOutput(span) ?? '',
		...toolCalls.map((toolCall) => `${toolCall.name} ${toolCall.arguments ?? ''}`)
	]
		.join(' ')
		.toLowerCase();
	return ['approval', 'approve', 'wait for', 'await', 'human input'].some((term) =>
		combined.includes(term)
	);
}

function buildDecisionLabel(
	decisionType: ObservabilityAgentDecisionTurn['decisionType'],
	toolCalls: ObservabilityAgentDecisionToolCall[],
	toolResults: ObservabilityAgentDecisionToolResult[],
	stopReason: string | null
): string {
	if (decisionType === 'tool_call') {
		if (toolCalls.length > 0) return `Called ${toolCalls.map((toolCall) => toolCall.name).join(', ')}`;
		if (toolResults.length > 0) return `Executed ${toolResults.map((tool) => tool.toolName).join(', ')}`;
		return 'Executed tool call';
	}
	if (decisionType === 'wait_or_approval') return 'Paused for approval or external input';
	if (decisionType === 'stop') return stopReason ? `Stopped: ${stopReason}` : 'Stopped with final response';
	if (decisionType === 'error') return 'Turn failed';
	return 'Responded without tools';
}

function isDeclarationStopTool(name: string | null | undefined): boolean {
	const normalized = (name ?? '').trim().toLowerCase();
	return ['done', 'finish', 'complete', 'stop'].includes(normalized);
}

function buildAgentDecisionModel(args: {
	traceSpans: ObservabilityTraceSpan[];
	logs: ObservabilityLogEntry[];
	llmSpans: ObservabilityLlmSpan[];
	toolSpans: ObservabilityToolSpan[];
}): {
	summary: ObservabilityAgentDecisionSummary | null;
	turns: ObservabilityAgentDecisionTurn[];
	diagram: ObservabilityAgentDecisionDiagram | null;
} {
	const { traceSpans, logs, llmSpans, toolSpans } = args;
	if (llmSpans.length === 0) {
		return { summary: null, turns: [], diagram: null };
	}

	const traceSpanIndex = new Map<string, ObservabilityTraceSpan>();
	for (const traceSpan of traceSpans) {
		traceSpanIndex.set(`${traceSpan.traceId}:${traceSpan.spanId}`, traceSpan);
	}

	const grouped = new Map<string, ObservabilityLlmSpan[]>();
	for (const llmSpan of llmSpans) {
		const groupKey = llmSpan.agentRunId ?? `trace:${llmSpan.traceId}`;
		const bucket = grouped.get(groupKey) ?? [];
		bucket.push(llmSpan);
		grouped.set(groupKey, bucket);
	}

	const turns: ObservabilityAgentDecisionTurn[] = [];

	for (const [groupKey, groupSpans] of grouped.entries()) {
		const orderedSpans = [...groupSpans].sort(
			(a, b) => parseTimestamp(a.timestamp) - parseTimestamp(b.timestamp)
		);
		const orderedToolSpans = toolSpans
			.filter((toolSpan) =>
				groupKey.startsWith('trace:')
					? toolSpan.traceId === orderedSpans[0]?.traceId
					: toolSpan.agentRunId === orderedSpans[0]?.agentRunId
			)
			.sort((a, b) => parseTimestamp(a.timestamp) - parseTimestamp(b.timestamp));

		for (const [index, llmSpan] of orderedSpans.entries()) {
			const turnStartMs = parseTimestamp(llmSpan.timestamp);
			const nextTurnMs =
				index < orderedSpans.length - 1 ? parseTimestamp(orderedSpans[index + 1].timestamp) : Number.POSITIVE_INFINITY;
			const decisionToolCalls = flattenToolCalls(llmSpan.outputMessages);
			const associatedToolSpans = orderedToolSpans.filter((toolSpan) => {
				const toolTime = parseTimestamp(toolSpan.timestamp);
				if (toolTime < turnStartMs) return false;
				return toolTime < nextTurnMs;
			});
			const toolResults: ObservabilityAgentDecisionToolResult[] = associatedToolSpans.map((toolSpan) => ({
				toolName: toolSpan.toolName,
				statusCode: toolSpan.statusCode,
				result: toolSpan.toolResult,
				timestamp: toolSpan.timestamp,
				spanId: toolSpan.spanId,
				traceId: toolSpan.traceId
			}));
			const turnError =
				llmSpan.statusCode === 'STATUS_CODE_ERROR' ||
				toolResults.some((toolResult) => toolResult.statusCode === 'STATUS_CODE_ERROR');
			const waitOrApproval = inferWaitOrApproval(llmSpan, decisionToolCalls);
			const isLastTurn = index === orderedSpans.length - 1;
			const declarationStop =
				decisionToolCalls.length > 0 &&
				decisionToolCalls.every((toolCall) => isDeclarationStopTool(toolCall.name));
			const stopReason =
				declarationStop
					? decisionToolCalls.map((toolCall) => toolCall.name).join(', ')
					: isLastTurn && decisionToolCalls.length === 0
						? llmSpan.finishReason ?? 'final_response'
						: null;
			const decisionType: ObservabilityAgentDecisionTurn['decisionType'] = turnError
				? 'error'
				: declarationStop
					? 'stop'
					: decisionToolCalls.length > 0
					? 'tool_call'
					: waitOrApproval
						? 'wait_or_approval'
						: stopReason
							? 'stop'
							: 'assistant_message';
			const traceSpan = traceSpanIndex.get(`${llmSpan.traceId}:${llmSpan.spanId}`);
			const evidenceToolSpanIds = associatedToolSpans.map((toolSpan) => `${toolSpan.traceId}:${toolSpan.spanId}`);
			const evidenceLogs = logs
				.map((log, logIndex) => ({ log, id: `${log.timestamp}:${log.traceId}:${log.spanId}:${logIndex}` }))
				.filter(({ log }) => {
					if (log.traceId === llmSpan.traceId && log.spanId === llmSpan.spanId) return true;
					return associatedToolSpans.some(
						(toolSpan) => log.traceId === toolSpan.traceId && log.spanId === toolSpan.spanId
					);
				})
				.map(({ id }) => id);

			turns.push({
				id: `${groupKey}:turn:${index + 1}`,
				agentRunId: llmSpan.agentRunId,
				turnIndex: index + 1,
				traceId: llmSpan.traceId,
				spanId: llmSpan.spanId,
				serviceName: llmSpan.serviceName,
				startedAt: llmSpan.timestamp,
				durationMs: traceSpan?.duration ?? null,
				decisionType,
				decisionLabel: buildDecisionLabel(decisionType, decisionToolCalls, toolResults, stopReason),
				modelName: llmSpan.modelName,
				provider: llmSpan.provider,
				inputSummary: summarizeDecisionInput(llmSpan),
				outputSummary: summarizeDecisionOutput(llmSpan),
				toolCalls: decisionToolCalls,
				toolResults,
				finishReason: llmSpan.finishReason,
				stopReason,
				promptTokens: llmSpan.promptTokens,
				completionTokens: llmSpan.completionTokens,
				totalTokens: llmSpan.totalTokens,
				cacheReadInputTokens: llmSpan.cacheReadInputTokens,
				cacheCreationInputTokens: llmSpan.cacheCreationInputTokens,
				reasoningTokens: llmSpan.reasoningTokens,
				status: turnError ? 'error' : 'ok',
				evidence: {
					traceId: llmSpan.traceId,
					spanId: llmSpan.spanId,
					logIds: evidenceLogs,
					toolSpanIds: evidenceToolSpanIds
				}
			});
		}
	}

	const orderedTurns = turns.sort(
		(a, b) => parseTimestamp(a.startedAt) - parseTimestamp(b.startedAt) || a.turnIndex - b.turnIndex
	);

	// Reassign sequential turnIndex across all groups so the UI shows 1, 2, 3, ...
	for (let i = 0; i < orderedTurns.length; i++) {
		orderedTurns[i].turnIndex = i + 1;
		orderedTurns[i].id = `global:turn:${i + 1}`;
	}

	const summary: ObservabilityAgentDecisionSummary = {
		totalTurns: orderedTurns.length,
		toolCallTurns: orderedTurns.filter((turn) => turn.decisionType === 'tool_call').length,
		assistantMessageTurns: orderedTurns.filter((turn) => turn.decisionType === 'assistant_message').length,
		waitOrApprovalTurns: orderedTurns.filter((turn) => turn.decisionType === 'wait_or_approval').length,
		stopTurns: orderedTurns.filter((turn) => turn.decisionType === 'stop').length,
		errorTurns: orderedTurns.filter((turn) => turn.decisionType === 'error').length,
		totalToolCalls: orderedTurns.reduce((sum, turn) => sum + turn.toolCalls.length, 0),
		totalDurationMs: orderedTurns.reduce((sum, turn) => sum + (turn.durationMs ?? 0), 0),
		totalTokens: orderedTurns.reduce((sum, turn) => sum + (turn.totalTokens ?? 0), 0),
		averageTurnLatencyMs:
			orderedTurns.length > 0
				? Math.round(orderedTurns.reduce((sum, turn) => sum + (turn.durationMs ?? 0), 0) / orderedTurns.length)
				: 0,
		stopReason: [...orderedTurns].reverse().find((turn) => turn.stopReason)?.stopReason ?? null
	};

	const nodeMap = new Map<string, ObservabilityAgentDecisionDiagramNode>();
	const edgeMap = new Map<string, ObservabilityAgentDecisionDiagramEdge>();

	function ensureNode(id: string, label: string, type: 'state' | 'decision', isTerminal = false) {
		const existing = nodeMap.get(id);
		if (existing) return existing;
		const node: ObservabilityAgentDecisionDiagramNode = {
			id,
			label,
			type,
			count: 0,
			totalDurationMs: 0,
			...(isTerminal ? { isTerminal: true } : {})
		};
		nodeMap.set(id, node);
		return node;
	}

	function registerEdge(from: string, to: string, turn: ObservabilityAgentDecisionTurn) {
		const edgeId = `${from}->${to}`;
		const existing = edgeMap.get(edgeId) ?? {
			id: edgeId,
			from,
			to,
			count: 0,
			totalDurationMs: 0,
			turnIds: []
		};
		existing.count += 1;
		existing.totalDurationMs += turn.durationMs ?? 0;
		existing.turnIds.push(turn.id);
		edgeMap.set(edgeId, existing);
	}

	const startNode = ensureNode('start', 'Start', 'state');
	const decideNode = ensureNode('decide', 'Decide', 'state');
	const finishNode = ensureNode('finish', 'Finish', 'state', true);

	for (const turn of orderedTurns) {
		const decisionNode = ensureNode(turn.decisionType, turn.decisionType.replaceAll('_', ' '), 'decision', turn.decisionType === 'stop' || turn.decisionType === 'error');
		decisionNode.count += 1;
		decisionNode.totalDurationMs += turn.durationMs ?? 0;
		decideNode.count += 1;
		decideNode.totalDurationMs += turn.durationMs ?? 0;
		startNode.count = 1;
		registerEdge('decide', turn.decisionType, turn);
		if (turn.turnIndex === 1) registerEdge('start', 'decide', turn);
		if (turn.decisionType === 'tool_call' || turn.decisionType === 'wait_or_approval') {
			registerEdge(turn.decisionType, 'decide', turn);
		} else {
			registerEdge(turn.decisionType, 'finish', turn);
			finishNode.count += 1;
			finishNode.totalDurationMs += turn.durationMs ?? 0;
		}
	}

	return {
		summary,
		turns: orderedTurns,
		diagram: {
			nodes: [...nodeMap.values()],
			edges: [...edgeMap.values()]
		}
	};
}

function summarizeSpan(span: ObservabilityTraceSpan): string | null {
	const attrs = span.attributes ?? {};
	const summary =
		(typeof attrs['gen_ai.operation.name'] === 'string' && attrs['gen_ai.operation.name']) ||
		(typeof attrs['http.method'] === 'string' && typeof attrs['url.full'] === 'string'
			? `${attrs['http.method']} ${attrs['url.full']}`
			: null);
	return clampPreview(summary);
}

function buildIssues(
	traceSpans: ObservabilityTraceSpan[],
	logs: ObservabilityLogEntry[],
	steps: ObservabilityWorkflowStep[],
	toolSpans: ObservabilityToolSpan[]
): ObservabilityIssueMarker[] {
	const issues: ObservabilityIssueMarker[] = [];

	for (const step of steps) {
		if (step.status === 'error') {
			issues.push({
				id: `issue-step-${step.id}`,
				label: step.error ? `${step.label}: ${step.error}` : `${step.label} failed`,
				severity: 'error',
				timestamp: step.completedAt ?? step.startedAt ?? new Date().toISOString(),
				workflowStepName: step.stepName
			});
		}
	}

	for (const span of traceSpans) {
		if (span.status === 'error' && !isBenignControlPlaneError(span)) {
			issues.push({
				id: `issue-span-${span.traceId}-${span.spanId}`,
				label: `${span.operationName} failed`,
				severity: 'error',
				timestamp: span.startTime,
				traceId: span.traceId,
				spanId: span.spanId,
				serviceName: span.serviceName
			});
		}
	}

	for (const tool of toolSpans) {
		if (tool.statusCode === 'STATUS_CODE_ERROR') {
			issues.push({
				id: `issue-tool-${tool.traceId}-${tool.spanId}`,
				label: `${tool.toolName} failed`,
				severity: 'error',
				timestamp: tool.timestamp,
				traceId: tool.traceId,
				spanId: tool.spanId,
				serviceName: tool.serviceName
			});
		}
	}

	for (const log of logs) {
		const severity = severityFromLog(log);
		if (severity === 'warning' || severity === 'error') {
			issues.push({
				id: `issue-log-${log.timestamp}-${log.traceId}-${log.spanId}`,
				label: clampPreview(log.body, 120) ?? 'Notable log entry',
				severity,
				timestamp: log.timestamp,
				traceId: log.traceId || undefined,
				spanId: log.spanId || undefined,
				serviceName: log.serviceName
			});
		}
	}

	return issues.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

function buildEvents(args: {
	traceSpans: ObservabilityTraceSpan[];
	logs: ObservabilityLogEntry[];
	llmSpans: ObservabilityLlmSpan[];
	toolSpans: ObservabilityToolSpan[];
	steps: ObservabilityWorkflowStep[];
	issues: ObservabilityIssueMarker[];
}): ObservabilityInvestigationEvent[] {
	const { traceSpans, logs, llmSpans, toolSpans, steps, issues } = args;
	const events: ObservabilityInvestigationEvent[] = [];

	for (const step of steps) {
		events.push({
			id: `workflow-step-${step.id}`,
			type: 'workflow_step',
			timestamp: step.startedAt ?? step.completedAt ?? new Date().toISOString(),
			endTimestamp: step.completedAt,
			title: step.label,
			subtitle: step.actionType || step.stepName,
			preview: clampPreview(step.error ?? previewText(step.output, 'No output')),
			serviceName: step.routedTo ?? null,
			severity: severityFromStep(step),
			workflowStepName: step.stepName,
			durationMs: step.durationMs,
			tags: [step.status, 'workflow'],
			metricLabel: step.durationMs != null ? 'duration' : null,
			metricValue: formatMetric(step.durationMs),
			data: { step }
		});
	}

	for (const span of traceSpans) {
		events.push({
			id: `trace-span-${span.traceId}-${span.spanId}`,
			type: 'trace_span',
			timestamp: span.startTime,
			title: span.operationName,
			subtitle: span.serviceName,
			preview: summarizeSpan(span),
			serviceName: span.serviceName,
			severity:
				span.status === 'error' && !isBenignControlPlaneError(span) ? 'error' : 'info',
			traceId: span.traceId,
			spanId: span.spanId,
			durationMs: span.duration,
			tags: ['trace', span.spanKind ?? 'span'],
			metricLabel: 'latency',
			metricValue: formatMetric(span.duration),
			data: { span }
		});
	}

	for (const span of llmSpans) {
		events.push({
			id: `llm-turn-${span.traceId}-${span.spanId}`,
			type: 'llm_turn',
			timestamp: span.timestamp,
			title: `${span.provider ?? 'llm'} / ${span.modelName ?? 'unknown model'}`,
			subtitle: span.finishReason ? `finish: ${span.finishReason}` : 'LLM turn',
			preview: summarizeLlmSpan(span),
			serviceName: span.serviceName,
			severity: span.statusCode === 'STATUS_CODE_ERROR' ? 'error' : 'info',
			traceId: span.traceId,
			spanId: span.spanId,
			durationMs: null,
			tags: ['llm', span.provider ?? 'provider'],
			metricLabel: span.totalTokens != null ? 'tokens' : null,
			metricValue: span.totalTokens != null ? formatMetric(span.totalTokens, 'tokens') : null,
			data: { llmSpan: span }
		});
	}

	for (const span of toolSpans) {
		events.push({
			id: `tool-call-${span.traceId}-${span.spanId}`,
			type: 'tool_call',
			timestamp: span.timestamp,
			title: span.toolName,
			subtitle: span.serviceName,
			preview: summarizeToolSpan(span),
			serviceName: span.serviceName,
			severity: span.statusCode === 'STATUS_CODE_ERROR' ? 'error' : 'success',
			traceId: span.traceId,
			spanId: span.spanId,
			tags: ['tool'],
			data: { toolSpan: span }
		});
	}

	for (const [index, log] of logs.entries()) {
		const severity = severityFromLog(log);
		if (severity === 'info' && log.body.length < 12) continue;
		events.push({
			id: `log-entry-${log.timestamp}-${log.traceId}-${log.spanId}-${index}`,
			type: 'log_entry',
			timestamp: log.timestamp,
			title: log.serviceName,
			subtitle: log.severityText || 'info',
			preview: clampPreview(log.body),
			serviceName: log.serviceName,
			severity,
			traceId: log.traceId || null,
			spanId: log.spanId || null,
			tags: ['log'],
			data: { log }
		});
	}

	for (const issue of issues) {
		events.push({
			id: issue.id,
			type: 'issue_marker',
			timestamp: issue.timestamp,
			title: issue.label,
			subtitle: issue.workflowStepName ?? issue.serviceName ?? 'issue',
			serviceName: issue.serviceName ?? null,
			severity: issue.severity,
			traceId: issue.traceId ?? null,
			spanId: issue.spanId ?? null,
			workflowStepName: issue.workflowStepName ?? null,
			tags: ['issue']
		});
	}

	return events.sort((a, b) => {
		const time = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
		if (time !== 0) return time;
		return a.id.localeCompare(b.id);
	});
}

function buildSummary(args: {
	scope: 'session' | 'trace';
	sessionId: string | null;
	traceSpans: ObservabilityTraceSpan[];
	logs: ObservabilityLogEntry[];
	llmSpans: ObservabilityLlmSpan[];
	toolSpans: ObservabilityToolSpan[];
	steps: ObservabilityWorkflowStep[];
	events: ObservabilityInvestigationEvent[];
	issues: ObservabilityIssueMarker[];
	status: string | null;
	startedAt: string | null;
	completedAt: string | null;
}): ObservabilitySessionSummary {
	const { scope, sessionId, traceSpans, logs, llmSpans, toolSpans, steps, events, issues, status } = args;
	const traceIds = [...new Set(traceSpans.map((span) => span.traceId).filter(Boolean))];
	const services = [
		...new Set(
			[
				...traceSpans.map((span) => span.serviceName),
				...logs.map((log) => log.serviceName),
				...llmSpans.map((span) => span.serviceName),
				...toolSpans.map((span) => span.serviceName)
			].filter(Boolean)
		)
	].sort();
	const totalDurationMs = Math.max(
		...traceSpans.map((span) => span.duration),
		...steps.map((step) => step.durationMs ?? 0),
		0
	);
	const totalTokens = llmSpans.reduce((sum, span) => sum + (span.totalTokens ?? 0), 0);
	const cacheReadInputTokens = llmSpans.reduce(
		(sum, span) => sum + (span.cacheReadInputTokens ?? 0),
		0
	);
	const cacheCreationInputTokens = llmSpans.reduce(
		(sum, span) => sum + (span.cacheCreationInputTokens ?? 0),
		0
	);
	const reasoningTokens = llmSpans.reduce((sum, span) => sum + (span.reasoningTokens ?? 0), 0);
	const failure = events.find((event) => event.severity === 'error') ?? null;
	const slowestSpan = [...traceSpans].sort((a, b) => b.duration - a.duration)[0] ?? null;
	const allTimes = [
		...traceSpans.map((span) => span.startTime),
		...logs.map((log) => log.timestamp),
		...llmSpans.map((span) => span.timestamp),
		...toolSpans.map((span) => span.timestamp),
		...steps.flatMap((step) => [step.startedAt, step.completedAt].filter(Boolean) as string[])
	].sort();

	return {
		scope,
		sessionId,
		traceIds,
		traceCount: traceIds.length,
		spanCount: traceSpans.length,
		llmTurnCount: llmSpans.length,
		toolCallCount: toolSpans.length,
		logCount: logs.length,
		workflowStepCount: steps.length,
		serviceCount: services.length,
		errorCount: issues.filter((issue) => issue.severity === 'error').length,
		totalDurationMs,
		totalTokens,
		cacheReadInputTokens,
		cacheCreationInputTokens,
		reasoningTokens,
		startedAt: args.startedAt ?? allTimes[0] ?? null,
		completedAt: args.completedAt ?? allTimes.at(-1) ?? null,
		status,
		slowestSpanId: slowestSpan?.spanId ?? null,
		firstFailureEventId: failure?.id ?? null,
		services
	};
}

function dedupeByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		const key = keyFn(item);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export async function buildSessionInvestigation(
	sessionOrExecutionId: string,
	options: ObservabilityInvestigationOptions = {}
): Promise<ObservabilityInvestigationPayload> {
	const workflowReader = await getWorkflowReader(options.workflowReader);
	const resolved = await workflowReader.resolveExecutionForInvestigation(sessionOrExecutionId);
	const sessionId = resolved.sessionId ?? sessionOrExecutionId;
	const [{ steps, status, startedAt, completedAt }, traceBackend] = await Promise.all([
		workflowReader.getWorkflowSteps(sessionOrExecutionId),
		loadSessionTraceBackend(sessionId)
	]);
	const { traceSpans, logs, llmSpans, toolSpans } = traceBackend;

	const traceBackendIssue = traceBackendWarningIssue({
		scope: 'session',
		identifier: sessionId,
		warningMessage: traceBackend.warningMessage,
		timestamp: startedAt ?? completedAt
	});
	const issues = [
		...buildIssues(traceSpans, logs, steps, toolSpans),
		...(traceBackendIssue ? [traceBackendIssue] : [])
	];
	const events = buildEvents({ traceSpans, logs, llmSpans, toolSpans, steps, issues });
	const agentDecisionModel = buildAgentDecisionModel({ traceSpans, logs, llmSpans, toolSpans });
	const workflowTimeline = buildWorkflowTimeline({ traceSpans, workflowSteps: steps });
	const goalFlow = await buildGoalFlow(sessionId ? [sessionId] : [], agentDecisionModel.turns);
	return {
		summary: buildSummary({
			scope: 'session',
			sessionId,
			traceSpans,
			logs,
			llmSpans,
			toolSpans,
			steps,
			events,
			issues,
			status,
			startedAt,
			completedAt
		}),
		goalFlow,
		traceSpans,
		logs,
		llmSpans,
		toolSpans,
		agentDecisionSummary: agentDecisionModel.summary,
		agentDecisions: agentDecisionModel.turns,
		agentDecisionDiagram: agentDecisionModel.diagram,
		workflowSteps: steps,
		workflowTimeline,
		events,
		issues
	};
}

export async function buildTraceInvestigation(
	traceId: string,
	options: ObservabilityInvestigationOptions = {}
): Promise<ObservabilityInvestigationPayload> {
	const workflowReader = await getWorkflowReader(options.workflowReader);
	const traceBackend = await loadTraceBackend(traceId);
	const {
		traceSpans: traceSpansOriginal,
		logs: traceLogs,
		llmSpans: traceLlmSpans,
		toolSpans: traceToolSpans
	} = traceBackend;

	const sessionId =
		traceSpansOriginal.find((span) => typeof span.attributes?.['session.id'] === 'string')?.attributes?.['session.id']?.toString() ??
		traceLlmSpans[0]?.sessionId ??
		traceToolSpans[0]?.sessionId ??
		null;
	let sessionTraceBackend = emptyTraceBackendData(null);
	let sessionSteps: {
		steps: ObservabilityWorkflowStep[];
		status: string | null;
		startedAt: string | null;
		completedAt: string | null;
	} = { steps: [], status: null, startedAt: null, completedAt: null };
	if (sessionId) {
		[sessionTraceBackend, sessionSteps] = await Promise.all([
			loadSessionTraceBackend(sessionId),
			workflowReader.getWorkflowSteps(sessionId)
		]);
	}
	const {
		traceSpans: sessionTraceSpans,
		logs: sessionLogs,
		llmSpans: sessionLlmSpans,
		toolSpans: sessionToolSpans
	} = sessionTraceBackend;
	const traceSpans = dedupeByKey([...traceSpansOriginal, ...sessionTraceSpans], (span) => `${span.traceId}-${span.spanId}`);
	const logs = dedupeByKey([...traceLogs, ...sessionLogs], (log) => `${log.timestamp}-${log.traceId}-${log.spanId}-${log.body}`);
	const llmSpans = dedupeByKey([...traceLlmSpans, ...sessionLlmSpans], (span) => `${span.traceId}-${span.spanId}`);
	const toolSpans = dedupeByKey([...traceToolSpans, ...sessionToolSpans], (span) => `${span.traceId}-${span.spanId}`);
	const steps = sessionSteps.steps;
	const traceBackendIssue = traceBackendWarningIssue({
		scope: 'trace',
		identifier: traceId,
		warningMessage: traceBackend.warningMessage,
		timestamp: traceSpans[0]?.startTime ?? sessionSteps.startedAt
	});
	const sessionTraceBackendIssue = sessionId
		? traceBackendWarningIssue({
				scope: 'session',
				identifier: sessionId,
				warningMessage: sessionTraceBackend.warningMessage,
				timestamp: sessionSteps.startedAt ?? traceSpans[0]?.startTime
			})
		: null;
	const issues = [
		...buildIssues(traceSpans, logs, steps, toolSpans),
		...[traceBackendIssue, sessionTraceBackendIssue].filter((issue): issue is ObservabilityIssueMarker => Boolean(issue))
	];
	const events = buildEvents({ traceSpans, logs, llmSpans, toolSpans, steps, issues });
	const agentDecisionModel = buildAgentDecisionModel({ traceSpans, logs, llmSpans, toolSpans });
	const workflowTimeline = buildWorkflowTimeline({ traceSpans, workflowSteps: steps });
	// Goal flow lives on the per-session AGENT session; a workflow trace carries
	// several session.id attrs (parent + child) — consider them all.
	const goalCandidates = [
		...new Set(
			[
				sessionId,
				...traceSpans
					.map((s) => s.attributes?.['session.id'])
					.filter((v): v is string => typeof v === 'string')
			].filter((v): v is string => Boolean(v))
		)
	];
	const goalFlow = await buildGoalFlow(goalCandidates, agentDecisionModel.turns);
	return {
		summary: buildSummary({
			scope: 'trace',
			sessionId,
			traceSpans,
			logs,
			llmSpans,
			toolSpans,
			steps,
			events,
			issues,
			status: sessionSteps.status,
			startedAt: sessionSteps.startedAt ?? traceSpans[0]?.startTime ?? null,
			completedAt: sessionSteps.completedAt ?? traceSpans.at(-1)?.startTime ?? null
		}),
		goalFlow,
		traceSpans,
		logs,
		llmSpans,
		toolSpans,
		agentDecisionSummary: agentDecisionModel.summary,
		agentDecisions: agentDecisionModel.turns,
		agentDecisionDiagram: agentDecisionModel.diagram,
		workflowSteps: steps,
		workflowTimeline,
		events,
		issues
	};
}

/**
 * Build an investigation payload scoped to ONE execution's trace set. Unlike
 * buildSessionInvestigation, this fetches by TraceId (indexed, fast) instead of
 * scanning otel_traces by session.id, and stays precisely scoped to the run the
 * caller is looking at. Used by the service-graph drill-down.
 */
export async function buildExecutionInvestigation(
	executionId: string,
	traceIds: string[],
	serviceNames?: string[],
	options: ObservabilityInvestigationOptions = {}
): Promise<ObservabilityInvestigationPayload> {
	const workflowReader = await getWorkflowReader(options.workflowReader);
	const ids = sanitizeTraceIds(traceIds);
	const [stepInfo, traceBackend] = await Promise.all([
		workflowReader.getWorkflowSteps(executionId),
		Promise.all([
			getMultiTraceSpans(ids, serviceNames),
			getMultiTraceLogs(ids, serviceNames),
			getMultiTraceLlmSpans(ids, serviceNames),
			getMultiTraceToolSpans(ids, serviceNames)
		]).then(([traceSpans, logs, llmSpans, toolSpans]) => ({ traceSpans, logs, llmSpans, toolSpans }))
	]);
	const { steps, status, startedAt, completedAt } = stepInfo;
	const { traceSpans, logs, llmSpans, toolSpans } = traceBackend;
	const sessionId =
		traceSpans.find((s) => typeof s.attributes?.['session.id'] === 'string')?.attributes?.[
			'session.id'
		]?.toString() ?? null;

	const issues = buildIssues(traceSpans, logs, steps, toolSpans);
	const events = buildEvents({ traceSpans, logs, llmSpans, toolSpans, steps, issues });
	const agentDecisionModel = buildAgentDecisionModel({ traceSpans, logs, llmSpans, toolSpans });
	const workflowTimeline = buildWorkflowTimeline({ traceSpans, workflowSteps: steps });
	const goalFlow = await buildGoalFlow(sessionId ? [sessionId] : [], agentDecisionModel.turns);
	return {
		summary: buildSummary({
			scope: 'session',
			sessionId,
			traceSpans,
			logs,
			llmSpans,
			toolSpans,
			steps,
			events,
			issues,
			status,
			startedAt,
			completedAt
		}),
		goalFlow,
		traceSpans,
		logs,
		llmSpans,
		toolSpans,
		agentDecisionSummary: agentDecisionModel.summary,
		agentDecisions: agentDecisionModel.turns,
		agentDecisionDiagram: agentDecisionModel.diagram,
		workflowSteps: steps,
		workflowTimeline,
		events,
		issues
	};
}
