import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowPlanService } from "$lib/server/application/workflow-plan";
import type {
	LegacyAgentPlanReaderPort,
	WorkflowExecutionRecord,
	WorkflowPlanArtifactRecord,
} from "$lib/server/application/ports";

describe("ApplicationWorkflowPlanService", () => {
	let workflowData: ConstructorParameters<
		typeof ApplicationWorkflowPlanService
	>[0]["workflowData"];
	let legacyAgentPlans: LegacyAgentPlanReaderPort;
	let service: ApplicationWorkflowPlanService;

	beforeEach(() => {
		workflowData = {
			getScopedExecutionById: vi.fn(async () => executionRecord()),
			listPlanArtifactsByExecutionId: vi.fn(async () => [
				planArtifact({ planMarkdown: "## Persisted plan" }),
			]),
			upsertPlanArtifact: vi.fn(async () => ({
				artifactRef: "plan-generated",
				storageBackend: "workflow_plan_artifacts" as const,
				artifactType: "claude_task_graph_v1",
				status: "draft" as const,
			})),
			updatePlanArtifactStatus: vi.fn(async () => ({
				artifactRef: "plan-1",
				status: "approved" as const,
			})),
			getPlanArtifact: vi.fn(async (artifactRef: string) =>
				planArtifact({
					artifactRef,
					status: artifactRef === "plan-1" ? "approved" : "draft",
				}),
			),
		};
		legacyAgentPlans = {
			getPlan: vi.fn(async () => "legacy plan"),
		};
		service = new ApplicationWorkflowPlanService({
			workflowData,
			legacyAgentPlans,
		});
	});

	it("returns the newest persisted plan artifact before checking legacy state", async () => {
		await expect(
			service.getExecutionPlan({ executionId: "exec-1" }),
		).resolves.toEqual({ plan: "## Persisted plan" });

		expect(workflowData.listPlanArtifactsByExecutionId).toHaveBeenCalledWith("exec-1");
		expect(legacyAgentPlans.getPlan).not.toHaveBeenCalled();
	});

	it("falls back to the legacy agent plan reader when no persisted plan exists", async () => {
		vi.mocked(workflowData.listPlanArtifactsByExecutionId).mockResolvedValueOnce([]);

		await expect(
			service.getExecutionPlan({ executionId: "exec-1" }),
		).resolves.toEqual({ plan: "legacy plan" });

		expect(legacyAgentPlans.getPlan).toHaveBeenCalledWith("exec-1");
	});

	it("returns null when the legacy reader has no plan", async () => {
		vi.mocked(workflowData.listPlanArtifactsByExecutionId).mockResolvedValueOnce([
			planArtifact({ planMarkdown: null }),
		]);
		vi.mocked(legacyAgentPlans.getPlan).mockResolvedValueOnce(null);

		await expect(
			service.getExecutionPlan({ executionId: "exec-1" }),
		).resolves.toEqual({ plan: null });
	});

	it("keeps route callers best-effort when the legacy reader fails", async () => {
		vi.mocked(workflowData.listPlanArtifactsByExecutionId).mockResolvedValueOnce([]);
		vi.mocked(legacyAgentPlans.getPlan).mockRejectedValueOnce(new Error("dapr offline"));

		await expect(
			service.getExecutionPlan({ executionId: "exec-1" }),
		).resolves.toEqual({ plan: null });
	});

	it("lists plan artifacts only after scoping the execution", async () => {
		await expect(
			service.listExecutionPlanArtifacts({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toMatchObject({
			status: "ok",
			artifacts: [{ artifactRef: "plan-1" }],
		});

		expect(workflowData.getScopedExecutionById).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
		expect(workflowData.listPlanArtifactsByExecutionId).toHaveBeenCalledWith("exec-1");
	});

	it("does not list artifacts when the execution is outside scope", async () => {
		vi.mocked(workflowData.getScopedExecutionById).mockResolvedValueOnce(null);

		await expect(
			service.listExecutionPlanArtifacts({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({ status: "not_found", message: "Execution not found" });

		expect(workflowData.listPlanArtifactsByExecutionId).not.toHaveBeenCalled();
	});

	it("creates plan artifacts with a generated id after validating execution scope", async () => {
		await expect(
			service.createExecutionPlanArtifact({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
				goal: " ship it ",
				planMarkdown: "## Plan",
				planJson: { steps: [{ id: "one" }] },
				nodeId: " agent ",
				workflowId: "wf-1",
				metadata: { source: "ui" },
			}),
		).resolves.toMatchObject({
			status: "ok",
			artifact: { workflowExecutionId: "exec-1" },
		});

		expect(workflowData.getScopedExecutionById).toHaveBeenCalledWith(
			expect.objectContaining({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		);
		expect(workflowData.upsertPlanArtifact).toHaveBeenCalledWith(
			expect.objectContaining({
				workflowExecutionId: "exec-1",
				workflowId: "wf-1",
				nodeId: "agent",
				goal: "ship it",
				planJson: { steps: [{ id: "one" }] },
				metadata: { source: "ui" },
				status: "draft",
			}),
		);
		expect(workflowData.getPlanArtifact).toHaveBeenCalledWith(expect.any(String));
	});

	it("rejects plan artifact creation when required fields are missing", async () => {
		await expect(
			service.createExecutionPlanArtifact({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
				goal: "",
				nodeId: "agent",
				workflowId: "wf-1",
			}),
		).resolves.toEqual({
			status: "bad_request",
			message: "Missing required fields: goal, nodeId, workflowId",
		});

		expect(workflowData.getScopedExecutionById).not.toHaveBeenCalled();
		expect(workflowData.upsertPlanArtifact).not.toHaveBeenCalled();
	});

	it("rejects plan artifact creation when workflowId does not match the scoped execution", async () => {
		await expect(
			service.createExecutionPlanArtifact({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
				goal: "ship it",
				nodeId: "agent",
				workflowId: "wf-other",
			}),
		).resolves.toEqual({
			status: "bad_request",
			message: "workflowId does not match execution",
		});

		expect(workflowData.upsertPlanArtifact).not.toHaveBeenCalled();
	});

	it("updates a plan artifact only when it belongs to the scoped execution", async () => {
		await expect(
			service.updateExecutionPlanArtifactStatus({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
				artifactId: "plan-1",
				status: "approved",
				metadata: { reviewed: true },
			}),
		).resolves.toMatchObject({
			status: "ok",
			artifact: { artifactRef: "plan-1", status: "approved" },
		});

		expect(workflowData.getScopedExecutionById).toHaveBeenCalledWith(
			expect.objectContaining({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		);
		expect(workflowData.updatePlanArtifactStatus).toHaveBeenCalledWith({
			artifactRef: "plan-1",
			status: "approved",
			metadata: { reviewed: true },
		});
	});

	it("does not update a plan artifact from another execution", async () => {
		vi.mocked(workflowData.getPlanArtifact).mockResolvedValueOnce(
			planArtifact({ workflowExecutionId: "exec-other" }),
		);

		await expect(
			service.updateExecutionPlanArtifactStatus({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
				artifactId: "plan-1",
				status: "approved",
			}),
		).resolves.toEqual({
			status: "not_found",
			message: "Plan artifact not found",
		});

		expect(workflowData.updatePlanArtifactStatus).not.toHaveBeenCalled();
	});

	it("validates plan artifact status in the application service", async () => {
		await expect(
			service.updateExecutionPlanArtifactStatus({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
				artifactId: "plan-1",
				status: "rejected",
			}),
		).resolves.toEqual({
			status: "bad_request",
			message: "Invalid status. Must be one of: draft, approved, superseded, executed, failed",
		});

		expect(workflowData.getScopedExecutionById).not.toHaveBeenCalled();
		expect(workflowData.updatePlanArtifactStatus).not.toHaveBeenCalled();
	});
});

function executionRecord(
	overrides: Partial<WorkflowExecutionRecord> = {},
): WorkflowExecutionRecord {
	return {
		id: "exec-1",
		workflowId: "wf-1",
		userId: "user-1",
		projectId: "project-1",
		status: "running",
		input: null,
		output: null,
		executionIrVersion: null,
		executionIr: null,
		error: null,
		daprInstanceId: "exec-1",
		phase: null,
		progress: null,
		currentNodeId: null,
		currentNodeName: null,
		primaryTraceId: null,
		workflowSessionId: null,
		mlflowExperimentId: null,
		mlflowRunId: null,
		summaryOutput: null,
		errorStackTrace: null,
		rerunOfExecutionId: null,
		rerunSourceInstanceId: null,
		resumeFromNode: null,
		triggerSource: null,
		rerunFromEventId: null,
		startedAt: new Date("2026-01-01T00:00:00.000Z"),
		completedAt: null,
		duration: null,
		stopRequestedAt: null,
		stopReason: null,
		...overrides,
	};
}

function planArtifact(
	overrides: Partial<WorkflowPlanArtifactRecord> = {},
): WorkflowPlanArtifactRecord {
	return {
		artifactRef: "plan-1",
		workflowExecutionId: "exec-1",
		workflowId: "wf-1",
		userId: "user-1",
		nodeId: "agent",
		workspaceRef: null,
		clonePath: null,
		artifactType: "claude_task_graph_v1",
		artifactVersion: 1,
		status: "draft",
		goal: "ship it",
		planJson: { steps: [] },
		planMarkdown: "## Plan",
		sourcePrompt: null,
		metadata: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		...overrides,
	};
}
