import type {
	SandboxProvisionInput,
	SandboxProvisionResult,
} from "$lib/server/sandboxes/provision";
import type {
	ExecutionTimelineEvent,
} from "$lib/types/execution-stream";
import type {
	AgentRuntimePodRecord,
	AgentRuntimeWakeResult,
} from "./agents";

export type AgentRuntimeWarmPoolRecord = {
	name: string;
	namespace: string;
	labels: Record<string, string>;
	annotations: Record<string, string>;
	desiredReplicas: number;
	replicas: number;
	readyReplicas: number;
	sandboxTemplateRefName: string;
};

export interface AgentRuntimeWarmPoolClient {
	listWarmPools(namespace?: string): Promise<AgentRuntimeWarmPoolRecord[]>;
	getWarmPool(
		name: string,
		namespace?: string,
	): Promise<AgentRuntimeWarmPoolRecord | null>;
	getRuntimePod(
		runtimeSlug: string,
		namespace?: string,
	): Promise<AgentRuntimePodRecord | null>;
	wakeRuntime(
		runtimeSlug: string,
		timeoutMs: number,
		namespace?: string,
	): Promise<AgentRuntimeWakeResult>;
	sleepRuntime(runtimeSlug: string, namespace?: string): Promise<void>;
	setWarmPoolReplicas(
		name: string,
		replicas: number,
		namespace?: string,
	): Promise<void>;
}

export type SandboxExecutionRecord = {
	executionId: string;
	workflowId: string | null;
	workflowName: string | null;
	status: string;
	startedAt: Date | null;
	completedAt: Date | null;
};

export type SandboxExecutionReadModel = {
	executionId: string;
	workflowId: string | null;
	workflowName: string;
	status: string;
	startedAt: string | null;
	completedAt: string | null;
};

export type SandboxRuntimeRecord = {
	name: string;
	phase: string;
	createdAt?: string | null;
};

export type SandboxStatsReadModel = {
	total: number;
	byPhase: Record<string, number>;
	executions24h: number;
	avgAgeMinutes: number;
};

export interface SandboxInventoryRepository {
	listRecentExecutionsForSandbox(sandboxName: string): Promise<SandboxExecutionRecord[]>;
	countExecutionsSince(cutoff: Date): Promise<number>;
}

export interface SandboxRuntimeInventory {
	listSandboxes(): Promise<SandboxRuntimeRecord[]>;
}

export interface SandboxAgentEventReadPort {
	listSandboxAgentEvents(input: {
		sandboxName: string;
		afterEventId?: number;
		limit?: number;
	}): Promise<ExecutionTimelineEvent[]>;
}

export type ExecutionSandboxPreviewInfo = {
	executionId: string;
	workspaceRef: string;
	sandboxName: string;
	rootPath: string;
	workingDir: string;
	provider: string;
	kept: boolean;
};

export interface SandboxPreviewGatewayPort {
	getSandboxPreviewInfo(
		executionId: string,
	): Promise<ExecutionSandboxPreviewInfo | null>;
	runtimeFetch(path: string, options?: RequestInit): Promise<Response>;
}

export type SandboxSessionOwnerRecord = {
	sandboxName: string;
	id: string;
	title: string | null;
	status: string;
	workspaceSlug: string;
};

export type SessionSandboxDeleteKind = "runtime" | "workspace";

export type SessionSandboxDeleteResult = {
	name: string;
	kind: SessionSandboxDeleteKind;
	status: "deleted" | "missing" | "error";
	error?: string;
};

export interface SessionSandboxDestroyer {
	deleteRuntimeSandbox(name: string): Promise<SessionSandboxDeleteResult>;
	deleteWorkspaceSandbox(name: string): Promise<SessionSandboxDeleteResult>;
}

export interface SandboxProvisioner {
	provision(input: SandboxProvisionInput): Promise<SandboxProvisionResult>;
}
