import type {
	PreviewControlIdentity,
	PreviewTraceSourceAuthorityPort,
	PreviewWorkflowDiagnosticsAuthorizationPort,
	PreviewWorkflowDiagnosticsBrokerResult,
	PreviewWorkflowDiagnosticsOperation,
	PreviewWorkflowDiagnosticsQueryPort,
	WorkflowDiagnosticsExecution
} from '$lib/server/application/ports';
import {
	WORKFLOW_DIAGNOSTICS_EVIDENCE_CATEGORIES,
	WORKFLOW_DIAGNOSTICS_MAX_EVIDENCE_LIMITS
} from '$lib/server/application/ports/workflow-diagnostics';
import type { ObservabilityExecutionEvidenceCategory } from '$lib/types/observability';
import { validatePreviewControlIdentity } from '$lib/server/application/preview-control-identity';

export type PreviewWorkflowDiagnosticsErrorCode =
	| 'invalid-request'
	| 'not-authorized'
	| 'not-found'
	| 'contract-mismatch'
	| 'unavailable';

export class PreviewWorkflowDiagnosticsError extends Error {
	constructor(
		public readonly code: PreviewWorkflowDiagnosticsErrorCode,
		message: string
	) {
		super(message);
		this.name = 'PreviewWorkflowDiagnosticsError';
	}
}

export type PreviewWorkflowDiagnosticsBrokerCommand = Readonly<{
	identity: PreviewControlIdentity;
	authorization: string;
	operation: PreviewWorkflowDiagnosticsOperation;
	execution: WorkflowDiagnosticsExecution;
	request: unknown;
}>;

type BrokerDeps = Readonly<{
	authority: PreviewTraceSourceAuthorityPort;
	authorization: PreviewWorkflowDiagnosticsAuthorizationPort;
	queries: PreviewWorkflowDiagnosticsQueryPort;
}>;

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new PreviewWorkflowDiagnosticsError('invalid-request', 'diagnostics request must be an object');
	}
	return value as Record<string, unknown>;
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
	if (Object.keys(input).some((key) => !allowed.includes(key))) {
		throw new PreviewWorkflowDiagnosticsError(
			'invalid-request',
			'diagnostics request contains unknown fields'
		);
	}
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
	if (value == null || value === '') return undefined;
	if (typeof value !== 'string') {
		throw new PreviewWorkflowDiagnosticsError('invalid-request', `${name} must be a string`);
	}
	const normalized = value.trim();
	if (!normalized) return undefined;
	if (normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
		throw new PreviewWorkflowDiagnosticsError('invalid-request', `${name} is invalid`);
	}
	return normalized;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
	if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
		throw new PreviewWorkflowDiagnosticsError(
			'invalid-request',
			`${name} must be between ${minimum} and ${maximum}`
		);
	}
	return Number(value);
}

function traceIds(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 200 || value.some((item) => typeof item !== 'string')) {
		throw new PreviewWorkflowDiagnosticsError('invalid-request', 'traceIds are invalid');
	}
	const sanitized = [
		...new Set(
			(value as string[])
				.map((item) => item.trim())
				.filter((item) => /^[a-f0-9]+$/i.test(item))
		)
	];
	if (sanitized.length !== value.length) {
		throw new PreviewWorkflowDiagnosticsError('invalid-request', 'traceIds are invalid');
	}
	return sanitized;
}

function evidenceCategories(value: unknown): ObservabilityExecutionEvidenceCategory[] {
	if (!Array.isArray(value) || value.length > WORKFLOW_DIAGNOSTICS_EVIDENCE_CATEGORIES.length) {
		throw new PreviewWorkflowDiagnosticsError('invalid-request', 'evidence categories are invalid');
	}
	const allowed = new Set<string>(WORKFLOW_DIAGNOSTICS_EVIDENCE_CATEGORIES);
	if (value.some((category) => typeof category !== 'string' || !allowed.has(category))) {
		throw new PreviewWorkflowDiagnosticsError('invalid-request', 'evidence categories are invalid');
	}
	const categories = [...new Set(value)] as ObservabilityExecutionEvidenceCategory[];
	if (categories.length !== value.length) {
		throw new PreviewWorkflowDiagnosticsError('invalid-request', 'evidence categories are invalid');
	}
	return categories;
}

function evidenceServiceNames(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 20) {
		throw new PreviewWorkflowDiagnosticsError('invalid-request', 'serviceNames are invalid');
	}
	const names = value.map((name) => optionalText(name, 'serviceName', 160));
	if (names.some((name) => !name) || new Set(names).size !== names.length) {
		throw new PreviewWorkflowDiagnosticsError('invalid-request', 'serviceNames are invalid');
	}
	return names as string[];
}

function evidenceLimits(value: unknown) {
	const limits = record(value);
	exactKeys(limits, WORKFLOW_DIAGNOSTICS_EVIDENCE_CATEGORIES);
	if (Object.keys(limits).length !== WORKFLOW_DIAGNOSTICS_EVIDENCE_CATEGORIES.length) {
		throw new PreviewWorkflowDiagnosticsError('invalid-request', 'evidence limits are invalid');
	}
	return {
		spans: integer(
			limits.spans,
			'span evidence limit',
			1,
			WORKFLOW_DIAGNOSTICS_MAX_EVIDENCE_LIMITS.spans
		),
		logs: integer(
			limits.logs,
			'log evidence limit',
			1,
			WORKFLOW_DIAGNOSTICS_MAX_EVIDENCE_LIMITS.logs
		),
		llmSpans: integer(
			limits.llmSpans,
			'LLM evidence limit',
			1,
			WORKFLOW_DIAGNOSTICS_MAX_EVIDENCE_LIMITS.llmSpans
		),
		toolSpans: integer(
			limits.toolSpans,
			'tool evidence limit',
			1,
			WORKFLOW_DIAGNOSTICS_MAX_EVIDENCE_LIMITS.toolSpans
		)
	};
}

/** Physical application boundary for preview-safe deep diagnostic reads. */
export class ApplicationPreviewWorkflowDiagnosticsBrokerService {
	constructor(private readonly deps: BrokerDeps) {}

	private async authorize(command: PreviewWorkflowDiagnosticsBrokerCommand): Promise<void> {
		const identity = validatePreviewControlIdentity(command.identity);
		const projectId = command.execution.projectId?.trim();
		if (!command.execution.id.trim() || !command.execution.userId.trim() || !projectId) {
			throw new PreviewWorkflowDiagnosticsError(
				'invalid-request',
				'preview diagnostics require a workspace-scoped execution'
			);
		}
		const authorizationInput = {
			identity,
			execution: {
				id: command.execution.id,
				userId: command.execution.userId,
				projectId,
				startedAt: command.execution.startedAt,
				completedAt: command.execution.completedAt,
				primaryTraceId: command.execution.primaryTraceId,
				workflowSessionId: command.execution.workflowSessionId
			},
			operation: command.operation
		} as const;
		if (!this.deps.authorization.verify(command.authorization, authorizationInput)) {
			throw new PreviewWorkflowDiagnosticsError(
				'not-authorized',
				'preview diagnostics authorization is invalid or expired'
			);
		}
		// Execution ownership was already resolved inside the preview by the
		// workspace-scoped route that issued the proof. The physical environment
		// owner is a separate lifecycle principal, so its id must not be compared
		// with preview-local user/project ids or used for host workspace lookups.
		await this.deps.authority.authorizeTraceTuple(identity);
		if (!this.deps.queries.isConfigured()) {
			throw new PreviewWorkflowDiagnosticsError(
				'unavailable',
				'physical preview diagnostics storage is not configured'
			);
		}
	}

	async execute(
		command: PreviewWorkflowDiagnosticsBrokerCommand
	): Promise<PreviewWorkflowDiagnosticsBrokerResult> {
		await this.authorize(command);
		const identity = validatePreviewControlIdentity(command.identity);
		const execution = command.execution;
		switch (command.operation) {
			case 'digest-telemetry': {
				const request = record(command.request);
				exactKeys(request, []);
				return this.deps.queries.loadDigestTelemetry({ identity, execution });
			}
			case 'investigation-evidence': {
				const request = record(command.request);
				exactKeys(request, ['categories', 'serviceNames', 'limits']);
				return this.deps.queries.loadInvestigationEvidence({
					identity,
					execution,
					request: {
						categories: evidenceCategories(request.categories),
						serviceNames: evidenceServiceNames(request.serviceNames),
						limits: evidenceLimits(request.limits)
					}
				});
			}
			case 'resolve-trace-ids': {
				const request = record(command.request);
				exactKeys(request, []);
				return this.deps.queries.resolveTraceIds({ identity, execution });
			}
			case 'search-spans': {
				const request = record(command.request);
				exactKeys(request, [
					'traceIds',
					'query',
					'errorsOnly',
					'serviceNames',
					'limit',
					'offset'
				]);
				const serviceNames =
					request.serviceNames === undefined
						? undefined
						: evidenceServiceNames(request.serviceNames);
				return this.deps.queries.searchSpans({
					identity,
					execution,
					traceIds: traceIds(request.traceIds),
					query: {
						query: optionalText(request.query, 'span query', 160),
						errorsOnly: request.errorsOnly === true,
						...(serviceNames ? { serviceNames } : {}),
						limit: integer(request.limit, 'span limit', 1, 101),
						offset: integer(request.offset, 'span offset', 0, 100_000)
					}
				});
			}
			case 'get-span': {
				const request = record(command.request);
				exactKeys(request, ['traceIds', 'spanId']);
				const spanId = optionalText(request.spanId, 'spanId', 64);
				if (!spanId || !/^[a-f0-9]+$/i.test(spanId)) {
					throw new PreviewWorkflowDiagnosticsError('invalid-request', 'spanId is invalid');
				}
				return this.deps.queries.getSpan({
					identity,
					execution,
					traceIds: traceIds(request.traceIds),
					spanId
				});
			}
			case 'search-llm-spans': {
				const request = record(command.request);
				exactKeys(request, ['traceIds', 'spanId', 'sessionId', 'limit', 'offset']);
				const spanId = optionalText(request.spanId, 'spanId', 64);
				const sessionId = optionalText(request.sessionId, 'sessionId', 200);
				if (Boolean(spanId) === Boolean(sessionId)) {
					throw new PreviewWorkflowDiagnosticsError(
						'invalid-request',
						'provide exactly one of spanId or sessionId'
					);
				}
				return this.deps.queries.searchLlmSpans({
					identity,
					execution,
					traceIds: traceIds(request.traceIds),
					query: {
						workflowExecutionId: execution.id,
						spanId,
						sessionId,
						limit: integer(request.limit, 'LLM turn limit', 1, 51),
						offset: integer(request.offset, 'LLM turn offset', 0, 100_000)
					}
				});
			}
			case 'search-logs': {
				const request = record(command.request);
				exactKeys(request, ['traceIds', 'spanId', 'query', 'errorsOnly', 'limit', 'offset']);
				return this.deps.queries.searchLogs({
					identity,
					execution,
					traceIds: traceIds(request.traceIds),
					query: {
						spanId: optionalText(request.spanId, 'spanId', 64),
						query: optionalText(request.query, 'log query', 160),
						errorsOnly: request.errorsOnly === true,
						limit: integer(request.limit, 'log limit', 1, 201),
						offset: integer(request.offset, 'log offset', 0, 100_000)
					}
				});
			}
		}
	}
}
