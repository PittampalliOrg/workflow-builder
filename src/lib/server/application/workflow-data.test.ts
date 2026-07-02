import { describe, expect, it, vi } from "vitest";
import type {
	ArtifactStore,
	TraceLineageStore,
	WorkflowDefinition,
	WorkflowDefinitionRepository,
	WorkflowAgentRunStore,
	WorkflowExecutionRepository,
	WorkflowPlanArtifactStore,
	WorkspaceSessionStore,
} from "$lib/server/application/ports";
import { ApplicationWorkflowDataService } from "$lib/server/application/workflow-data";

const baseWorkflow: WorkflowDefinition = {
	id: "wf-id",
	name: "example",
	description: null,
	userId: "user-1",
	projectId: "project-1",
	nodes: [],
	edges: [],
	specVersion: null,
	spec: null,
	visibility: "private",
	engineType: "dapr",
	daprWorkflowName: null,
	daprOrchestratorUrl: null,
	mlflowExperimentId: null,
	mlflowExperimentName: null,
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function makeService(options: {
	byId?: WorkflowDefinition | null;
	byName?: WorkflowDefinition | null;
}) {
	const workflowDefinitions = {
		getById: vi.fn(async () => options.byId ?? null),
		getLatestByName: vi.fn(async () => options.byName ?? null),
		getByRef: vi.fn(async () => null),
	} satisfies WorkflowDefinitionRepository;

	const service = new ApplicationWorkflowDataService({
		workflowDefinitions,
		workflowExecutions: {} as WorkflowExecutionRepository,
		artifactStore: {} as ArtifactStore,
		workspaceSessions: {} as WorkspaceSessionStore,
		agentRuns: {} as WorkflowAgentRunStore,
		planArtifacts: {} as WorkflowPlanArtifactStore,
		traceLineage: {} as TraceLineageStore,
	});

	return { service, workflowDefinitions };
}

describe("ApplicationWorkflowDataService", () => {
	it("resolves auto workflow refs by id before name", async () => {
		const { service, workflowDefinitions } = makeService({
			byId: baseWorkflow,
			byName: { ...baseWorkflow, id: "wf-name" },
		});

		await expect(
			service.getWorkflowByRef({
				workflowId: "wf-id",
				workflowName: "example",
				lookup: "auto",
			}),
		).resolves.toEqual(baseWorkflow);

		expect(workflowDefinitions.getById).toHaveBeenCalledWith("wf-id");
		expect(workflowDefinitions.getLatestByName).not.toHaveBeenCalled();
	});

	it("falls back to workflow name when auto id lookup misses", async () => {
		const namedWorkflow = { ...baseWorkflow, id: "wf-name" };
		const { service, workflowDefinitions } = makeService({
			byId: null,
			byName: namedWorkflow,
		});

		await expect(
			service.getWorkflowByRef({
				workflowId: "missing-id",
				workflowName: "example",
				lookup: "auto",
			}),
		).resolves.toEqual(namedWorkflow);

		expect(workflowDefinitions.getById).toHaveBeenCalledWith("missing-id");
		expect(workflowDefinitions.getLatestByName).toHaveBeenCalledWith("example");
	});

	it("delegates agent-run lifecycle operations to the agent-run port", async () => {
		const agentRuns = {
			upsertScheduledAgentRun: vi.fn(async () => ({ id: "agent-run-1" })),
			updateAgentRunLifecycle: vi.fn(async () => ({
				id: "agent-run-1",
				status: "completed" as const,
			})),
		} satisfies WorkflowAgentRunStore;
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowExecutions: {} as WorkflowExecutionRepository,
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		await expect(
			service.upsertScheduledAgentRun({
				id: "agent-run-1",
				workflowExecutionId: "exec-1",
				workflowId: "wf-1",
				nodeId: "agent",
				mode: "run",
				agentWorkflowId: "agent-run-1",
				daprInstanceId: "agent-run-1",
				parentExecutionId: "parent-1",
			}),
		).resolves.toEqual({ id: "agent-run-1" });
		await service.updateAgentRunLifecycle({
			id: "agent-run-1",
			status: "completed",
			result: { ok: true },
		});

		expect(agentRuns.upsertScheduledAgentRun).toHaveBeenCalledTimes(1);
		expect(agentRuns.updateAgentRunLifecycle).toHaveBeenCalledWith({
			id: "agent-run-1",
			status: "completed",
			result: { ok: true },
		});
	});

	it("delegates plan artifacts and OTel trace lineage to their ports", async () => {
		const planArtifacts = {
			upsertPlanArtifact: vi.fn(async () => ({
				artifactRef: "plan-1",
				storageBackend: "workflow_plan_artifacts" as const,
				artifactType: "claude_task_graph_v1",
				status: "draft" as const,
			})),
			updatePlanArtifactStatus: vi.fn(async () => ({
				artifactRef: "plan-1",
				status: "approved" as const,
			})),
			getPlanArtifact: vi.fn(async () => null),
		} satisfies WorkflowPlanArtifactStore;
		const traceLineage = {
			getTraceTargetsForExecution: vi.fn(async () => []),
			upsertTraceLineageLinks: vi.fn(async () => ({
				recorded: 1,
				sourceKeys: ["source-key"],
			})),
		} satisfies TraceLineageStore;
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowExecutions: {} as WorkflowExecutionRepository,
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts,
			traceLineage,
		});

		await service.upsertPlanArtifact({
			artifactRef: "plan-1",
			workflowExecutionId: "exec-1",
			workflowId: "wf-1",
			nodeId: "agent",
			goal: "ship it",
			planJson: { steps: [] },
		});
		await service.updatePlanArtifactStatus({
			artifactRef: "plan-1",
			status: "approved",
		});
		await service.upsertTraceLineageLinks({
			traceId: "tr-1234567890abcdef1234567890abcdef",
			targets: [
				{
					entityType: "workflow_execution",
					entityId: "exec-1",
					projectId: "project-1",
					externalExperimentId: "exp-1",
					externalRunId: "run-1",
				},
			],
		});

		expect(planArtifacts.upsertPlanArtifact).toHaveBeenCalledTimes(1);
		expect(planArtifacts.updatePlanArtifactStatus).toHaveBeenCalledTimes(1);
		expect(traceLineage.upsertTraceLineageLinks).toHaveBeenCalledTimes(1);
	});

	it("delegates execution, artifact, and workspace persistence to their ports", async () => {
		const executionLog = {
			id: "log-1",
			executionId: "exec-1",
			nodeId: "agent",
			nodeName: "Agent",
			nodeType: "action",
			activityName: "durable/run",
			status: "running" as const,
			input: {},
			output: null,
			error: null,
			startedAt: new Date("2026-01-01T00:00:00.000Z"),
			completedAt: null,
			duration: null,
			timestamp: new Date("2026-01-01T00:00:00.000Z"),
			credentialFetchMs: null,
			routingMs: null,
			coldStartMs: null,
			executionMs: null,
			routedTo: null,
			wasColdStart: null,
		};
		const workflowExecutions = {
			assertReadModelReady: vi.fn(async () => undefined),
			getById: vi.fn(async () => null),
			getByDaprInstanceId: vi.fn(async () => null),
			create: vi.fn(async () => ({ id: "exec-1" })),
			attachSchedulerInstance: vi.fn(async () => undefined),
			markStartFailed: vi.fn(async () => undefined),
			listStaleRunningExecutions: vi.fn(async () => []),
			updateReadModel: vi.fn(async () => undefined),
			appendLog: vi.fn(async () => executionLog),
			updateLog: vi.fn(async () => ({ ...executionLog, status: "success" as const })),
		} satisfies WorkflowExecutionRepository;
		const artifactStore = {
			upsertWorkflowArtifact: vi.fn(async () => ({ id: "artifact-1" })),
			listWorkflowArtifactsByExecutionId: vi.fn(async () => []),
		} satisfies ArtifactStore;
		const workspaceSessions = {
			upsertWorkflowWorkspaceSession: vi.fn(async () => ({
				workspaceRef: "workspace-1",
			})),
		} satisfies WorkspaceSessionStore;
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowExecutions,
			artifactStore,
			workspaceSessions,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		await service.updateExecutionReadModel("exec-1", { phase: "running" });
		await service.assertExecutionReadModelReady();
		await service.createWorkflowExecution({
			id: "exec-1",
			workflowId: "wf-1",
			userId: "user-1",
			status: "running",
			workflowSessionId: "exec-1",
		});
		await service.attachExecutionSchedulerInstance({
			executionId: "exec-1",
			instanceId: "sw-example-exec-exec-1",
			primaryTraceId: "trace-1",
		});
		await service.markExecutionStartFailed({
			executionId: "exec-1",
			error: "failed to start",
		});
		await service.getExecutionByDaprInstanceId("sw-example-exec-exec-1");
		await service.listStaleRunningExecutions({ olderThanMinutes: 60 });
		await service.appendExecutionLog({
			executionId: "exec-1",
			nodeId: "agent",
			nodeName: "Agent",
			nodeType: "action",
			status: "running",
		});
		await service.updateExecutionLog("exec-1", "log-1", { status: "success" });
		await service.upsertWorkflowArtifact({
			id: "artifact-1",
			workflowExecutionId: "exec-1",
			kind: "markdown",
			title: "Summary",
		});
		await service.upsertWorkflowWorkspaceSession({
			workspaceRef: "workspace-1",
			workflowExecutionId: "exec-1",
			name: "workspace_profile",
			rootPath: "/sandbox",
			backend: "openshell",
		});

		expect(workflowExecutions.updateReadModel).toHaveBeenCalledWith("exec-1", {
			phase: "running",
		});
		expect(workflowExecutions.assertReadModelReady).toHaveBeenCalledTimes(1);
		expect(workflowExecutions.create).toHaveBeenCalledWith(
			expect.objectContaining({ id: "exec-1", workflowSessionId: "exec-1" }),
		);
		expect(workflowExecutions.attachSchedulerInstance).toHaveBeenCalledWith({
			executionId: "exec-1",
			instanceId: "sw-example-exec-exec-1",
			primaryTraceId: "trace-1",
		});
		expect(workflowExecutions.markStartFailed).toHaveBeenCalledWith({
			executionId: "exec-1",
			error: "failed to start",
		});
		expect(workflowExecutions.getByDaprInstanceId).toHaveBeenCalledWith(
			"sw-example-exec-exec-1",
		);
		expect(workflowExecutions.listStaleRunningExecutions).toHaveBeenCalledWith({
			olderThanMinutes: 60,
		});
		expect(workflowExecutions.appendLog).toHaveBeenCalledWith(
			expect.objectContaining({ executionId: "exec-1", nodeId: "agent" }),
		);
		expect(workflowExecutions.updateLog).toHaveBeenCalledWith("exec-1", "log-1", {
			status: "success",
		});
		expect(artifactStore.upsertWorkflowArtifact).toHaveBeenCalledWith(
			expect.objectContaining({ id: "artifact-1", kind: "markdown" }),
		);
		expect(workspaceSessions.upsertWorkflowWorkspaceSession).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceRef: "workspace-1", backend: "openshell" }),
		);
	});
});
