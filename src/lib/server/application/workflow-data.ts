import type { McpServerProfileConfig } from "$lib/server/agent-profiles";
import { resolveAgentMcpServersForProject } from "$lib/server/agents/mcp-resolution";
import type {
	AppendWorkflowExecutionLogInput,
	ArtifactStore,
	WorkflowArtifactInput,
	WorkflowDataService,
	WorkflowDefinitionRepository,
	WorkflowExecutionLogPatch,
	WorkflowExecutionReadModelPatch,
	WorkflowExecutionRepository,
	WorkflowAgentRunStore,
	UpdateWorkflowAgentRunLifecycleInput,
	UpsertWorkflowAgentRunScheduledInput,
	WorkflowPlanArtifactInput,
	WorkflowPlanArtifactStatus,
	WorkflowPlanArtifactStore,
	WorkflowRef,
	MlflowTraceLineageStore,
	UpsertMlflowTraceLineageLinksInput,
	WorkspaceSessionStore,
	UpsertWorkspaceSessionInput,
} from "$lib/server/application/ports";

export class ApplicationWorkflowDataService implements WorkflowDataService {
	constructor(
		private readonly deps: {
			workflowDefinitions: WorkflowDefinitionRepository;
			workflowExecutions: WorkflowExecutionRepository;
			artifactStore: ArtifactStore;
			workspaceSessions: WorkspaceSessionStore;
			agentRuns: WorkflowAgentRunStore;
			planArtifacts: WorkflowPlanArtifactStore;
			mlflowTraceLineage: MlflowTraceLineageStore;
		},
	) {}

	async getWorkflowByRef(ref: WorkflowRef & { lookup?: "id" | "name" | "auto" }) {
		if (ref.lookup === "id") {
			const workflowId = ref.workflowId?.trim();
			return workflowId ? this.deps.workflowDefinitions.getById(workflowId) : null;
		}
		if (ref.lookup === "name") {
			const workflowName = ref.workflowName?.trim();
			return workflowName
				? this.deps.workflowDefinitions.getLatestByName(workflowName)
				: null;
		}
		const workflowId = ref.workflowId?.trim();
		if (workflowId) {
			const workflow = await this.deps.workflowDefinitions.getById(workflowId);
			if (workflow) return workflow;
		}
		const workflowName = ref.workflowName?.trim();
		return workflowName
			? this.deps.workflowDefinitions.getLatestByName(workflowName)
			: null;
	}

	getExecutionById(id: string) {
		return this.deps.workflowExecutions.getById(id);
	}

	updateExecutionReadModel(
		executionId: string,
		patch: WorkflowExecutionReadModelPatch,
	) {
		return this.deps.workflowExecutions.updateReadModel(executionId, patch);
	}

	appendExecutionLog(input: AppendWorkflowExecutionLogInput) {
		return this.deps.workflowExecutions.appendLog(input);
	}

	updateExecutionLog(
		executionId: string,
		id: string,
		patch: WorkflowExecutionLogPatch,
	) {
		return this.deps.workflowExecutions.updateLog(executionId, id, patch);
	}

	upsertWorkflowArtifact(input: WorkflowArtifactInput) {
		return this.deps.artifactStore.upsertWorkflowArtifact(input);
	}

	listWorkflowArtifactsByExecutionId(executionId: string) {
		return this.deps.artifactStore.listWorkflowArtifactsByExecutionId(executionId);
	}

	upsertWorkflowWorkspaceSession(input: UpsertWorkspaceSessionInput) {
		return this.deps.workspaceSessions.upsertWorkflowWorkspaceSession(input);
	}

	upsertScheduledAgentRun(input: UpsertWorkflowAgentRunScheduledInput) {
		return this.deps.agentRuns.upsertScheduledAgentRun(input);
	}

	updateAgentRunLifecycle(input: UpdateWorkflowAgentRunLifecycleInput) {
		return this.deps.agentRuns.updateAgentRunLifecycle(input);
	}

	upsertPlanArtifact(input: WorkflowPlanArtifactInput) {
		return this.deps.planArtifacts.upsertPlanArtifact(input);
	}

	updatePlanArtifactStatus(input: {
		artifactRef: string;
		status: WorkflowPlanArtifactStatus;
		metadata?: Record<string, unknown> | null;
	}) {
		return this.deps.planArtifacts.updatePlanArtifactStatus(input);
	}

	getPlanArtifact(artifactRef: string) {
		return this.deps.planArtifacts.getPlanArtifact(artifactRef);
	}

	getMlflowRunTargetsForExecution(executionId: string) {
		return this.deps.mlflowTraceLineage.getRunTargetsForExecution(executionId);
	}

	upsertMlflowTraceLineageLinks(input: UpsertMlflowTraceLineageLinksInput) {
		return this.deps.mlflowTraceLineage.upsertTraceLineageLinks(input);
	}

	async resolveMcpConfig(input: {
		workflowId?: string | null;
		projectId?: string | null;
		requestedServers?: unknown[];
		includeProjectConnections?: boolean;
	}) {
		let projectId = input.projectId?.trim() || null;
		const workflowId = input.workflowId?.trim();
		if (!projectId && workflowId) {
			const workflow = await this.deps.workflowDefinitions.getById(workflowId);
			projectId = workflow?.projectId ?? null;
		}

		const result = await resolveAgentMcpServersForProject({
			projectId,
			requestedServers: Array.isArray(input.requestedServers)
				? (input.requestedServers as McpServerProfileConfig[])
				: [],
			includeProjectConnections: input.includeProjectConnections,
		});
		return { projectId, ...result };
	}
}
