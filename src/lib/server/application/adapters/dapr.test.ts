import { beforeEach, describe, expect, it, vi } from "vitest";

const daprFetchMock = vi.fn();

vi.mock("$lib/server/dapr-client", () => ({
	daprFetch: (...args: unknown[]) => daprFetchMock(...args),
	getDaprSidecarUrl: () => "http://localhost:3500",
	getOrchestratorUrl: () => "http://workflow-orchestrator",
}));

import {
	DaprCredentialStore,
	DaprEventBus,
	DaprWorkflowScheduler,
	DaprWorkflowApprovalEventPort,
} from "$lib/server/application/adapters/dapr";

describe("DaprCredentialStore", () => {
	beforeEach(() => {
		daprFetchMock.mockReset();
	});

	it("loads a secret from the selected Dapr secret store", async () => {
		daprFetchMock.mockResolvedValueOnce(
			Response.json({ "API-KEY": "secret-value" }),
		);

		const store = new DaprCredentialStore("kubernetes-secrets");
		await expect(store.resolveSecret("API-KEY")).resolves.toEqual({
			"API-KEY": "secret-value",
		});

		expect(daprFetchMock).toHaveBeenCalledWith(
			"http://localhost:3500/v1.0/secrets/kubernetes-secrets/API-KEY",
			{ signal: undefined, maxRetries: 0 },
		);
	});

	it("encodes secret store and secret names", async () => {
		daprFetchMock.mockResolvedValueOnce(Response.json({ value: "ok" }));

		const store = new DaprCredentialStore("store/name");
		await store.resolveSecret("secret/key");

		expect(String(daprFetchMock.mock.calls[0][0])).toBe(
			"http://localhost:3500/v1.0/secrets/store%2Fname/secret%2Fkey",
		);
	});

	it("fails closed on missing secret names and upstream failures", async () => {
		const store = new DaprCredentialStore("kubernetes-secrets");

		await expect(store.resolveSecret(" ")).rejects.toThrow(
			"Secret name is required",
		);

		daprFetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
		await expect(store.resolveSecret("NOPE")).rejects.toThrow(
			"Dapr secret lookup failed (404): missing",
		);
	});
});

describe("DaprEventBus", () => {
	beforeEach(() => {
		daprFetchMock.mockReset();
	});

	it("publishes to the configured Dapr pubsub component", async () => {
		daprFetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

		const bus = new DaprEventBus("preview-pubsub");
		await bus.publish("workflow.triggers", { dedupKey: "k1" });

		expect(daprFetchMock).toHaveBeenCalledWith(
			"http://localhost:3500/v1.0/publish/preview-pubsub/workflow.triggers",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ dedupKey: "k1" }),
			},
		);
	});
});

describe("DaprWorkflowScheduler", () => {
	beforeEach(() => {
		daprFetchMock.mockReset();
	});

	it("forwards dynamic-script defaults over the environment defaults", async () => {
		daprFetchMock.mockResolvedValueOnce(Response.json({ instanceId: "script-1" }));

		const scheduler = new DaprWorkflowScheduler();
		await expect(
			scheduler.startScriptWorkflow({
				orchestratorUrl: "http://workflow-orchestrator",
				headers: { "x-test": "1" },
				script: "return await agent('hi')",
				meta: { name: "defaults-test" },
				args: { target: "demo" },
				dbExecutionId: "exec-1",
				workflowId: "wf-1",
				userId: "user-1",
				projectId: "project-1",
				defaults: {
					agentRuntime: "codex-cli",
					timeoutMinutes: 12,
				},
			}),
		).resolves.toEqual({ instanceId: "script-1" });

		const body = JSON.parse(String(daprFetchMock.mock.calls[0][1].body));
		expect(body.defaults).toMatchObject({
			agentRuntime: "codex-cli",
			timeoutMinutes: 12,
		});
		expect(body.dispatchMode).toBe("batch-v2");
	});
});

describe("DaprWorkflowApprovalEventPort", () => {
	beforeEach(() => {
		daprFetchMock.mockReset();
	});

	it("raises approval events to the orchestrator workflow instance", async () => {
		daprFetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));

		const port = new DaprWorkflowApprovalEventPort();
		await expect(
			port.raiseApprovalEvent({
				instanceId: "instance/1",
				eventType: "goal_spec_approval",
				approvedBy: "user-1",
			}),
		).resolves.toEqual({ ok: true });

		expect(daprFetchMock).toHaveBeenCalledWith(
			"http://workflow-orchestrator/api/v2/workflows/instance%2F1/events",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					eventName: "goal_spec_approval",
					eventData: {
						approved: true,
						approvedBy: "user-1",
						source: "run-ui",
					},
				}),
			},
		);
	});

	it("returns response details for failed approval events", async () => {
		daprFetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));

		const port = new DaprWorkflowApprovalEventPort();

		await expect(
			port.raiseApprovalEvent({
				instanceId: "instance-1",
				eventType: "goal_spec_approval",
				approvedBy: "user-1",
			}),
		).resolves.toEqual({
			ok: false,
			status: 404,
			detail: "missing",
		});
	});
});
