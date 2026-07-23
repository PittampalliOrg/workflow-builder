import type {
	WorkflowDiagnosticsEvidenceRequest,
	WorkflowDiagnosticsExecution,
	WorkflowDiagnosticsTraceResolution
} from './workflow-diagnostics';
import type {
	ObservabilityExecutionEvidence,
	ObservabilityLlmSpan,
	ObservabilityLogEntry,
	ObservabilityTraceSpan
} from '$lib/types/observability';
import type { PreviewControlIdentity } from './preview-control';

export type PreviewWorkflowDiagnosticsOperation =
	| 'digest-telemetry'
	| 'investigation-evidence'
	| 'resolve-trace-ids'
	| 'search-spans'
	| 'get-span'
	| 'search-llm-spans'
	| 'search-logs';

export type PreviewWorkflowDiagnosticsAuthorizationInput = Readonly<{
	identity: PreviewControlIdentity;
	execution: Pick<
		WorkflowDiagnosticsExecution,
		| 'id'
		| 'userId'
		| 'projectId'
		| 'startedAt'
		| 'completedAt'
		| 'primaryTraceId'
		| 'workflowSessionId'
	>;
	operation: PreviewWorkflowDiagnosticsOperation;
}>;

/**
 * Short-lived proof that the preview BFF authorized one preview-local workspace
 * execution. User and project ids are opaque outside that preview's trust domain.
 */
export interface PreviewWorkflowDiagnosticsAuthorizationPort {
	issue(input: PreviewWorkflowDiagnosticsAuthorizationInput): string;
	verify(token: string, input: PreviewWorkflowDiagnosticsAuthorizationInput): boolean;
}

export type PreviewWorkflowDiagnosticsDigestLlmSpan = Readonly<{
	traceId: string;
	spanId: string;
	serviceName: string;
	sessionId: string;
	modelName: string | null;
	promptTokens: number | null;
	completionTokens: number | null;
	totalTokens: number | null;
	cacheReadInputTokens: number | null;
	cacheCreationInputTokens: number | null;
}>;

export type PreviewWorkflowDiagnosticsDigestTelemetry = Readonly<{
	traceIds: string[];
	spans: ObservabilityTraceSpan[];
	llmSpans: PreviewWorkflowDiagnosticsDigestLlmSpan[];
	llmSpansTruncated: boolean;
	llmSpanLimit: number;
	degradedSources: Array<'correlation' | 'spans' | 'llm'>;
	warnings: string[];
}>;

/** Exact-tuple physical telemetry reads. No ClickHouse credential crosses this port. */
export interface PreviewWorkflowDiagnosticsQueryPort {
	isConfigured(): boolean;
	loadDigestTelemetry(input: Readonly<{
		identity: PreviewControlIdentity;
		execution: WorkflowDiagnosticsExecution;
	}>): Promise<PreviewWorkflowDiagnosticsDigestTelemetry>;
	loadInvestigationEvidence(
		input: Readonly<{
			identity: PreviewControlIdentity;
			execution: WorkflowDiagnosticsExecution;
			request: WorkflowDiagnosticsEvidenceRequest;
		}>
	): Promise<ObservabilityExecutionEvidence>;
	resolveTraceIds(input: Readonly<{
		identity: PreviewControlIdentity;
		execution: WorkflowDiagnosticsExecution;
	}>): Promise<WorkflowDiagnosticsTraceResolution>;
	searchSpans(input: Readonly<{
		identity: PreviewControlIdentity;
		execution: WorkflowDiagnosticsExecution;
		traceIds: string[];
		query: { query?: string; errorsOnly?: boolean; limit: number; offset: number };
	}>): Promise<ObservabilityTraceSpan[]>;
	getSpan(input: Readonly<{
		identity: PreviewControlIdentity;
		execution: WorkflowDiagnosticsExecution;
		traceIds: string[];
		spanId: string;
	}>): Promise<ObservabilityTraceSpan | null>;
	searchLlmSpans(input: Readonly<{
		identity: PreviewControlIdentity;
		execution: WorkflowDiagnosticsExecution;
		traceIds: string[];
		query: {
			workflowExecutionId: string;
			spanId?: string;
			sessionId?: string;
			limit: number;
			offset: number;
		};
	}>): Promise<ObservabilityLlmSpan[]>;
	searchLogs(input: Readonly<{
		identity: PreviewControlIdentity;
		execution: WorkflowDiagnosticsExecution;
		traceIds: string[];
		query: {
			spanId?: string;
			query?: string;
			errorsOnly?: boolean;
			limit: number;
			offset: number;
		};
	}>): Promise<ObservabilityLogEntry[]>;
}

export type PreviewWorkflowDiagnosticsBrokerResult =
	| PreviewWorkflowDiagnosticsDigestTelemetry
	| ObservabilityExecutionEvidence
	| WorkflowDiagnosticsTraceResolution
	| ObservabilityTraceSpan[]
	| ObservabilityTraceSpan
	| ObservabilityLlmSpan[]
	| ObservabilityLogEntry[]
	| null;
