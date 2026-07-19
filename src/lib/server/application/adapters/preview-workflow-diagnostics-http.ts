import { env } from '$env/dynamic/private';
import type {
	PreviewControlIdentity,
	PreviewWorkflowDiagnosticsAuthorizationPort,
	PreviewWorkflowDiagnosticsDigestTelemetry,
	PreviewWorkflowDiagnosticsOperation,
	WorkflowDiagnosticsDigestRead,
	WorkflowDiagnosticsExecution,
	WorkflowDiagnosticsReadPort,
	WorkflowDiagnosticsTraceResolution
} from '$lib/server/application/ports';
import { HmacPreviewWorkflowDiagnosticsAuthorizationAdapter } from './preview-workflow-diagnostics-authorization';
import { validatePreviewControlIdentity } from '$lib/server/application/preview-control-identity';
import {
	localPreviewControlCapability,
	localPreviewControlIdentity
} from '$lib/server/preview-control-capability';
import { PreviewRuntimeIdentityChangedError } from '$lib/server/application/ports';
import { buildRunDigest } from '$lib/server/observability/run-digest';
import type {
	ObservabilityLlmSpan,
	ObservabilityLogEntry,
	ObservabilityTraceSpan
} from '$lib/types/observability';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

type Credential = Readonly<{ header: string; token: string }>;

type HttpOptions = Readonly<{
	listScriptCalls(executionId: string): Promise<WorkflowDiagnosticsDigestRead['calls']>;
	baseUrl?: () => string | null;
	identity?: () => PreviewControlIdentity;
	credential?: (identity: PreviewControlIdentity) => Credential;
	authorization?: PreviewWorkflowDiagnosticsAuthorizationPort;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
}>;

export class PreviewWorkflowDiagnosticsTransportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PreviewWorkflowDiagnosticsTransportError';
	}
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function sameIdentity(left: PreviewControlIdentity, right: PreviewControlIdentity): boolean {
	return (
		left.previewName === right.previewName &&
		left.environmentRequestId === right.environmentRequestId &&
		left.environmentPlatformRevision === right.environmentPlatformRevision &&
		left.environmentSourceRevision === right.environmentSourceRevision &&
		left.catalogDigest === right.catalogDigest
	);
}

function parseIdentity(value: unknown): PreviewControlIdentity {
	try {
		return validatePreviewControlIdentity(value as PreviewControlIdentity);
	} catch {
		throw new PreviewWorkflowDiagnosticsTransportError(
			'preview diagnostics broker returned an invalid identity'
		);
	}
}

function defaultBaseUrl(): string | null {
	return (
		env.PREVIEW_CONTROL_BROKER_URL ??
		process.env.PREVIEW_CONTROL_BROKER_URL ??
		''
	).trim() || null;
}

function defaultCredential(_identity: PreviewControlIdentity): Credential {
	return {
		header: 'X-Preview-Control-Capability',
		token: localPreviewControlCapability()
	};
}

function serializeExecution(execution: WorkflowDiagnosticsExecution) {
	return {
		id: execution.id,
		userId: execution.userId,
		projectId: execution.projectId,
		status: execution.status,
		startedAt: execution.startedAt.toISOString(),
		completedAt: execution.completedAt?.toISOString() ?? null,
		primaryTraceId: execution.primaryTraceId,
		workflowSessionId: execution.workflowSessionId
	};
}

function stringArray(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
		throw new PreviewWorkflowDiagnosticsTransportError(
			`preview diagnostics broker returned invalid ${name}`
		);
	}
	return value as string[];
}

/** Preview-local HTTP adapter. Product/journal data stays local; only telemetry is brokered. */
export class HttpPreviewWorkflowDiagnosticsReadAdapter implements WorkflowDiagnosticsReadPort {
	private readonly fetchImpl: typeof globalThis.fetch;
	private readonly authorization: PreviewWorkflowDiagnosticsAuthorizationPort;

	constructor(private readonly options: HttpOptions) {
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.authorization =
			options.authorization ?? new HmacPreviewWorkflowDiagnosticsAuthorizationAdapter();
	}

	isConfigured(): boolean {
		return Boolean((this.options.baseUrl ?? defaultBaseUrl)());
	}

	private identity(): PreviewControlIdentity {
		return validatePreviewControlIdentity(
			(this.options.identity ?? (() => localPreviewControlIdentity()))()
		);
	}

	private async call(
		operation: PreviewWorkflowDiagnosticsOperation,
		execution: WorkflowDiagnosticsExecution,
		request: Record<string, unknown>
	): Promise<unknown> {
		const identity = this.identity();
		const baseUrl = (this.options.baseUrl ?? defaultBaseUrl)()?.replace(/\/+$/, '');
		if (!baseUrl) {
			throw new PreviewWorkflowDiagnosticsTransportError(
				'preview diagnostics broker URL is not configured'
			);
		}
		const authorization = this.authorization.issue({ identity, execution, operation });
		const credential = (this.options.credential ?? defaultCredential)(identity);
		const response = await this.fetchImpl(
			`${baseUrl}/api/internal/preview-control/environment/workflow-diagnostics`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					[credential.header]: credential.token
				},
				body: JSON.stringify({
					identity,
					authorization,
					operation,
					execution: serializeExecution(execution),
					request
				}),
				signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000)
			}
		);
		const contentLength = Number(response.headers.get('content-length') ?? '0');
		if (contentLength > MAX_RESPONSE_BYTES) {
			throw new PreviewWorkflowDiagnosticsTransportError(
				'preview diagnostics broker response is too large'
			);
		}
		const text = await response.text();
		if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
			throw new PreviewWorkflowDiagnosticsTransportError(
				'preview diagnostics broker response is too large'
			);
		}
		let body: Record<string, unknown> | null;
		try {
			body = record(text ? JSON.parse(text) : null);
		} catch {
			throw new PreviewWorkflowDiagnosticsTransportError(
				'preview diagnostics broker returned invalid JSON'
			);
		}
		if (!response.ok) {
			const code = typeof body?.code === 'string' ? body.code : null;
			if (
				(response.status === 409 && code === 'contract-mismatch') ||
				(response.status === 404 && code === 'not-found')
			) {
				throw new PreviewRuntimeIdentityChangedError(
					typeof body?.error === 'string'
						? body.error
						: 'preview diagnostics generation changed'
				);
			}
			throw new PreviewWorkflowDiagnosticsTransportError(
				typeof body?.error === 'string'
					? body.error
					: `preview diagnostics broker failed (HTTP ${response.status})`
			);
		}
		const receiptIdentity = parseIdentity(body?.identity);
		if (body?.ok !== true || !sameIdentity(receiptIdentity, identity) || !('result' in (body ?? {}))) {
			throw new PreviewWorkflowDiagnosticsTransportError(
				'preview diagnostics broker returned an invalid receipt'
			);
		}
		return body?.result;
	}

	async loadDigest(execution: WorkflowDiagnosticsExecution): Promise<WorkflowDiagnosticsDigestRead> {
		const warnings: string[] = [];
		const degradedSources: WorkflowDiagnosticsDigestRead['degradedSources'] = [];
		const calls = await this.options.listScriptCalls(execution.id).catch((error) => {
			degradedSources.push('journal');
			warnings.push(
				`Script-call journal unavailable: ${error instanceof Error ? error.message : String(error)}`
			);
			return [];
		});
		let telemetry: PreviewWorkflowDiagnosticsDigestTelemetry = {
			traceIds: [],
			spans: [],
			llmSpans: [],
			llmSpansTruncated: false,
			llmSpanLimit: 0,
			degradedSources: [],
			warnings: []
		};
		try {
			const result = record(await this.call('digest-telemetry', execution, {}));
			if (!result) throw new Error('digest telemetry is invalid');
			telemetry = {
				traceIds: stringArray(result.traceIds, 'digest trace ids'),
				spans: Array.isArray(result.spans) ? (result.spans as ObservabilityTraceSpan[]) : [],
				llmSpans: Array.isArray(result.llmSpans) ? (result.llmSpans as never[]) : [],
				llmSpansTruncated: result.llmSpansTruncated === true,
				llmSpanLimit: Number(result.llmSpanLimit) || 0,
				degradedSources: Array.isArray(result.degradedSources)
					? (result.degradedSources as PreviewWorkflowDiagnosticsDigestTelemetry['degradedSources'])
					: [],
				warnings: stringArray(result.warnings, 'digest warnings')
			};
		} catch (error) {
			degradedSources.push('correlation');
			warnings.push(
				`Physical preview telemetry unavailable: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		degradedSources.push(...telemetry.degradedSources);
		warnings.push(...telemetry.warnings);
		const ir = execution.executionIr as { budgetTotal?: unknown } | null | undefined;
		return {
			digest: buildRunDigest({
				execution: {
					id: execution.id,
					status: execution.status,
					startedAt: execution.startedAt,
					completedAt: execution.completedAt,
					output: execution.output,
					budgetTotal: typeof ir?.budgetTotal === 'number' ? ir.budgetTotal : null
				},
				calls,
				spans: telemetry.spans,
				llmSpans: telemetry.llmSpans
			}),
			traceIds: telemetry.traceIds,
			spans: telemetry.spans,
			llmTurnCount: telemetry.llmSpans.length,
			llmSpansTruncated: telemetry.llmSpansTruncated,
			llmSpanLimit: telemetry.llmSpanLimit,
			calls,
			degradedSources: [...new Set(degradedSources)],
			warnings
		};
	}

	async resolveTraceIds(
		execution: WorkflowDiagnosticsExecution
	): Promise<WorkflowDiagnosticsTraceResolution> {
		const result = record(await this.call('resolve-trace-ids', execution, {}));
		if (!result) {
			throw new PreviewWorkflowDiagnosticsTransportError(
				'preview diagnostics broker returned invalid trace resolution'
			);
		}
		return {
			traceIds: stringArray(result.traceIds, 'trace ids'),
			warnings: stringArray(result.warnings, 'trace warnings')
		};
	}

	async searchSpans(
		execution: WorkflowDiagnosticsExecution,
		traceIds: string[],
		query: Parameters<WorkflowDiagnosticsReadPort['searchSpans']>[2]
	): Promise<ObservabilityTraceSpan[]> {
		const result = await this.call('search-spans', execution, { traceIds, ...query });
		if (!Array.isArray(result)) {
			throw new PreviewWorkflowDiagnosticsTransportError('preview diagnostics spans are invalid');
		}
		return result as ObservabilityTraceSpan[];
	}

	async getSpan(
		execution: WorkflowDiagnosticsExecution,
		traceIds: string[],
		spanId: string
	): Promise<ObservabilityTraceSpan | null> {
		const result = await this.call('get-span', execution, { traceIds, spanId });
		if (result !== null && !record(result)) {
			throw new PreviewWorkflowDiagnosticsTransportError('preview diagnostics span is invalid');
		}
		return result as ObservabilityTraceSpan | null;
	}

	async searchLlmSpans(
		execution: WorkflowDiagnosticsExecution,
		traceIds: string[],
		query: Parameters<WorkflowDiagnosticsReadPort['searchLlmSpans']>[2]
	): Promise<ObservabilityLlmSpan[]> {
		const { workflowExecutionId: _ignored, ...bounded } = query;
		const result = await this.call('search-llm-spans', execution, { traceIds, ...bounded });
		if (!Array.isArray(result)) {
			throw new PreviewWorkflowDiagnosticsTransportError('preview diagnostics LLM spans are invalid');
		}
		return result as ObservabilityLlmSpan[];
	}

	async searchLogs(
		execution: WorkflowDiagnosticsExecution,
		traceIds: string[],
		query: Parameters<WorkflowDiagnosticsReadPort['searchLogs']>[2]
	): Promise<ObservabilityLogEntry[]> {
		const result = await this.call('search-logs', execution, { traceIds, ...query });
		if (!Array.isArray(result)) {
			throw new PreviewWorkflowDiagnosticsTransportError('preview diagnostics logs are invalid');
		}
		return result as ObservabilityLogEntry[];
	}
}
