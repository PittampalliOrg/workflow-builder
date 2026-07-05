import type {
	WorkflowExecutionRecord,
} from "./executions";
import type {
	ObservabilityTraceGoalChipReadModel,
} from "./sessions";

export type ObservabilityServiceGraphWorkflowReadModel = {
	id: string;
	nodes: unknown[];
	edges: unknown[];
};

export type ObservabilityServiceGraphContextReadModel = {
	execution: WorkflowExecutionRecord | null;
	workflow: ObservabilityServiceGraphWorkflowReadModel | null;
	targetWorkflowId: string | null;
};

export type ObservabilityTraceScopeReadModel = {
	sessionIds: string[];
	executionIds: string[];
	sessionIdFilter: string | null;
};

export interface ObservabilityTraceRepository {
	getTraceScope(input: {
		userId: string;
		projectId?: string | null;
		sessionIdFilter?: string | null;
		sessionLimit?: number;
		executionLimit?: number;
	}): Promise<ObservabilityTraceScopeReadModel | null>;
	hasAnyTraceOwnerInScope(input: {
		userId: string;
		projectId?: string | null;
		sessionIds: string[];
		executionIds: string[];
	}): Promise<boolean>;
	listTraceGoalChips(input: {
		sessionIds: string[];
	}): Promise<ObservabilityTraceGoalChipReadModel[]>;
}

export type TraceLinkTarget = {
	entityType: "workflow_execution" | "session";
	entityId: string;
	projectId: string | null;
	externalRunId?: string | null;
	externalExperimentId?: string | null;
};

/**
 * Preview run feed (E1): a read-only, live aggregation of workflow run events
 * across all active Tier-2 preview vclusters, consumed off the shared host NATS
 * (each preview publishes into its own JetStream stream `ORCHESTRATOR-<name>`).
 * The NATS adapter implements this port; the Dev-hub feed service composes it.
 */

/** One preview to tail, as surfaced by the SEA vcluster-previews client. */
export type PreviewRunTarget = {
	name: string;
	url: string | null;
	/**
	 * A3 warm pool: the backing pool-member id (`pool-<n>`) when this preview was
	 * CLAIMED from the pool, else null. The claimed member's orchestrator keeps the
	 * pool-baked `WORKFLOW_ORCHESTRATOR_EVENT_TOPIC_PREFIX=wbpreview-<pool>` (claim
	 * does NOT re-stamp it — a pod restart would defeat the ~11s claim), so its events
	 * land in the POOL-named stream. The feed therefore keys the stream/subject on
	 * `pool ?? name`, while `name` stays the display name + deep-link.
	 */
	pool: string | null;
};

/** A normalized workflow event observed in some preview's run stream. */
export type PreviewRunEvent = {
	previewName: string;
	previewUrl: string | null;
	/** CloudEvent type, e.g. "workflow.started" / "workflow.phase.changed". */
	eventType: string;
	executionId: string | null;
	workflowId: string | null;
	workflowName: string | null;
	phase: string | null;
	progress: number | null;
	/** Coarse status derived from the event type. */
	status: "running" | "completed" | "failed" | "unknown";
	message: string | null;
	/** Event time (ISO 8601) — the producer timestamp when present, else receipt. */
	at: string;
};

export interface PreviewRunFeedPort {
	/**
	 * Open read-only ephemeral consumers for each preview's run stream and invoke
	 * `onEvent` for every decoded workflow event. Previews without a stream yet
	 * are skipped (not an error). Returns an async unsubscribe that tears down all
	 * consumers; safe to call more than once.
	 */
	subscribe(input: {
		previews: PreviewRunTarget[];
		onEvent: (event: PreviewRunEvent) => void;
		onError?: (previewName: string, error: unknown) => void;
	}): Promise<() => Promise<void>>;
}

/**
 * Preview read proxy (E2): read-only HTTP access from the HOST BFF to a preview
 * BFF's internal read APIs (executions list/detail, artifacts, file blobs).
 * Previews run the same app, and the host `workflow-builder-secrets` Secret —
 * including INTERNAL_API_TOKEN — is copied verbatim into every preview vcluster
 * at provision time (runner.sh), so the host's own internal token authenticates
 * against every preview's `/api/internal/*` guard. The adapter reaches the
 * preview over its vcluster-synced in-cluster Service (preferred) or the
 * tailnet URL (fallback). Everything here is read-only and failure-tolerant:
 * an unreachable preview degrades to a typed failure, never a thrown 500.
 */

/** Typed failure for preview reads — callers render "preview unreachable", never 500. */
export type PreviewReadFailure = {
	ok: false;
	reason: "unreachable" | "unauthorized" | "not-found" | "bad-response";
	message?: string;
};

export type PreviewReadResult<T> = { ok: true; data: T } | PreviewReadFailure;

/** Compact execution row proxied from a preview's internal executions list. */
export type PreviewExecutionSummary = {
	id: string;
	workflowId: string | null;
	workflowName: string | null;
	status: string;
	phase: string | null;
	progress: number | null;
	error: string | null;
	startedAt: string | null;
	completedAt: string | null;
	durationMs: number | null;
};

/** Compact artifact row proxied from a preview's internal artifacts list. */
export type PreviewArtifactSummary = {
	id: string;
	executionId: string;
	kind: string;
	title: string | null;
	fileId: string | null;
	contentType: string | null;
	sizeBytes: number | null;
	metadata: Record<string, unknown> | null;
	createdAt: string | null;
};

export interface PreviewReadProxyPort {
	listExecutions(input: {
		target: PreviewRunTarget;
		limit?: number;
		status?: string | null;
	}): Promise<
		PreviewReadResult<{ executions: PreviewExecutionSummary[]; total: number }>
	>;
	getExecution(input: {
		target: PreviewRunTarget;
		executionId: string;
	}): Promise<PreviewReadResult<Record<string, unknown>>>;
	/** Lists a preview execution's artifacts (optionally by kind). Previews running
	 * an app image that predates the internal artifacts GET degrade to a failure. */
	listExecutionArtifacts(input: {
		target: PreviewRunTarget;
		executionId: string;
		kind?: string | null;
	}): Promise<PreviewReadResult<PreviewArtifactSummary[]>>;
	/** Fetches a preview file blob (e.g. a source-bundle) by file id. */
	fetchFileContent(input: {
		target: PreviewRunTarget;
		fileId: string;
		maxBytes?: number;
	}): Promise<
		PreviewReadResult<{
			bytes: Buffer;
			contentType: string | null;
		}>
	>;
}
