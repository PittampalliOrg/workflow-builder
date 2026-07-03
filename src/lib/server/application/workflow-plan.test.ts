import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowPlanService } from "$lib/server/application/workflow-plan";
import type {
	LegacyAgentPlanReaderPort,
	WorkflowPlanArtifactRecord,
	WorkflowPlanArtifactStore,
} from "$lib/server/application/ports";

describe("ApplicationWorkflowPlanService", () => {
	let planArtifacts: Pick<WorkflowPlanArtifactStore, "listPlanArtifactsByExecutionId">;
	let legacyAgentPlans: LegacyAgentPlanReaderPort;
	let service: ApplicationWorkflowPlanService;

	beforeEach(() => {
		planArtifacts = {
			listPlanArtifactsByExecutionId: vi.fn(async () => [
				planArtifact({ planMarkdown: "## Persisted plan" }),
			]),
		};
		legacyAgentPlans = {
			getPlan: vi.fn(async () => "legacy plan"),
		};
		service = new ApplicationWorkflowPlanService({
			planArtifacts,
			legacyAgentPlans,
		});
	});

	it("returns the newest persisted plan artifact before checking legacy state", async () => {
		await expect(
			service.getExecutionPlan({ executionId: "exec-1" }),
		).resolves.toEqual({ plan: "## Persisted plan" });

		expect(planArtifacts.listPlanArtifactsByExecutionId).toHaveBeenCalledWith("exec-1");
		expect(legacyAgentPlans.getPlan).not.toHaveBeenCalled();
	});

	it("falls back to the legacy agent plan reader when no persisted plan exists", async () => {
		vi.mocked(planArtifacts.listPlanArtifactsByExecutionId).mockResolvedValueOnce([]);

		await expect(
			service.getExecutionPlan({ executionId: "exec-1" }),
		).resolves.toEqual({ plan: "legacy plan" });

		expect(legacyAgentPlans.getPlan).toHaveBeenCalledWith("exec-1");
	});

	it("returns null when the legacy reader has no plan", async () => {
		vi.mocked(planArtifacts.listPlanArtifactsByExecutionId).mockResolvedValueOnce([
			planArtifact({ planMarkdown: null }),
		]);
		vi.mocked(legacyAgentPlans.getPlan).mockResolvedValueOnce(null);

		await expect(
			service.getExecutionPlan({ executionId: "exec-1" }),
		).resolves.toEqual({ plan: null });
	});

	it("keeps route callers best-effort when the legacy reader fails", async () => {
		vi.mocked(planArtifacts.listPlanArtifactsByExecutionId).mockResolvedValueOnce([]);
		vi.mocked(legacyAgentPlans.getPlan).mockRejectedValueOnce(new Error("dapr offline"));

		await expect(
			service.getExecutionPlan({ executionId: "exec-1" }),
		).resolves.toEqual({ plan: null });
	});
});

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
