import type {
	WorkflowDiagnosticsEvidenceRequest,
	WorkflowDiagnosticsExecution,
	WorkflowDiagnosticsTraceResolution
} from '$lib/server/application/ports/workflow-diagnostics';
import type {
	ObservabilityExecutionEvidence,
	ObservabilityExecutionEvidenceCategory,
	ObservabilityLlmSpan,
	ObservabilityLogEntry,
	ObservabilityToolSpan,
	ObservabilityTraceSpan
} from '$lib/types/observability';
import {
	boundDiagnosticEvidence,
	redactDiagnosticEvidence
} from '$lib/server/application/diagnostic-redaction';

type EvidenceRows = {
	spans: ObservabilityTraceSpan[];
	logs: ObservabilityLogEntry[];
	llmSpans: ObservabilityLlmSpan[];
	toolSpans: ObservabilityToolSpan[];
};

type EvidenceQueries = {
	[K in ObservabilityExecutionEvidenceCategory]: (
		traceIds: string[],
		limit: number
	) => Promise<EvidenceRows[K]>;
};

function errorMessage(error: unknown): string {
	return redactDiagnosticEvidence(error instanceof Error ? error.message : String(error));
}

function boundRows<K extends ObservabilityExecutionEvidenceCategory>(
	category: K,
	rows: EvidenceRows[K]
): { rows: EvidenceRows[K]; truncated: boolean } {
	let truncated = false;
	const bound = <T>(value: T, maxCharacters: number) => {
		if (value === undefined) return { value, truncated: false };
		const result = boundDiagnosticEvidence(value, maxCharacters);
		truncated ||= result.truncated;
		return { value: result.value as T, truncated: result.truncated };
	};
	if (category === 'spans') {
		return {
			rows: (rows as ObservabilityTraceSpan[]).map((span) => {
				truncated ||= span.attributesTruncated === true;
				const statusMessage = bound(span.statusMessage, 500);
				const attributes = bound(span.attributes, 750);
				const resourceAttributes = bound(span.resourceAttributes, 500);
				return {
					...span,
					statusMessage: statusMessage.value,
					attributes: attributes.value,
					resourceAttributes: resourceAttributes.value,
					attributesTruncated:
						span.attributesTruncated || attributes.truncated || resourceAttributes.truncated
				};
			}) as EvidenceRows[K],
			truncated
		};
	}
	if (category === 'logs') {
		return {
			rows: (rows as ObservabilityLogEntry[]).map((log) => ({
				...log,
				body: bound(log.body, 1_000).value,
				resourceAttributes: bound(log.resourceAttributes, 250).value,
				logAttributes: bound(log.logAttributes, 250).value
			})) as EvidenceRows[K],
			truncated
		};
	}
	if (category === 'llmSpans') {
		return {
			rows: (rows as ObservabilityLlmSpan[]).map((span) => {
				truncated ||=
					span.inputMessagesTruncated ||
					span.outputMessagesTruncated ||
					span.invocationParametersTruncated;
				const inputMessages = bound(span.inputMessages, 6_000);
				const outputMessages = bound(span.outputMessages, 6_000);
				const invocationParameters = bound(span.invocationParameters, 1_000);
				return {
					...span,
					inputMessages: inputMessages.value,
					outputMessages: outputMessages.value,
					invocationParameters: invocationParameters.value,
					inputMessagesTruncated: span.inputMessagesTruncated || inputMessages.truncated,
					outputMessagesTruncated: span.outputMessagesTruncated || outputMessages.truncated,
					invocationParametersTruncated:
						span.invocationParametersTruncated || invocationParameters.truncated
				};
			}) as EvidenceRows[K],
			truncated
		};
	}
	return {
		rows: (rows as ObservabilityToolSpan[]).map((span) => {
			truncated ||= span.toolArgumentsTruncated || span.toolResultTruncated;
			const toolArguments = bound(span.toolArguments, 1_500);
			const toolResult = bound(span.toolResult, 1_500);
			return {
				...span,
				toolArguments: toolArguments.value,
				toolResult: toolResult.value,
				toolArgumentsTruncated: span.toolArgumentsTruncated || toolArguments.truncated,
				toolResultTruncated: span.toolResultTruncated || toolResult.truncated
			};
		}) as EvidenceRows[K],
		truncated
	};
}

export async function collectWorkflowDiagnosticsEvidence(input: {
	execution: WorkflowDiagnosticsExecution;
	request: WorkflowDiagnosticsEvidenceRequest;
	resolveTraceIds(): Promise<WorkflowDiagnosticsTraceResolution>;
	queries: EvidenceQueries;
}): Promise<ObservabilityExecutionEvidence> {
	const { request } = input;
	const evidence: ObservabilityExecutionEvidence = {
		traceIds: [],
		traceSpans: [],
		logs: [],
		llmSpans: [],
		toolSpans: [],
		truncated: { spans: false, logs: false, llmSpans: false, toolSpans: false },
		rowTruncated: { spans: false, logs: false, llmSpans: false, toolSpans: false },
		contentTruncated: { spans: false, logs: false, llmSpans: false, toolSpans: false },
		limits: request.limits,
		degradedSources: [],
		warnings: []
	};

	try {
		const resolution = await input.resolveTraceIds();
		evidence.traceIds = resolution.traceIds;
		if (resolution.warnings.length > 0) {
			evidence.degradedSources.push('correlation');
			evidence.warnings.push(...resolution.warnings);
		}
	} catch (error) {
		evidence.degradedSources.push('correlation');
		evidence.warnings.push(`Trace correlation unavailable: ${errorMessage(error)}`);
		return evidence;
	}

	if (evidence.traceIds.length === 0) {
		evidence.degradedSources.push('correlation');
		evidence.warnings.push('No execution-correlated trace ids are available yet');
		return evidence;
	}

	const selected = new Set(request.categories);
	const entries = (
		[
			['spans', 'Trace spans'],
			['logs', 'Trace logs'],
			['llmSpans', 'LLM spans'],
			['toolSpans', 'Tool spans']
		] as const
	).filter(([category]) => selected.has(category));
	const settled = await Promise.allSettled(
		entries.map(([category]) =>
			input.queries[category](evidence.traceIds, request.limits[category] + 1)
		)
	);

	for (const [index, result] of settled.entries()) {
		const [category, label] = entries[index];
		if (result.status === 'rejected') {
			evidence.degradedSources.push(category);
			evidence.warnings.push(`${label} unavailable: ${errorMessage(result.reason)}`);
			continue;
		}
		const limit = request.limits[category];
		const rowLimitReached = result.value.length > limit;
		const bounded = boundRows(category, result.value.slice(0, limit) as never);
		const rows = bounded.rows;
		evidence.rowTruncated[category] = rowLimitReached;
		evidence.contentTruncated[category] = bounded.truncated;
		evidence.truncated[category] = rowLimitReached || bounded.truncated;
		if (rowLimitReached) {
			evidence.warnings.push(`${label} were limited to ${limit} row${limit === 1 ? '' : 's'}`);
		}
		if (bounded.truncated) evidence.warnings.push(`${label} content is truncated`);
		if (category === 'spans') evidence.traceSpans = rows as ObservabilityTraceSpan[];
		if (category === 'logs') evidence.logs = rows as ObservabilityLogEntry[];
		if (category === 'llmSpans') evidence.llmSpans = rows as ObservabilityLlmSpan[];
		if (category === 'toolSpans') evidence.toolSpans = rows as ObservabilityToolSpan[];
	}

	evidence.degradedSources = [...new Set(evidence.degradedSources)];
	return evidence;
}
