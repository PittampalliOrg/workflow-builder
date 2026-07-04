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
