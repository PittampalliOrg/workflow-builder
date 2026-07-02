import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowData = {
		getExecutionById: vi.fn(async (id: string) => ({ id })),
		updateExecutionReadModel: vi.fn(async () => undefined),
		appendExecutionLog: vi.fn(async () => ({
			id: "log-1",
			executionId: "exec-1",
		})),
		updateExecutionLog: vi.fn(async () => ({
			id: "log-1",
			executionId: "exec-1",
			status: "success",
		})),
		upsertWorkflowWorkspaceSession: vi.fn(async () => ({
			workspaceRef: "workspace-1",
		})),
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
		getTraceTargetsForExecution: vi.fn(async () => [
			{
				entityType: "workflow_execution",
				entityId: "exec-1",
				projectId: "project-1",
				externalExperimentId: "exp-1",
				externalRunId: "run-1",
			},
		]),
		upsertTraceLineageLinks: vi.fn(async () => ({
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
import { PATCH as patchExecution } from "./executions/[executionId]/+server";
import { POST as postExecutionLog } from "./executions/[executionId]/logs/+server";
import { PATCH as patchExecutionLog } from "./executions/[executionId]/logs/[logId]/+server";
import { POST as postPlanArtifact } from "./plan-artifacts/+server";
import { PATCH as patchPlanArtifact } from "./plan-artifacts/[artifactRef]/+server";
import { GET as getTraceTargets } from "./traces/executions/[executionId]/targets/+server";
import { POST as postTraceLineage } from "./traces/lineage/+server";
import { POST as postWorkspaceSession } from "./workspace-sessions/+server";

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

	it("updates execution read models and logs through the workflow-data service", async () => {
		await patchExecution({
			params: { executionId: "exec-1" },
			request: jsonRequest({
				phase: "running",
				progress: 50,
				currentNodeId: "agent",
				currentNodeName: "Agent",
			}),
		} as never);
		await postExecutionLog({
			params: { executionId: "exec-1" },
			request: jsonRequest({
				id: "log-1",
				nodeId: "agent",
				nodeName: "Agent",
				nodeType: "action",
				activityName: "durable/run",
				status: "running",
				input: { prompt: "ship it" },
				startedAt: "2026-01-01T00:00:00.000Z",
			}),
		} as never);
		await patchExecutionLog({
			params: { executionId: "exec-1", logId: "log-1" },
			request: jsonRequest({
				status: "success",
				output: { content: "done" },
				completedAt: "2026-01-01T00:00:42.000Z",
				duration: "42",
			}),
		} as never);

		expect(mocks.workflowData.updateExecutionReadModel).toHaveBeenCalledWith("exec-1", {
			phase: "running",
			progress: 50,
			currentNodeId: "agent",
			currentNodeName: "Agent",
		});
		expect(mocks.workflowData.appendExecutionLog).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "log-1",
				executionId: "exec-1",
				nodeId: "agent",
				activityName: "durable/run",
				status: "running",
			}),
		);
		expect(mocks.workflowData.updateExecutionLog).toHaveBeenCalledWith(
			"exec-1",
			"log-1",
			expect.objectContaining({
				status: "success",
				output: { content: "done" },
				duration: "42",
			}),
		);
	});

	it("upserts workspace sessions through the workflow-data service", async () => {
		await postWorkspaceSession({
			request: jsonRequest({
				workspaceRef: "workspace-1",
				workflowExecutionId: "exec-1",
				name: "workspace_profile",
				rootPath: "/sandbox",
				backend: "openshell",
				enabledTools: ["shell"],
				status: "active",
				sandboxState: { keepAfterRun: true },
			}),
		} as never);

		expect(mocks.workflowData.upsertWorkflowWorkspaceSession).toHaveBeenCalledWith({
			workspaceRef: "workspace-1",
			workflowExecutionId: "exec-1",
			durableInstanceId: null,
			name: "workspace_profile",
			rootPath: "/sandbox",
			clonePath: null,
			backend: "openshell",
			enabledTools: ["shell"],
			status: "active",
			sandboxState: { keepAfterRun: true },
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

	it("reads trace targets and records trace lineage through the workflow-data service", async () => {
		const getResponse = await getTraceTargets({
			params: { executionId: "exec-1" },
			request: jsonRequest(),
		} as never);
		await expect(getResponse.json()).resolves.toEqual({
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

		await postTraceLineage({
			request: jsonRequest({
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
				source: "primary",
				attrs: { service: "workflow-orchestrator" },
			}),
		} as never);

		expect(mocks.workflowData.getTraceTargetsForExecution).toHaveBeenCalledWith("exec-1");
		expect(mocks.workflowData.upsertTraceLineageLinks).toHaveBeenCalledWith({
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
			source: "primary",
			attrs: { service: "workflow-orchestrator" },
		});
	});
});
