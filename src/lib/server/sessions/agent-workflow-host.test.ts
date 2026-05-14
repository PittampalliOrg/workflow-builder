import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentWorkflowHostPod } from "$lib/server/kube/client";
import {
	extractTraceContext,
	waitForAgentWorkflowHostAppReady,
} from "./agent-workflow-host";

vi.mock("$lib/server/kube/client", () => ({
	getAgentWorkflowHostPod: vi.fn(),
}));

describe("agent workflow host trace context", () => {
	it("extracts W3C trace headers including baggage", () => {
		const headers = new Headers({
			traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
			tracestate: "vendor=value",
			baggage: "workflow.execution.id=exec_1,session.id=session_1",
		});

		expect(extractTraceContext({ headers })).toEqual({
			traceparent:
				"00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
			tracestate: "vendor=value",
			baggage: "workflow.execution.id=exec_1,session.id=session_1",
		});
	});
});

describe("agent workflow host app readiness", () => {
	beforeEach(() => {
		vi.mocked(getAgentWorkflowHostPod).mockReset();
	});

	it("polls pod app health until the host is reachable", async () => {
		const calls: string[] = [];
		vi.mocked(getAgentWorkflowHostPod)
			.mockResolvedValueOnce(null)
			.mockResolvedValue({
				name: "agent-host-agent-session-abc123",
				namespace: "workflow-builder",
				podIP: "10.244.1.20",
				containers: [
					{ name: "dapr-agent-py", ready: true },
					{ name: "daprd", ready: true },
				],
			});
		const responses = [
			new Response("not found", { status: 500 }),
			new Response("ok", { status: 200 }),
		];
		const fetchImpl = async (url: string | URL | Request) => {
			calls.push(String(url));
			return responses.shift() ?? new Response("ok", { status: 200 });
		};

		const result = await waitForAgentWorkflowHostAppReady({
			agentAppId: "agent-session-abc123",
			timeoutSeconds: 1,
			pollMs: 0,
			fetchImpl: fetchImpl as typeof fetch,
		});

		expect(result).toMatchObject({
			ok: true,
			attempts: 3,
			status: 200,
			baseUrl: "http://10.244.1.20:8002",
			podName: "agent-host-agent-session-abc123",
			podIP: "10.244.1.20",
		});
		expect(calls).toEqual([
			"http://10.244.1.20:8002/healthz",
			"http://10.244.1.20:8002/healthz",
		]);
	});
});
