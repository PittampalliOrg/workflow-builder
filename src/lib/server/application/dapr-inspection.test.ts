import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApplicationDaprInspectionService,
	type DaprInspectionRuntimePort,
} from "$lib/server/application/dapr-inspection";

describe("ApplicationDaprInspectionService", () => {
	let runtime: DaprInspectionRuntimePort;
	let service: ApplicationDaprInspectionService;

	beforeEach(() => {
		runtime = {
			getSidecarMetadata: vi.fn(async () => ({
				metadata: {
					id: "workflow-builder",
					runtimeVersion: "1.17.0",
					enabledFeatures: ["Workflow"],
					components: [],
					subscriptions: [],
					httpEndpoints: [],
					appConnectionProperties: {},
				},
				healthy: true,
			})),
			getWorkflowCapableServices: vi.fn(() => [
				{ id: "workflow-orchestrator", introspectPath: "/introspect" },
				{ id: "fn-system", introspectPath: "/introspect" },
			]),
			invokeApp: vi.fn(async (appId: string, path: string) => {
				if (path === "/api/v2/workflows?limit=100") {
					return Response.json({
						workflows: [
							{ instanceId: "run-1", runtimeStatus: "RUNNING" },
							{ instanceId: "run-2", runtimeStatus: "COMPLETED" },
							{ instanceId: "run-3", runtimeStatus: "FAILED" },
						],
					});
				}
				if (path === "/api/v2/workflows/run-1/history") {
					return Response.json({
						events: [{ eventId: 1, eventType: "WorkflowStarted" }],
					});
				}
				if (appId === "workflow-orchestrator") {
					return Response.json({
						ready: true,
						version: "2026.7",
						runtime: "python",
						registeredWorkflows: [{ name: "workflow_main", version: "1" }],
						registeredActivities: ["execute_task"],
						features: ["workflow"],
					});
				}
				if (appId === "agent-runtime") {
					return Response.json({
						storeName: "agent-state",
						stateKey: "agent:instances",
						found: true,
						instances: {
							"inst-1": agentStateInstance({ status: "completed" }),
						},
					});
				}
				return new Response("not ready", { status: 503 });
			}),
			readState: vi.fn(async (storeName: string, key: string) => {
				if (storeName === "agent-registry" && key === "agents:default:_index") {
					return {
						found: true,
						value: { agents: ["agent-a"] },
						etag: "index-etag",
					};
				}
				if (storeName === "agent-registry" && key === "agents:default:agent-a") {
					return {
						found: true,
						value: {
							name: "Agent A",
							version: "v1",
							registered_at: "2026-01-01T00:00:00Z",
							agent: {
								appid: "agent-runtime",
								type: "assistant",
								framework: "dapr-agents",
								role: "coder",
								goal: "ship",
								metadata: {
									instancesEndpoint: "/instances",
									stateStore: "agent-state",
									stateKey: "agent:instances",
								},
							},
						},
						etag: "agent-etag",
					};
				}
				if (storeName === "agent-state" && key === "agent:instances") {
					return {
						found: true,
						value: {
							instances: {
								"inst-1": agentStateInstance({ status: "running" }),
							},
						},
						etag: "state-etag",
					};
				}
				return { found: false, value: null, etag: null };
			}),
			agentRegistryStore: vi.fn(() => "agent-registry"),
			agentRegistryTeams: vi.fn(() => ["default"]),
		};
		service = new ApplicationDaprInspectionService({ runtime });
	});

	it("loads sidecar metadata through the runtime port", async () => {
		await expect(service.getSidecarMetadata()).resolves.toMatchObject({
			healthy: true,
			metadata: { id: "workflow-builder" },
		});
		expect(runtime.getSidecarMetadata).toHaveBeenCalled();
	});

	it("builds service health from workflow-capable service introspection", async () => {
		await expect(service.getServiceHealth()).resolves.toEqual([
			{
				id: "workflow-orchestrator",
				healthy: true,
				version: "2026.7",
				runtime: "python",
				workflowCount: 1,
				activityCount: 1,
				features: ["workflow"],
			},
			{
				id: "fn-system",
				healthy: false,
				version: "unknown",
				runtime: "unknown",
				workflowCount: 0,
				activityCount: 0,
				features: [],
				error: "HTTP 503",
			},
		]);
	});

	it("discovers agent registry entries and known state keys through Dapr state ports", async () => {
		await expect(service.getAgentRegistry()).resolves.toMatchObject({
			storeName: "agent-registry",
			teams: ["default"],
			agents: [
				{
					name: "Agent A",
					metadata: {
						appId: "agent-runtime",
						instanceCount: 1,
						instancesEndpoint: "/instances",
						registryKey: "agents:default:agent-a",
						storeName: "agent-state",
						stateKey: "agent:instances",
					},
				},
			],
			diagnostics: [],
		});

		await expect(service.getKnownStateKeys()).resolves.toMatchObject({
			agents: [
				{
					key: "agents:default:_index",
					label: "Dapr Agent Registry index (default)",
					storeName: "agent-registry",
					serviceId: "dapr-agent-registry",
					metadata: { partitionKey: "agents:default" },
				},
				{
					key: "agents:default:agent-a",
					label: "Agent A (registry record)",
					storeName: "agent-registry",
					serviceId: "agent-runtime",
				},
				{
					key: "agent:instances",
					label: "Agent A (execution state)",
					storeName: "agent-state",
					serviceId: "agent-runtime",
				},
			],
		});
	});

	it("summarizes workflows and registrations through service invocation", async () => {
		await expect(service.getWorkflowSummary()).resolves.toMatchObject({
			summary: { running: 1, completed: 1, failed: 1, total: 3 },
			instances: [
				{ instanceId: "run-1", runtimeStatus: "RUNNING" },
				{ instanceId: "run-2", runtimeStatus: "COMPLETED" },
				{ instanceId: "run-3", runtimeStatus: "FAILED" },
			],
			registrations: [{ serviceId: "workflow-orchestrator", name: "workflow_main" }],
		});
		expect(runtime.invokeApp).toHaveBeenCalledWith(
			"workflow-orchestrator",
			"/api/v2/workflows?limit=100",
		);
	});

	it("loads workflow history and agent state through the runtime port", async () => {
		await expect(service.getWorkflowHistory("run-1")).resolves.toEqual({
			events: [{ eventId: 1, eventType: "WorkflowStarted" }],
		});
		await expect(
			service.getAgentDaprState({
				agentName: "Agent A",
				appId: "agent-runtime",
				instancesEndpoint: "/instances",
			}),
		).resolves.toMatchObject({
			found: true,
			storeName: "agent-state",
			stateKey: "agent:instances",
			instances: {
				"inst-1": {
					status: "completed",
					workflow_instance_id: "inst-1",
					workflow_name: "Agent A",
					source: "dapr-state",
				},
			},
		});
	});

	it("returns deterministic diagnostics when an agent record lacks state metadata", async () => {
		await expect(
			service.getAgentDaprState({ agentName: "Agent A" }),
		).resolves.toMatchObject({
			found: false,
			error:
				"This agent registry record does not declare metadata.instancesEndpoint or metadata.stateStore plus metadata.stateKey, so executions cannot be enumerated deterministically from Dapr state.",
			instances: {},
		});
	});
});

function agentStateInstance(overrides: Record<string, unknown> = {}) {
	return {
		input_value: "hello",
		output: null,
		start_time: "2026-01-01T00:00:00Z",
		end_time: null,
		status: "running",
		messages: [],
		tool_history: [],
		workflow_instance_id: null,
		session_id: null,
		...overrides,
	};
}
