import { describe, expect, it, vi } from "vitest";
import type {
	ArtifactStore,
	MlflowTraceLineageStore,
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
		mlflowTraceLineage: {} as MlflowTraceLineageStore,
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
			mlflowTraceLineage: {} as MlflowTraceLineageStore,
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

	it("delegates plan artifacts and MLflow trace lineage to their ports", async () => {
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
		const mlflowTraceLineage = {
			getRunTargetsForExecution: vi.fn(async () => []),
			upsertTraceLineageLinks: vi.fn(async () => ({
				recorded: 1,
				sourceKeys: ["source-key"],
			})),
		} satisfies MlflowTraceLineageStore;
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowExecutions: {} as WorkflowExecutionRepository,
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts,
			mlflowTraceLineage,
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
		await service.upsertMlflowTraceLineageLinks({
			traceId: "tr-1234567890abcdef1234567890abcdef",
			targets: [
				{
					entityType: "workflow_execution",
					entityId: "exec-1",
					projectId: "project-1",
					experimentId: "exp-1",
					runId: "run-1",
				},
			],
		});

		expect(planArtifacts.upsertPlanArtifact).toHaveBeenCalledTimes(1);
		expect(planArtifacts.updatePlanArtifactStatus).toHaveBeenCalledTimes(1);
		expect(mlflowTraceLineage.upsertTraceLineageLinks).toHaveBeenCalledTimes(1);
	});
});
