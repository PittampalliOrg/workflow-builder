import type {
	WorkflowDiagnosticsEvidenceRequest,
	WorkflowDiagnosticsEvidenceRequestInput,
	WorkflowDiagnosticsExecution,
	WorkflowDiagnosticsReadPort
} from '$lib/server/application/ports/workflow-diagnostics';
import {
	WORKFLOW_DIAGNOSTICS_DEFAULT_EVIDENCE_LIMITS,
	WORKFLOW_DIAGNOSTICS_EVIDENCE_CATEGORIES,
	WORKFLOW_DIAGNOSTICS_MAX_EVIDENCE_LIMITS
} from '$lib/server/application/ports/workflow-diagnostics';
import type {
	ObservabilityExecutionEvidence,
	ObservabilityExecutionEvidenceCategory,
	ObservabilityTraceSpan
} from '$lib/types/observability';
import {
	boundDiagnosticEvidence,
	redactDiagnosticEvidence
} from '$lib/server/application/diagnostic-redaction';
import { isExpectedKubernetesNotFound } from '$lib/server/application/span-error-policy';

export type WorkflowDiagnosticsQueryResponse = {
	body: Record<string, unknown>;
	httpStatus?: number;
};

function isActive(execution: WorkflowDiagnosticsExecution): boolean {
	return execution.status === 'running' || execution.status === 'pending';
}

function emptyPage(limit: number) {
	return { limit, count: 0, truncated: false, nextCursor: null };
}

function missingTraceTelemetry(
	execution: WorkflowDiagnosticsExecution,
	warnings: string[] = []
) {
	return {
		state: isActive(execution) ? 'pending' : 'partial',
		isFinal: false,
		warnings: ['No execution-correlated trace ids are available yet', ...warnings],
		refreshAfterMs: 5_000
	};
}

function traceReadTelemetry(
	execution: WorkflowDiagnosticsExecution,
	traceIds: string[],
	warnings: string[]
) {
	const active = isActive(execution);
	const partial = active || warnings.length > 0;
	return {
		state: partial ? ('partial' as const) : ('complete' as const),
		isFinal: !partial,
		traceIds,
		warnings: [
			...(active ? ['Execution is active; trace telemetry may still be ingesting'] : []),
			...warnings
		],
		...(partial ? { refreshAfterMs: 5_000 } : {})
	};
}

function response(
	body: Record<string, unknown>,
	httpStatus?: number
): WorkflowDiagnosticsQueryResponse {
	return {
		body: redactDiagnosticEvidence(body),
		...(httpStatus == null ? {} : { httpStatus })
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function normalizeEvidenceRequest(
	input: WorkflowDiagnosticsEvidenceRequestInput = {}
): WorkflowDiagnosticsEvidenceRequest {
	const allowed = new Set<ObservabilityExecutionEvidenceCategory>(
		WORKFLOW_DIAGNOSTICS_EVIDENCE_CATEGORIES
	);
	const requestedCategories = input.categories ?? [...WORKFLOW_DIAGNOSTICS_EVIDENCE_CATEGORIES];
	const categories = [...new Set(requestedCategories.filter((category) => allowed.has(category)))];
	const serviceNames = [
		...new Set(
			(input.serviceNames ?? [])
				.map((name) => name.trim())
				.filter(
					(name) => name.length > 0 && name.length <= 160 && !/[\u0000-\u001f\u007f]/.test(name)
				)
		)
	].slice(0, 20);
	const limits = Object.fromEntries(
		WORKFLOW_DIAGNOSTICS_EVIDENCE_CATEGORIES.map((category) => {
			const requested = input.limits?.[category];
			const fallback = WORKFLOW_DIAGNOSTICS_DEFAULT_EVIDENCE_LIMITS[category];
			return [
				category,
				Math.min(
					WORKFLOW_DIAGNOSTICS_MAX_EVIDENCE_LIMITS[category],
					Math.max(1, Number.isFinite(requested) ? Math.floor(requested as number) : fallback)
				)
			];
		})
	) as unknown as WorkflowDiagnosticsEvidenceRequest['limits'];
	return { categories, serviceNames, limits };
}

/** Application query service for execution-scoped workflow diagnostics. */
export class ApplicationWorkflowDiagnosticsQueryService {
	constructor(private readonly reads: WorkflowDiagnosticsReadPort) {}

	async getInvestigationEvidence(input: {
		execution: WorkflowDiagnosticsExecution;
		request?: WorkflowDiagnosticsEvidenceRequestInput;
	}): Promise<ObservabilityExecutionEvidence> {
		const request = normalizeEvidenceRequest(input.request);
		if (this.reads.isConfigured()) {
			try {
				return await this.reads.loadInvestigationEvidence(input.execution, request);
			} catch (error) {
				return {
					traceIds: [],
					traceSpans: [],
					logs: [],
					llmSpans: [],
					toolSpans: [],
					truncated: {
						spans: false,
						logs: false,
						llmSpans: false,
						toolSpans: false
					},
					rowTruncated: {
						spans: false,
						logs: false,
						llmSpans: false,
						toolSpans: false
					},
					contentTruncated: {
						spans: false,
						logs: false,
						llmSpans: false,
						toolSpans: false
					},
					limits: request.limits,
					degradedSources: ['correlation'],
					warnings: [
						redactDiagnosticEvidence(
							`Workflow diagnostics evidence unavailable: ${error instanceof Error ? error.message : String(error)}`
						)
					]
				};
			}
		}
		return {
			traceIds: [],
			traceSpans: [],
			logs: [],
			llmSpans: [],
			toolSpans: [],
			truncated: {
				spans: false,
				logs: false,
				llmSpans: false,
				toolSpans: false
			},
			rowTruncated: {
				spans: false,
				logs: false,
				llmSpans: false,
				toolSpans: false
			},
			contentTruncated: {
				spans: false,
				logs: false,
				llmSpans: false,
				toolSpans: false
			},
			limits: request.limits,
			degradedSources: ['correlation'],
			warnings: ['Workflow diagnostics telemetry is not configured']
		};
	}

	async getDigest(input: {
		execution: WorkflowDiagnosticsExecution;
	}): Promise<WorkflowDiagnosticsQueryResponse> {
		const { execution } = input;
		const projection = await this.reads.loadDigest(execution);
		const configured = this.reads.isConfigured();
		const active = isActive(execution);
		const warnings: string[] = [];
		let telemetryState: 'complete' | 'partial' | 'pending' | 'unavailable' = 'complete';
		if (!configured) {
			telemetryState = 'unavailable';
			warnings.push('ClickHouse trace storage is not configured; digest is journal-only');
		} else if (projection.traceIds.length === 0) {
			telemetryState = active ? 'pending' : 'partial';
			warnings.push('No execution-correlated trace ids are available yet; digest is journal-only');
		} else if (projection.spans.length === 0) {
			telemetryState = active ? 'pending' : 'partial';
			warnings.push('Trace ids were resolved but no span summaries were returned');
		}
		if (projection.llmSpansTruncated) {
			if (telemetryState === 'complete') telemetryState = 'partial';
			warnings.push(
				`LLM metadata was limited to ${projection.llmSpanLimit} rows; the digest may omit earlier turns`
			);
		}
		if (projection.degradedSources.length > 0) {
			if (telemetryState === 'complete') telemetryState = 'partial';
			warnings.push(...projection.warnings);
		}

		const calls = projection.calls.slice(0, 200).map((call) => ({
			callId: call.callId,
			seq: call.seq,
			kind: call.kind,
			label: call.label,
			phase: call.phase,
			status: call.status,
			sessionId: call.sessionId,
			retries: call.retries,
			errorCode: call.errorCode
		}));
		const sessions = [
			...new Set(
				[
					...calls.map((call) => call.sessionId),
					...projection.spans.map((span) => span.attributes?.['session.id'])
				].filter((value): value is string => typeof value === 'string' && value.length > 0)
			)
		];
		const boundedDigest = boundDiagnosticEvidence(projection.digest, 100_000);

		return response({
			...asRecord(boundedDigest.value),
			evidence: {
				traceIds: projection.traceIds,
				spanCount: projection.spans.length,
				llmTurnCount: projection.llmTurnCount,
				calls,
				sessions,
				truncated: {
					calls: projection.calls.length > calls.length,
					digest: boundedDigest.truncated,
					llmTurns: projection.llmSpansTruncated
				},
				limits: {
					llmTurns: projection.llmSpanLimit
				}
			},
			telemetry: {
				state: telemetryState,
				isFinal: !active && telemetryState === 'complete',
				warnings,
				...((active || telemetryState === 'partial' || telemetryState === 'pending')
					? { refreshAfterMs: 5_000 }
					: {})
			},
			observedAt: new Date().toISOString()
		});
	}

	async searchSpans(input: {
		execution: WorkflowDiagnosticsExecution;
		query?: string;
		errorsOnly: boolean;
		service?: string;
		limit: number;
		offset: number;
		encodeCursor(offset: number): string | null;
	}): Promise<WorkflowDiagnosticsQueryResponse> {
		const { execution, offset } = input;
		const limit = Math.min(100, Math.max(1, input.limit));
		if (!this.reads.isConfigured()) {
			return {
				body: {
					spans: [],
					page: emptyPage(limit),
					telemetry: {
						state: 'unavailable',
						warnings: ['ClickHouse trace storage is not configured']
					}
				}
			};
		}
		const resolution = await this.reads.resolveTraceIds(execution);
		const { traceIds } = resolution;
		if (traceIds.length === 0) {
			return {
				body: {
					spans: [],
					page: emptyPage(limit),
					telemetry: missingTraceTelemetry(execution, resolution.warnings)
				}
			};
		}
		const service = input.service?.trim();
		const rawMatches = await this.reads.searchSpans(execution, traceIds, {
			query: input.query,
			errorsOnly: input.errorsOnly,
			...(service ? { serviceNames: [service] } : {}),
			limit: limit + 1,
			offset
		});
		const matches = input.errorsOnly
			? rawMatches.filter((span) => !isExpectedKubernetesNotFound(span))
			: rawMatches;
		const hasMore = matches.length > limit;
		const rows = matches.slice(0, limit).map((span) => {
			const statusMessage = boundDiagnosticEvidence(span.statusMessage ?? null, 2_000);
			const attributes = boundDiagnosticEvidence(span.attributes ?? {}, 750);
			const resourceAttributes = boundDiagnosticEvidence(span.resourceAttributes ?? {}, 500);
			return {
				spanId: span.spanId,
				parentSpanId: span.parentSpanId,
				traceId: span.traceId,
				name: span.operationName,
				service: span.serviceName,
				startTime: span.startTime,
				durationMs: span.duration,
				status: span.status,
				statusMessage: statusMessage.value,
				sessionId: span.attributes?.['session.id'] ?? null,
				operationName: span.operationName,
				serviceName: span.serviceName,
				duration: span.duration,
				statusCode: span.statusCode,
				spanKind: span.spanKind,
				attributes: attributes.value,
				resourceAttributes: resourceAttributes.value,
				attributesTruncated:
					span.attributesTruncated || attributes.truncated || resourceAttributes.truncated,
				hasInput: span.hasInput,
				hasOutput: span.hasOutput,
				inputSize: span.inputSize,
				outputSize: span.outputSize,
				depth: span.depth
			};
		});
		return response({
			spans: rows,
			total: rows.length,
			limited: hasMore,
			page: {
				limit,
				count: rows.length,
				truncated: hasMore,
				nextCursor: hasMore ? input.encodeCursor(offset + limit) : null
			},
			telemetry: traceReadTelemetry(execution, traceIds, resolution.warnings)
		});
	}

	async getSpan(input: {
		execution: WorkflowDiagnosticsExecution;
		spanId: string;
	}): Promise<WorkflowDiagnosticsQueryResponse> {
		if (!this.reads.isConfigured()) {
			return response({ error: 'ClickHouse trace storage is not configured' }, 503);
		}
		const resolution = await this.reads.resolveTraceIds(input.execution);
		const { traceIds } = resolution;
		if (traceIds.length === 0) {
			return {
				body: {
					span: null,
					telemetry: missingTraceTelemetry(input.execution, resolution.warnings)
				}
			};
		}
		const span = await this.reads.getSpan(input.execution, traceIds, input.spanId);
		if (!span) {
			return response({ error: 'Span not found in this execution' }, 404);
		}
		const attributes = boundDiagnosticEvidence(span.attributes, 50_000);
		const resources = boundDiagnosticEvidence(span.resourceAttributes, 10_000);
		const truncated = attributes.truncated || resources.truncated;
		return response({
			span: {
				traceId: span.traceId,
				spanId: span.spanId,
				parentSpanId: span.parentSpanId,
				name: span.operationName,
				kind: span.spanKind,
				service: span.serviceName,
				operationName: span.operationName,
				spanKind: span.spanKind,
				serviceName: span.serviceName,
				startTime: span.startTime,
				durationMs: span.duration,
				duration: span.duration,
				status: span.status,
				statusCode: span.statusCode,
				statusMessage: boundDiagnosticEvidence(span.statusMessage ?? null, 2_000).value,
				attributes: attributes.value,
				resourceAttributes: resources.value,
				attributesTruncated: truncated,
				truncated,
				hasInput: span.hasInput,
				hasOutput: span.hasOutput,
				inputSize: span.inputSize,
				outputSize: span.outputSize,
				depth: span.depth
			},
			telemetry: traceReadTelemetry(input.execution, traceIds, resolution.warnings)
		});
	}

	async getLlmTurns(input: {
		execution: WorkflowDiagnosticsExecution;
		spanId?: string;
		sessionId?: string;
		limit: number;
		offset: number;
		encodeCursor(offset: number): string | null;
	}): Promise<WorkflowDiagnosticsQueryResponse> {
		const { execution, offset } = input;
		const limit = input.spanId ? 1 : Math.min(3, Math.max(1, input.limit));
		if (!this.reads.isConfigured()) {
			return {
				body: {
					turns: [],
					page: emptyPage(limit),
					telemetry: {
						state: 'unavailable',
						warnings: ['ClickHouse LLM trace storage is not configured']
					}
				}
			};
		}
		const resolution = await this.reads.resolveTraceIds(execution);
		const { traceIds } = resolution;
		if (traceIds.length === 0) {
			return {
				body: {
					turns: [],
					page: emptyPage(limit),
					telemetry: missingTraceTelemetry(execution, resolution.warnings)
				}
			};
		}
		const matches = await this.reads.searchLlmSpans(execution, traceIds, {
			workflowExecutionId: execution.id,
			spanId: input.spanId,
			sessionId: input.sessionId,
			limit: limit + 1,
			offset
		});
		const hasMore = !input.spanId && matches.length > limit;
		const turns = matches.slice(0, limit).map((turn) => {
			const messageLimit = input.spanId ? 25_000 : 12_000;
			const invocationLimit = input.spanId ? 5_000 : 3_000;
			const turnInput = boundDiagnosticEvidence(turn.inputMessages, messageLimit);
			const output = boundDiagnosticEvidence(turn.outputMessages, messageLimit);
			const invocation = boundDiagnosticEvidence(turn.invocationParameters, invocationLimit);
			return {
				timestamp: turn.timestamp,
				spanId: turn.spanId,
				traceId: turn.traceId,
				parentSpanId: turn.parentSpanId,
				service: turn.serviceName,
				sessionId: turn.sessionId,
				agentRunId: turn.agentRunId,
				model: turn.modelName,
				provider: turn.provider,
				status: turn.statusCode,
				finishReason: turn.finishReason,
				promptTokens: turn.promptTokens,
				completionTokens: turn.completionTokens,
				totalTokens: turn.totalTokens,
				cacheReadInputTokens: turn.cacheReadInputTokens,
				cacheCreationInputTokens: turn.cacheCreationInputTokens,
				reasoningTokens: turn.reasoningTokens,
				inputMessages: turnInput.value,
				outputMessages: output.value,
				invocationParameters: invocation.value,
				truncated: {
					input: turn.inputMessagesTruncated || turnInput.truncated,
					output: turn.outputMessagesTruncated || output.truncated,
					invocation: turn.invocationParametersTruncated || invocation.truncated
				}
			};
		});
		return response({
			turns,
			page: {
				limit,
				count: turns.length,
				truncated: hasMore,
				nextCursor: hasMore ? input.encodeCursor(offset + limit) : null
			},
			telemetry: traceReadTelemetry(execution, traceIds, resolution.warnings)
		});
	}

	async searchLogs(input: {
		execution: WorkflowDiagnosticsExecution;
		spanId?: string;
		query?: string;
		errorsOnly: boolean;
		limit: number;
		offset: number;
		encodeCursor(offset: number): string | null;
	}): Promise<WorkflowDiagnosticsQueryResponse> {
		const { execution, offset } = input;
		const limit = Math.min(200, Math.max(1, input.limit));
		if (!this.reads.isConfigured()) {
			return {
				body: {
					logs: [],
					page: emptyPage(limit),
					telemetry: {
						state: 'unavailable',
						warnings: ['ClickHouse log storage is not configured']
					}
				}
			};
		}
		const resolution = await this.reads.resolveTraceIds(execution);
		const { traceIds } = resolution;
		if (traceIds.length === 0) {
			return {
				body: {
					logs: [],
					page: emptyPage(limit),
					telemetry: missingTraceTelemetry(execution, resolution.warnings)
				}
			};
		}
		const matches = await this.reads.searchLogs(execution, traceIds, {
			spanId: input.spanId,
			query: input.query,
			errorsOnly: input.errorsOnly,
			limit: limit + 1,
			offset
		});
		const hasMore = matches.length > limit;
		const rows = matches.slice(0, limit).map((log) => {
			const body = boundDiagnosticEvidence(log.body, 2_000);
			return {
				timestamp: log.timestamp,
				traceId: log.traceId,
				spanId: log.spanId,
				service: log.serviceName,
				severity: log.severityText,
				body: body.value,
				bodyTruncated: body.truncated,
				bodyOriginalBytes: Buffer.byteLength(log.body, 'utf8')
			};
		});
		return response({
			logs: rows,
			total: rows.length,
			limited: hasMore,
			page: {
				limit,
				count: rows.length,
				truncated: hasMore,
				nextCursor: hasMore ? input.encodeCursor(offset + limit) : null
			},
			telemetry: traceReadTelemetry(execution, traceIds, resolution.warnings)
		});
	}

	async getToolCalls(input: {
		execution: WorkflowDiagnosticsExecution;
		spanId?: string;
		sessionId?: string;
		toolName?: string;
		errorsOnly: boolean;
		limit: number;
		offset: number;
		encodeCursor(offset: number): string | null;
	}): Promise<WorkflowDiagnosticsQueryResponse> {
		const { execution, offset } = input;
		const limit = Math.min(50, Math.max(1, input.limit));
		if (!this.reads.isConfigured()) {
			return {
				body: {
					toolCalls: [],
					page: emptyPage(limit),
					telemetry: {
						state: 'unavailable',
						warnings: ['ClickHouse tool-span storage is not configured']
					}
				}
			};
		}
		const resolution = await this.reads.resolveTraceIds(execution);
		const { traceIds } = resolution;
		if (traceIds.length === 0) {
			return {
				body: {
					toolCalls: [],
					page: emptyPage(limit),
					telemetry: missingTraceTelemetry(execution, resolution.warnings)
				}
			};
		}
		const matches = await this.reads.searchToolSpans(execution, traceIds, {
			workflowExecutionId: execution.id,
			spanId: input.spanId,
			sessionId: input.sessionId,
			toolName: input.toolName,
			errorsOnly: input.errorsOnly,
			limit: limit + 1,
			offset
		});
		const hasMore = matches.length > limit;
		const toolCalls = matches.slice(0, limit).map((call) => {
			const args = boundDiagnosticEvidence(call.toolArguments, 8_000);
			const callResult = boundDiagnosticEvidence(call.toolResult, 8_000);
			return {
				timestamp: call.timestamp,
				spanId: call.spanId,
				traceId: call.traceId,
				parentSpanId: call.parentSpanId,
				service: call.serviceName,
				sessionId: call.sessionId,
				agentRunId: call.agentRunId,
				toolName: call.toolName,
				status: call.statusCode,
				arguments: args.value,
				result: callResult.value,
				truncated: {
					arguments: call.toolArgumentsTruncated || args.truncated,
					result: call.toolResultTruncated || callResult.truncated
				}
			};
		});
		return response({
			toolCalls,
			total: toolCalls.length,
			limited: hasMore,
			page: {
				limit,
				count: toolCalls.length,
				truncated: hasMore,
				nextCursor: hasMore ? input.encodeCursor(offset + limit) : null
			},
			telemetry: traceReadTelemetry(execution, traceIds, resolution.warnings)
		});
	}

	async getSpanTree(input: {
		execution: WorkflowDiagnosticsExecution;
		maxNodes: number;
	}): Promise<WorkflowDiagnosticsQueryResponse> {
		const { execution } = input;
		const maxNodes = Math.min(800, Math.max(20, input.maxNodes));
		if (!this.reads.isConfigured()) {
			return {
				body: {
					nodes: [],
					telemetry: {
						state: 'unavailable',
						warnings: ['ClickHouse trace storage is not configured']
					}
				}
			};
		}
		const resolution = await this.reads.resolveTraceIds(execution);
		const { traceIds } = resolution;
		if (traceIds.length === 0) {
			return {
				body: {
					nodes: [],
					telemetry: missingTraceTelemetry(execution, resolution.warnings)
				}
			};
		}
		const batch = await this.reads.loadSpanSummaries(execution, traceIds, 5_000);
		const projection = buildSpanTree(batch.spans, maxNodes);
		return response({
			// FLAT pre-order list, not nested objects: the shared MCP redaction
			// pass caps recursion at depth 12 and real traces nest middleware
			// chains far deeper — nesting would come back as
			// "[redaction-depth-exceeded]". Render by indenting `depth`.
			nodes: projection.nodes,
			spanCount: batch.spans.length,
			renderedCount: projection.renderedCount,
			truncated: {
				spans: batch.truncated,
				nodes: projection.nodesTruncated,
				siblings: projection.siblingsOmitted > 0
			},
			omittedSiblings: projection.siblingsOmitted,
			maxNodes,
			telemetry: traceReadTelemetry(execution, traceIds, resolution.warnings)
		});
	}
}

type SpanTreeNode = {
	spanId: string;
	parentSpanId: string | null;
	depth: number;
	name: string;
	service: string;
	status: 'ok' | 'error';
	durationMs: number;
	startOffsetMs: number;
	sessionId?: string;
	statusMessage?: string;
	/** Count of same-name siblings collapsed under this node (repetition guard). */
	omittedChildren?: number;
};

/**
 * Project flat span summaries into a compact waterfall for one MCP read:
 * pre-order (parent before children, siblings in start order) with a `depth`
 * per node so consumers render it as an indented tree. Repetitive same-name
 * siblings collapse to their first three occurrences (middleware chains,
 * per-item fan-outs) and the total rendered node count is capped.
 * Names/durations only — attribute drills stay in trace_get_span /
 * trace_get_llm_turn / trace_get_tool_calls.
 */
function buildSpanTree(
	spans: ObservabilityTraceSpan[],
	maxNodes: number
): {
	nodes: SpanTreeNode[];
	renderedCount: number;
	nodesTruncated: boolean;
	siblingsOmitted: number;
} {
	const byId = new Map(spans.map((span) => [span.spanId, span]));
	const childrenOf = new Map<string, ObservabilityTraceSpan[]>();
	const roots: ObservabilityTraceSpan[] = [];
	for (const span of spans) {
		const parent = span.parentSpanId && byId.has(span.parentSpanId) ? span.parentSpanId : null;
		if (parent === null) {
			roots.push(span);
		} else {
			const siblings = childrenOf.get(parent) ?? [];
			siblings.push(span);
			childrenOf.set(parent, siblings);
		}
	}
	const startMsByTrace = new Map<string, number>();
	for (const span of spans) {
		const ms = Date.parse(span.startTime);
		if (!Number.isFinite(ms)) continue;
		const current = startMsByTrace.get(span.traceId);
		if (current === undefined || ms < current) startMsByTrace.set(span.traceId, ms);
	}
	const byStart = (a: ObservabilityTraceSpan, b: ObservabilityTraceSpan) =>
		Date.parse(a.startTime) - Date.parse(b.startTime) || a.spanId.localeCompare(b.spanId);

	const nodes: SpanTreeNode[] = [];
	let nodesTruncated = false;
	let siblingsOmitted = 0;
	const MAX_SIBLINGS_PER_NAME = 3;

	const render = (span: ObservabilityTraceSpan, depth: number): void => {
		if (nodes.length >= maxNodes) {
			nodesTruncated = true;
			return;
		}
		const traceStart = startMsByTrace.get(span.traceId);
		const startMs = Date.parse(span.startTime);
		const sessionId = span.attributes?.['session.id'];
		const node: SpanTreeNode = {
			spanId: span.spanId,
			parentSpanId: span.parentSpanId ?? null,
			depth,
			name: span.operationName,
			service: span.serviceName,
			status: span.status,
			durationMs: Math.round(span.duration * 100) / 100,
			startOffsetMs:
				traceStart !== undefined && Number.isFinite(startMs)
					? Math.max(0, Math.round(startMs - traceStart))
					: 0,
			...(typeof sessionId === 'string' && sessionId ? { sessionId } : {}),
			...(span.status === 'error' && span.statusMessage
				? { statusMessage: span.statusMessage.slice(0, 200) }
				: {})
		};
		nodes.push(node);
		const children = (childrenOf.get(span.spanId) ?? []).sort(byStart);
		const seenPerName = new Map<string, number>();
		let omitted = 0;
		for (const child of children) {
			const nameKey = `${child.operationName}|${child.serviceName}`;
			const seen = seenPerName.get(nameKey) ?? 0;
			// Always keep error children; collapse healthy same-name repetition.
			if (child.status !== 'error' && seen >= MAX_SIBLINGS_PER_NAME) {
				omitted += 1;
				continue;
			}
			seenPerName.set(nameKey, seen + 1);
			render(child, depth + 1);
		}
		if (omitted > 0) {
			node.omittedChildren = omitted;
			siblingsOmitted += omitted;
		}
	};

	for (const root of roots.sort(byStart)) {
		render(root, 0);
	}
	return { nodes, renderedCount: nodes.length, nodesTruncated, siblingsOmitted };
}
