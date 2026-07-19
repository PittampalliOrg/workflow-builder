import type { WorkflowExecutionRecord } from './executions';
import type {
	ObservabilityLlmSpan,
	ObservabilityLogEntry,
	ObservabilityTraceSpan
} from '$lib/types/observability';
import type { RunDigest } from '$lib/types/run-digest';

export type WorkflowDiagnosticsExecution = Pick<
	WorkflowExecutionRecord,
	| 'id'
	| 'userId'
	| 'projectId'
	| 'status'
	| 'startedAt'
	| 'completedAt'
	| 'output'
	| 'executionIr'
	| 'primaryTraceId'
	| 'workflowSessionId'
>;

export type WorkflowDiagnosticsCall = {
	callId: string;
	seq: number;
	kind: string;
	label: string | null;
	phase: string | null;
	status: string;
	sessionId: string | null;
	retries: number;
	errorCode: string | null;
};

export type WorkflowDiagnosticsDigestRead = {
	digest: RunDigest;
	traceIds: string[];
	spans: ObservabilityTraceSpan[];
	llmTurnCount: number;
	llmSpansTruncated: boolean;
	llmSpanLimit: number;
	calls: WorkflowDiagnosticsCall[];
	degradedSources: Array<'journal' | 'correlation' | 'spans' | 'llm'>;
	warnings: string[];
};

export type WorkflowDiagnosticsTraceResolution = {
	traceIds: string[];
	warnings: string[];
};

/** Outbound telemetry boundary used by execution-scoped diagnostic queries. */
export interface WorkflowDiagnosticsReadPort {
	isConfigured(): boolean;
	loadDigest(execution: WorkflowDiagnosticsExecution): Promise<WorkflowDiagnosticsDigestRead>;
	resolveTraceIds(
		execution: WorkflowDiagnosticsExecution
	): Promise<WorkflowDiagnosticsTraceResolution>;
	searchSpans(
		execution: WorkflowDiagnosticsExecution,
		traceIds: string[],
		query: { query?: string; errorsOnly?: boolean; limit: number; offset: number }
	): Promise<ObservabilityTraceSpan[]>;
	getSpan(
		execution: WorkflowDiagnosticsExecution,
		traceIds: string[],
		spanId: string
	): Promise<ObservabilityTraceSpan | null>;
	searchLlmSpans(
		execution: WorkflowDiagnosticsExecution,
		traceIds: string[],
		query: {
			workflowExecutionId: string;
			spanId?: string;
			sessionId?: string;
			limit: number;
			offset: number;
		}
	): Promise<ObservabilityLlmSpan[]>;
	searchLogs(
		execution: WorkflowDiagnosticsExecution,
		traceIds: string[],
		query: {
			spanId?: string;
			query?: string;
			errorsOnly?: boolean;
			limit: number;
			offset: number;
		}
	): Promise<ObservabilityLogEntry[]>;
}
