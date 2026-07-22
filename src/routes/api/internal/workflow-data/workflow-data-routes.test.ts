import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowExecutionRuntimeProjectionResult } from "$lib/server/application/ports";

const mocks = vi.hoisted(() => {
	const workflowData = {
		assertExecutionReadModelReady: vi.fn(async () => undefined),
		getExecutionById: vi.fn(async (id: string) => ({ id })),
		getExecutionByDaprInstanceId: vi.fn(async (instanceId: string) => ({
			id: "exec-1",
			daprInstanceId: instanceId,
			status: "running",
		})),
		createWorkflowExecution: vi.fn(async () => ({ id: "exec-1" })),
		getLiveExecutionInstance: vi.fn(async () => ({
			instanceId: "sw-example-exec-exec-1",
			status: "running",
		})),
		attachExecutionSchedulerInstance: vi.fn(async () => undefined),
		markExecutionStartFailed: vi.fn(async () => undefined),
		listStaleRunningExecutions: vi.fn(async () => [
			{
				id: "exec-1",
				daprInstanceId: "sw-example-exec-exec-1",
				input: { prompt: "ship it" },
			},
		]),
		applyExecutionRuntimeProjection: vi.fn(
			async (): Promise<WorkflowExecutionRuntimeProjectionResult> => ({
				applied: true,
			}),
		),
		appendExecutionLog: vi.fn(async () => ({
			id: "log-1",
			executionId: "exec-1",
		})),
		updateExecutionLog: vi.fn(async () => ({
			id: "log-1",
			executionId: "exec-1",
			status: "success",
		})),
		upsertWorkflowArtifact: vi.fn(async () => ({ id: "artifact-1" })),
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
	const sessionRuntimeHostCleanup = {
		requestReap: vi.fn(),
	};
	const workflowExecutionRuntimeHosts = {
		requestReap: vi.fn(),
	};
	return {
		workflowData,
		sessionRuntimeHostCleanup,
		workflowExecutionRuntimeHosts,
		requireInternal: vi.fn(),
	};
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: mocks.workflowData,
		sessionRuntimeHostCleanup: mocks.sessionRuntimeHostCleanup,
		workflowExecutionRuntimeHosts: mocks.workflowExecutionRuntimeHosts,
	}),
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

import { POST as postAgentRun } from "./agent-runs/+server";
import { PATCH as patchAgentRun } from "./agent-runs/[runId]/+server";
import { GET as getStaleExecutions, POST as postExecution } from "./executions/+server";
import { PATCH as patchExecution } from "./executions/[executionId]/+server";
import { GET as getExecutionByInstance } from "./executions/by-instance/[instanceId]/+server";
import { GET as getLiveExecutionInstance } from "./executions/[executionId]/live-instance/+server";
import { POST as postWorkflowArtifact } from "./executions/[executionId]/artifacts/+server";
import { POST as postExecutionLog } from "./executions/[executionId]/logs/+server";
import { PATCH as patchExecutionLog } from "./executions/[executionId]/logs/[logId]/+server";
import { GET as getReadModelReady } from "./executions/read-model-ready/+server";
import { POST as postSchedulerInstance } from "./executions/[executionId]/scheduler-instance/+server";
import { POST as postStartFailed } from "./executions/[executionId]/start-failed/+server";
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

function routeServerFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const fullPath = join(dir, entry);
		if (statSync(fullPath).isDirectory()) return routeServerFiles(fullPath);
		return entry === "+server.ts" ? [fullPath] : [];
	});
}

describe("internal workflow-data routes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps workflow-data routes behind application services", () => {
		const routeRoot = join(process.cwd(), "src/routes/api/internal/workflow-data");
		for (const file of routeServerFiles(routeRoot)) {
			const source = readFileSync(file, "utf8");
			if (source.trimStart().startsWith("export {")) {
				expect(source, file).toContain("../../../../workflows/executions");
			} else {
				expect(source, file).toContain("getApplicationAdapters");
			}
			expect(source, file).not.toContain("$lib/server/db");
		}
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
		expect(mocks.sessionRuntimeHostCleanup.requestReap).toHaveBeenCalledOnce();
	});

	it("does not signal runtime-host cleanup while an agent run remains active", async () => {
		await patchAgentRun({
			params: { runId: "agent-run-1" },
			request: jsonRequest({ status: "running" }),
		} as never);

		expect(mocks.sessionRuntimeHostCleanup.requestReap).not.toHaveBeenCalled();
	});

	it("signals runtime-host cleanup when an agent run fails", async () => {
		await patchAgentRun({
			params: { runId: "agent-run-1" },
			request: jsonRequest({ status: "failed", error: "runtime failed" }),
		} as never);

		expect(mocks.sessionRuntimeHostCleanup.requestReap).toHaveBeenCalledOnce();
	});

	it("updates execution read models and logs through the workflow-data service", async () => {
		await getReadModelReady({
			request: jsonRequest(),
		} as never);
		await postExecution({
			request: jsonRequest({
				id: "exec-1",
				workflowId: "wf-1",
				userId: "user-1",
				projectId: "project-1",
				status: "running",
				phase: "running",
				progress: 0,
				input: { prompt: "ship it" },
				workflowSessionId: "exec-1",
			}),
		} as never);
		await getStaleExecutions({
			request: jsonRequest(),
			url: new URL("http://workflow-builder.internal/test?staleOlderThanMinutes=60"),
		} as never);
		await getExecutionByInstance({
			params: { instanceId: "sw-example-exec-exec-1" },
			request: jsonRequest(),
		} as never);
		await getLiveExecutionInstance({
			params: { executionId: "exec-1" },
			request: jsonRequest(),
		} as never);
		await postSchedulerInstance({
			params: { executionId: "exec-1" },
			request: jsonRequest({
				instanceId: "sw-example-exec-exec-1",
				workflowSessionId: "exec-1",
				primaryTraceId: "trace-1",
			}),
		} as never);
		await postStartFailed({
			params: { executionId: "exec-1" },
			request: jsonRequest({ error: "failed to start" }),
		} as never);
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
		await postWorkflowArtifact({
			params: { executionId: "exec-1" },
			request: jsonRequest({
				id: "artifact-1",
				nodeId: "agent",
				slot: "primary",
				kind: "markdown",
				title: "Agent output",
				inlinePayload: { content: "done" },
			}),
		} as never);

		expect(mocks.workflowData.applyExecutionRuntimeProjection).toHaveBeenCalledWith("exec-1", {
			phase: "running",
			progress: 50,
			currentNodeId: "agent",
			currentNodeName: "Agent",
		});
		expect(mocks.workflowData.assertExecutionReadModelReady).toHaveBeenCalledTimes(1);
		expect(mocks.workflowData.createWorkflowExecution).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "exec-1",
				workflowId: "wf-1",
				userId: "user-1",
				workflowSessionId: "exec-1",
			}),
		);
		expect(mocks.workflowData.listStaleRunningExecutions).toHaveBeenCalledWith({
			olderThanMinutes: 60,
		});
		expect(mocks.workflowData.getExecutionByDaprInstanceId).toHaveBeenCalledWith(
			"sw-example-exec-exec-1",
		);
		expect(mocks.workflowData.getLiveExecutionInstance).toHaveBeenCalledWith("exec-1");
		expect(mocks.workflowData.attachExecutionSchedulerInstance).toHaveBeenCalledWith({
			executionId: "exec-1",
			instanceId: "sw-example-exec-exec-1",
			workflowSessionId: "exec-1",
			primaryTraceId: "trace-1",
		});
		expect(mocks.workflowData.markExecutionStartFailed).toHaveBeenCalledWith({
			executionId: "exec-1",
			error: "failed to start",
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
		expect(mocks.workflowData.upsertWorkflowArtifact).toHaveBeenCalledWith({
			id: "artifact-1",
			workflowExecutionId: "exec-1",
			nodeId: "agent",
			slot: "primary",
			kind: "markdown",
			title: "Agent output",
			description: null,
			inlinePayload: { content: "done" },
			fileId: null,
			contentType: null,
			sizeBytes: null,
			metadata: null,
		});
	});

	it("reports a stop-superseded runtime projection as a benign no-op", async () => {
		mocks.workflowData.applyExecutionRuntimeProjection.mockResolvedValueOnce({
			applied: false,
			reason: "stop_requested",
			currentStatus: "running",
		});

		const response = await patchExecution({
			params: { executionId: "exec-stopping" },
			request: jsonRequest({
				status: "success",
				phase: "completed",
				progress: 100,
			}),
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			applied: false,
			reason: "stop_requested",
			currentStatus: "running",
		});
		expect(
			mocks.workflowExecutionRuntimeHosts.requestReap,
		).not.toHaveBeenCalled();
	});

	it("signals workflow helper cleanup after an applied terminal projection", async () => {
		await patchExecution({
			params: { executionId: "exec-1" },
			request: jsonRequest({ status: "success", phase: "completed" }),
		} as never);

		expect(
			mocks.workflowExecutionRuntimeHosts.requestReap,
		).toHaveBeenCalledOnce();
	});

	it("does not signal workflow helper cleanup for an active projection", async () => {
		await patchExecution({
			params: { executionId: "exec-1" },
			request: jsonRequest({ status: "running", phase: "running" }),
		} as never);

		expect(
			mocks.workflowExecutionRuntimeHosts.requestReap,
		).not.toHaveBeenCalled();
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
