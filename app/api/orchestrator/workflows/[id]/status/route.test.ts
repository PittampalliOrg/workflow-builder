import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.hoisted(() => vi.fn());
const mockGetWorkflowStatus = vi.hoisted(() => vi.fn());
const mockGetOrchestratorUrlAsync = vi.hoisted(() => vi.fn());
const mockGetSchemaGuardResponse = vi.hoisted(() => vi.fn());
const mockSelect = vi.hoisted(() => vi.fn());
const mockUpdateSet = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth-helpers", () => ({
	getSession: mockGetSession,
}));

vi.mock("@/lib/dapr-client", () => ({
	genericOrchestratorClient: {
		getWorkflowStatus: mockGetWorkflowStatus,
	},
}));

vi.mock("@/lib/dapr/config-provider", () => ({
	getOrchestratorUrlAsync: mockGetOrchestratorUrlAsync,
}));

vi.mock("@/lib/db/workflow-executions-schema-guard", () => ({
	getWorkflowExecutionsSchemaGuardResponse: mockGetSchemaGuardResponse,
}));

vi.mock("@/lib/db", () => ({
	db: {
		select: mockSelect,
		update: vi.fn(() => ({
			set: mockUpdateSet,
		})),
	},
}));

import { GET } from "./route";

function buildSelectChain(result: unknown) {
	return {
		from: vi.fn(() => ({
			where: vi.fn(() => ({
				limit: vi.fn(async () => result),
				orderBy: vi.fn(async () => result),
			})),
		})),
	};
}

describe("GET /api/orchestrator/workflows/[id]/status", () => {
	beforeEach(() => {
		mockGetSession.mockReset();
		mockGetWorkflowStatus.mockReset();
		mockGetOrchestratorUrlAsync.mockReset();
		mockGetSchemaGuardResponse.mockReset();
		mockSelect.mockReset();
		mockUpdateSet.mockReset();

		mockGetSession.mockResolvedValue({
			user: {
				id: "user-1",
			},
		});
		mockGetSchemaGuardResponse.mockResolvedValue(null);
		mockGetOrchestratorUrlAsync.mockResolvedValue(
			"http://workflow-orchestrator.workflow-builder.svc.cluster.local:8080",
		);
		mockUpdateSet.mockReturnValue({
			where: vi.fn(async () => undefined),
		});
	});

	it("surfaces a child OpenShell traceId when runtime status omits it", async () => {
		mockSelect
			.mockReturnValueOnce(
				buildSelectChain([
					{
						id: "exec-1",
						workflowId: "wf-1",
						userId: "user-1",
						status: "running",
						phase: "executing",
						progress: 50,
						daprInstanceId: "instance-1",
						output: null,
						error: null,
						errorStackTrace: null,
						startedAt: new Date("2026-03-20T11:47:17.400Z"),
					},
				]),
			)
			.mockReturnValueOnce(
				buildSelectChain([
					{
						id: "wf-1",
						userId: "user-1",
						daprOrchestratorUrl:
							"http://workflow-orchestrator.workflow-builder.svc.cluster.local:8080",
					},
				]),
			)
			.mockReturnValueOnce(
				buildSelectChain([
					{
						result: {
							traceId: "trace-child-1",
						},
					},
				]),
			);

		mockGetWorkflowStatus.mockResolvedValue({
			runtimeStatus: "RUNNING",
			phase: "executing",
			progress: 50,
			message: "Executing approved plan",
			currentNodeId: "da_agent_system_demo",
			currentNodeName: "OpenShell Feature Delivery",
			approvalEventName: null,
			outputs: {
				success: true,
			},
			error: null,
			stackTrace: null,
			parentInstanceId: null,
			completedAt: null,
			workflowVersion: "v1",
			workflowNameVersioned: "dynamic_workflow@v1",
		});

		const response = await GET(
			new Request("http://localhost/api/orchestrator/workflows/exec-1/status"),
			{ params: Promise.resolve({ id: "exec-1" }) },
		);
		const json = await response.json();

		expect(response.status).toBe(200);
		expect(json.traceId).toBe("trace-child-1");
		expect(json.phase).toBe("executing");
		expect(json.status).toBe("running");
	});
});
