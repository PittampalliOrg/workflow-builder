import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowData = {
		upsertScheduledAgentRun: vi.fn(async () => ({ id: "agent-run-1" })),
		updateAgentRunLifecycle: vi.fn(async () => ({
			id: "agent-run-1",
			status: "completed",
		})),
		upsertPlanArtifact: vi.fn(async () => ({
			artifactRef: "plan-1",
			storageBackend: "workflow_plan_artifacts",
			artifactType: "claude_task_graph_v1",
			status: "draft",
		})),
		updatePlanArtifactStatus: vi.fn(async () => ({
			artifactRef: "plan-1",
			status: "approved",
		})),
		getPlanArtifact: vi.fn(async () => ({ artifactRef: "plan-1" })),
		getMlflowRunTargetsForExecution: vi.fn(async () => [
			{
				entityType: "workflow_execution",
				entityId: "exec-1",
				projectId: "project-1",
				experimentId: "exp-1",
				runId: "run-1",
			},
		]),
		upsertMlflowTraceLineageLinks: vi.fn(async () => ({
			recorded: 1,
			sourceKeys: ["source-key"],
		})),
	};
	return {
		workflowData,
		requireInternal: vi.fn(),
	};
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

import { POST as postAgentRun } from "./agent-runs/+server";
import { PATCH as patchAgentRun } from "./agent-runs/[runId]/+server";
import { POST as postPlanArtifact } from "./plan-artifacts/+server";
import { PATCH as patchPlanArtifact } from "./plan-artifacts/[artifactRef]/+server";
import { GET as getMlflowRunTargets } from "./mlflow/executions/[executionId]/run-targets/+server";
import { POST as postMlflowTraceLineage } from "./mlflow/trace-lineage/+server";

function jsonRequest(body?: unknown) {
	return new Request("http://workflow-builder.internal/test", {
		method: "POST",
		body: body === undefined ? undefined : JSON.stringify(body),
		headers: body === undefined ? undefined : { "Content-Type": "application/json" },
	});
}

describe("internal workflow-data routes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("schedules and updates agent runs through the workflow-data service", async () => {
		await postAgentRun({
			request: jsonRequest({
				id: "agent-run-1",
				workflowExecutionId: "exec-1",
				workflowId: "wf-1",
				nodeId: "agent",
				mode: "run",
				agentWorkflowId: "agent-run-1",
				daprInstanceId: "agent-run-1",
				parentExecutionId: "parent-1",
			}),
		} as never);
		await patchAgentRun({
			params: { runId: "agent-run-1" },
			request: jsonRequest({
				status: "completed",
				result: { ok: true },
				eventPublished: true,
			}),
		} as never);

		expect(mocks.workflowData.upsertScheduledAgentRun).toHaveBeenCalledWith(
			expect.objectContaining({ id: "agent-run-1", mode: "run" }),
		);
		expect(mocks.workflowData.updateAgentRunLifecycle).toHaveBeenCalledWith({
			id: "agent-run-1",
			status: "completed",
			result: { ok: true },
			error: null,
			workspaceRef: null,
			eventPublished: true,
		});
	});

	it("upserts and updates plan artifacts through the workflow-data service", async () => {
		await postPlanArtifact({
			request: jsonRequest({
				artifactRef: "plan-1",
				workflowExecutionId: "exec-1",
				workflowId: "wf-1",
				nodeId: "agent",
				goal: "ship it",
				planJson: { steps: [] },
				status: "draft",
			}),
		} as never);
		await patchPlanArtifact({
			params: { artifactRef: "plan-1" },
			request: jsonRequest({ status: "approved", metadata: { reviewed: true } }),
		} as never);

		expect(mocks.workflowData.upsertPlanArtifact).toHaveBeenCalledWith(
			expect.objectContaining({ artifactRef: "plan-1", planJson: { steps: [] } }),
		);
		expect(mocks.workflowData.updatePlanArtifactStatus).toHaveBeenCalledWith({
			artifactRef: "plan-1",
			status: "approved",
			metadata: { reviewed: true },
		});
	});

	it("reads MLflow targets and records trace lineage through the workflow-data service", async () => {
		const getResponse = await getMlflowRunTargets({
			params: { executionId: "exec-1" },
			request: jsonRequest(),
		} as never);
		await expect(getResponse.json()).resolves.toEqual({
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

		await postMlflowTraceLineage({
			request: jsonRequest({
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
				source: "primary",
				attrs: { service: "workflow-orchestrator" },
			}),
		} as never);

		expect(mocks.workflowData.getMlflowRunTargetsForExecution).toHaveBeenCalledWith("exec-1");
		expect(mocks.workflowData.upsertMlflowTraceLineageLinks).toHaveBeenCalledWith({
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
			source: "primary",
			attrs: { service: "workflow-orchestrator" },
		});
	});
});
