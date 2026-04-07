import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	workflowExecutionLogs,
	workflowExecutions
} from '$lib/server/db/schema';
import {
	getSessionLlmSpans,
	getSessionLogs,
	getSessionToolSpans,
	getSessionTraceSpans,
	getTraceLlmSpans,
	getTraceLogs,
	getTraceSpans,
	getTraceToolSpans
} from '$lib/server/otel/clickhouse';
import type {
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

function summarizeSpan(span: ObservabilityTraceSpan): string | null {
	const attrs = span.attributes ?? {};
	const summary =
		(typeof attrs['gen_ai.operation.name'] === 'string' && attrs['gen_ai.operation.name']) ||
		(typeof attrs['http.method'] === 'string' && typeof attrs['url.full'] === 'string'
			? `${attrs['http.method']} ${attrs['url.full']}`
			: null);
	return clampPreview(summary);
}

async function getWorkflowSteps(executionId: string): Promise<{
	steps: ObservabilityWorkflowStep[];
	status: string | null;
	startedAt: string | null;
	completedAt: string | null;
}> {
	if (!db) {
		return { steps: [], status: null, startedAt: null, completedAt: null };
	}

	const [execution] = await db
		.select()
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);

	const dbLogs = await db
		.select()
		.from(workflowExecutionLogs)
		.where(eq(workflowExecutionLogs.executionId, executionId))
		.orderBy(workflowExecutionLogs.startedAt);

	if (dbLogs.length > 0) {
		return {
			status: execution?.status ?? null,
			startedAt: execution?.startedAt?.toISOString() ?? null,
			completedAt: execution?.completedAt?.toISOString() ?? null,
			steps: dbLogs
				.filter((log) => !['trigger', 'state'].includes(log.nodeId))
				.map((log) => ({
					id: log.id,
					stepName: log.nodeId,
					label: log.nodeName,
					actionType: log.activityName ?? log.nodeType,
					status: log.status,
					input: log.input,
					output: log.output,
					error: log.error,
					durationMs: log.duration ? parseInt(log.duration, 10) : null,
					startedAt: log.startedAt?.toISOString() ?? null,
					completedAt: log.completedAt?.toISOString() ?? null,
					routedTo: log.routedTo ?? null
				}))
		};
	}

	const execOutput = execution?.output as Record<string, unknown> | null;
	const stepOutputs = execOutput?.outputs as Record<string, unknown> | undefined;
	const fallbackStart = execution?.startedAt?.toISOString() ?? null;
	return {
		status: execution?.status ?? null,
		startedAt: execution?.startedAt?.toISOString() ?? null,
		completedAt: execution?.completedAt?.toISOString() ?? null,
		steps: stepOutputs
			? Object.entries(stepOutputs)
					.filter(([name]) => !['trigger', 'state'].includes(name))
					.map(([name, value], index) => {
						const record = value as Record<string, unknown>;
						const data = (record.data as Record<string, unknown> | undefined) ?? {};
						return {
							id: `fallback-${name}-${index}`,
							stepName: name,
							label: (record.label as string) || name,
							actionType: (record.actionType as string) || '',
							status: (data.success === false || data.error
								? 'error'
								: data.success === true
									? 'success'
									: 'unknown') as ObservabilityWorkflowStep['status'],
							input: data.input ?? null,
							output: data.output ?? data ?? null,
							error: (data.error as string) ?? null,
							durationMs: (data.duration_ms as number) ?? null,
							startedAt: fallbackStart,
							completedAt: null,
							routedTo: null
						};
					})
			: []
	};
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
		if (span.status === 'error') {
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
			severity: span.status === 'error' ? 'error' : 'info',
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

export async function buildSessionInvestigation(sessionId: string): Promise<ObservabilityInvestigationPayload> {
	const [{ steps, status, startedAt, completedAt }, traceSpans, logs, llmSpans, toolSpans] =
		await Promise.all([
			getWorkflowSteps(sessionId),
			getSessionTraceSpans(sessionId),
			getSessionLogs(sessionId),
			getSessionLlmSpans(sessionId),
			getSessionToolSpans(sessionId)
		]);

	const issues = buildIssues(traceSpans, logs, steps, toolSpans);
	const events = buildEvents({ traceSpans, logs, llmSpans, toolSpans, steps, issues });
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
		traceSpans,
		logs,
		llmSpans,
		toolSpans,
		workflowSteps: steps,
		events,
		issues
	};
}

export async function buildTraceInvestigation(traceId: string): Promise<ObservabilityInvestigationPayload> {
	const [traceSpans, traceLogs, traceLlmSpans, traceToolSpans] = await Promise.all([
		getTraceSpans(traceId),
		getTraceLogs(traceId),
		getTraceLlmSpans(traceId),
		getTraceToolSpans(traceId)
	]);

	const sessionId =
		traceSpans.find((span) => typeof span.attributes?.['session.id'] === 'string')?.attributes?.['session.id']?.toString() ??
		traceLlmSpans[0]?.sessionId ??
		traceToolSpans[0]?.sessionId ??
		null;
	const sessionExtras: [
		ObservabilityLogEntry[],
		ObservabilityLlmSpan[],
		ObservabilityToolSpan[],
		{ steps: ObservabilityWorkflowStep[]; status: string | null; startedAt: string | null; completedAt: string | null }
	] = sessionId
		? await Promise.all([
				getSessionLogs(sessionId),
				getSessionLlmSpans(sessionId),
				getSessionToolSpans(sessionId),
				getWorkflowSteps(sessionId)
			])
		: [[], [], [], { steps: [], status: null, startedAt: null, completedAt: null }];
	const [sessionLogs, sessionLlmSpans, sessionToolSpans, sessionSteps] = sessionExtras;
	const logs = dedupeByKey([...traceLogs, ...sessionLogs], (log) => `${log.timestamp}-${log.traceId}-${log.spanId}-${log.body}`);
	const llmSpans = dedupeByKey([...traceLlmSpans, ...sessionLlmSpans], (span) => `${span.traceId}-${span.spanId}`);
	const toolSpans = dedupeByKey([...traceToolSpans, ...sessionToolSpans], (span) => `${span.traceId}-${span.spanId}`);
	const steps = sessionSteps.steps;
	const issues = buildIssues(traceSpans, logs, steps, toolSpans);
	const events = buildEvents({ traceSpans, logs, llmSpans, toolSpans, steps, issues });
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
		traceSpans,
		logs,
		llmSpans,
		toolSpans,
		workflowSteps: steps,
		events,
		issues
	};
}
