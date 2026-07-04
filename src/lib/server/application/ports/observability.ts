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
