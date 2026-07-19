import type {
	WorkflowDiagnosticsExecution,
	WorkflowDiagnosticsTraceResolution
} from './workflow-diagnostics';
import type {
	ObservabilityLlmSpan,
	ObservabilityLogEntry,
	ObservabilityTraceSpan
} from '$lib/types/observability';
import type { PreviewControlIdentity } from './preview-control';

export type PreviewWorkflowDiagnosticsOperation =
	| 'digest-telemetry'
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

/** Short-lived proof that the preview BFF authorized one workspace execution. */
export interface PreviewWorkflowDiagnosticsAuthorizationPort {
	issue(input: PreviewWorkflowDiagnosticsAuthorizationInput): string;
	verify(token: string, input: PreviewWorkflowDiagnosticsAuthorizationInput): boolean;
}

/** Physical workspace membership check; execution existence remains preview-local. */
export interface PreviewWorkflowDiagnosticsWorkspaceAuthorizationPort {
	hasMembership(input: Readonly<{ userId: string; projectId: string }>): Promise<boolean>;
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
	| WorkflowDiagnosticsTraceResolution
	| ObservabilityTraceSpan[]
	| ObservabilityTraceSpan
	| ObservabilityLlmSpan[]
	| ObservabilityLogEntry[]
	| null;
