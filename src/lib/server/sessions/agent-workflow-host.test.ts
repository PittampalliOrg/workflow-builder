import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentWorkflowHostPod } from "$lib/server/kube/client";
import {
	extractTraceContext,
	maybeProvisionAgentWorkflowHost,
	waitForAgentWorkflowHostAppReady,
} from "./agent-workflow-host";

vi.mock("$lib/server/kube/client", () => ({
	getAgentWorkflowHostPod: vi.fn(),
}));

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

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

describe("agent workflow host provisioning", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		vi.stubEnv("AGENT_WORKFLOW_HOST_BACKEND", "kueue");
		vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-execution-api");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(
					JSON.stringify({
						agentAppId: "agent-session-returned",
						sandboxName: "agent-host-agent-session-returned",
						status: "ready",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}) as unknown as typeof fetch,
		);
	});

	it("omits timeoutSeconds for direct interactive session hosts", async () => {
		await maybeProvisionAgentWorkflowHost({
			sessionId: "session-direct-1",
			agentConfig: { mcpServers: [] } as never,
			workflowExecutionId: null,
			benchmarkRunId: null,
			benchmarkInstanceId: null,
			timeoutMinutes: null,
		});

		const call = vi.mocked(fetch).mock.calls[0];
		const body = JSON.parse(String(call?.[1]?.body ?? "{}")) as Record<
			string,
			unknown
		>;
		expect(body).not.toHaveProperty("timeoutSeconds");
		expect(body.executionClass).toBe("interactive-agent");
		expect(body.priorityClass).toBe("interactive-agent");
	});

	it("keeps workflow-driven hosts bounded when no timeout is provided", async () => {
		await maybeProvisionAgentWorkflowHost({
			sessionId: "session-workflow-1",
			agentConfig: { mcpServers: [] } as never,
			workflowExecutionId: "exec-1",
			benchmarkRunId: null,
			benchmarkInstanceId: null,
			timeoutMinutes: null,
		});

		const call = vi.mocked(fetch).mock.calls[0];
		const body = JSON.parse(String(call?.[1]?.body ?? "{}")) as Record<
			string,
			unknown
		>;
		expect(body.timeoutSeconds).toBe(900);
		expect(body.executionClass).toBe("interactive-agent");
	});

	it("honors explicit host timeouts", async () => {
		await maybeProvisionAgentWorkflowHost({
			sessionId: "session-direct-2",
			agentConfig: { mcpServers: [] } as never,
			workflowExecutionId: null,
			benchmarkRunId: null,
			benchmarkInstanceId: null,
			timeoutMinutes: 7,
		});

		const call = vi.mocked(fetch).mock.calls[0];
		const body = JSON.parse(String(call?.[1]?.body ?? "{}")) as Record<
			string,
			unknown
		>;
		expect(body.timeoutSeconds).toBe(420);
	});

	it("passes the Claude runtime image override for claude-agent-py sessions", async () => {
		vi.stubEnv(
			"AGENT_RUNTIME_CLAUDE_DEFAULT_IMAGE",
			"ghcr.io/example/claude-agent-py-sandbox:git-1",
		);

		await maybeProvisionAgentWorkflowHost({
			sessionId: "session-claude-1",
			agentConfig: { runtime: "claude-agent-py", mcpServers: [] } as never,
			workflowExecutionId: "exec-1",
			benchmarkRunId: null,
			benchmarkInstanceId: null,
			timeoutMinutes: null,
		});

		const call = vi.mocked(fetch).mock.calls[0];
		const body = JSON.parse(String(call?.[1]?.body ?? "{}")) as Record<
			string,
			unknown
		>;
		expect(body.agentImage).toBe("ghcr.io/example/claude-agent-py-sandbox:git-1");
	});

	it("uses benchmark queue and priority defaults for benchmark sessions", async () => {
		await maybeProvisionAgentWorkflowHost({
			sessionId: "session-benchmark-1",
			agentConfig: { mcpServers: [] } as never,
			workflowExecutionId: "exec-1",
			benchmarkRunId: "run-1",
			benchmarkInstanceId: "sympy__sympy-20590",
			timeoutMinutes: null,
		});

		const call = vi.mocked(fetch).mock.calls[0];
		const body = JSON.parse(String(call?.[1]?.body ?? "{}")) as Record<
			string,
			unknown
		>;
		expect(body.executionClass).toBe("benchmark-fast");
		expect(body.priorityClass).toBe("swebench-cohort");
	});

	it("routes benchmark sessions to a stable app id without creating a per-session host when configured", async () => {
		vi.stubEnv("BENCHMARK_AGENT_WORKFLOW_STABLE_APP_ID", "dapr-agent-py");

		const result = await maybeProvisionAgentWorkflowHost({
			sessionId: "session-benchmark-stable",
			agentConfig: { mcpServers: [] } as never,
			workflowExecutionId: "exec-1",
			benchmarkRunId: "run-1",
			benchmarkInstanceId: "sympy__sympy-20590",
			timeoutMinutes: null,
		});

		expect(result).toEqual({
			agentAppId: "dapr-agent-py",
			sandboxName: null,
			status: "stable-app-id",
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does not route interactive CLI benchmark sessions through the stable dapr-agent app id", async () => {
		vi.stubEnv("BENCHMARK_AGENT_WORKFLOW_STABLE_APP_ID", "dapr-agent-py");
		vi.stubEnv(
			"AGENT_RUNTIME_CODEX_CLI_DEFAULT_IMAGE",
			"ghcr.io/example/cli-agent-py-sandbox:git-1",
		);

		const result = await maybeProvisionAgentWorkflowHost({
			sessionId: "session-benchmark-codex",
			agentConfig: {
				runtime: "codex-cli",
				mcpServers: [],
				builtinTools: [],
				skills: [],
				mcpConnectionMode: "explicit",
			} as never,
			workflowExecutionId: "exec-1",
			benchmarkRunId: "run-1",
			benchmarkInstanceId: "sympy__sympy-20590",
			timeoutMinutes: null,
		});

		expect(result).toEqual({
			agentAppId: "agent-session-returned",
			sandboxName: "agent-host-agent-session-returned",
			status: "ready",
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		const call = vi.mocked(fetch).mock.calls[0];
		const body = JSON.parse(String(call?.[1]?.body ?? "{}")) as Record<
			string,
			unknown
		>;
		expect(body.agentAppId).toMatch(/^agent-session-/);
		expect(body.executionClass).toBe("interactive-cli");
		expect(body.agentImage).toBe(
			"ghcr.io/example/cli-agent-py-sandbox:git-1",
		);
	});

	it("preserves AGY's dedicated interactive-cli class for benchmark sessions", async () => {
		vi.stubEnv("BENCHMARK_AGENT_WORKFLOW_STABLE_APP_ID", "dapr-agent-py");
		vi.stubEnv(
			"AGENT_RUNTIME_AGY_CLI_DEFAULT_IMAGE",
			"ghcr.io/example/cli-agent-py-sandbox:git-agy",
		);

		await maybeProvisionAgentWorkflowHost({
			sessionId: "session-benchmark-agy",
			agentConfig: {
				runtime: "agy-cli",
				mcpServers: [],
				builtinTools: [],
				skills: [],
				mcpConnectionMode: "explicit",
			} as never,
			workflowExecutionId: "exec-1",
			benchmarkRunId: "run-1",
			benchmarkInstanceId: "sympy__sympy-20590",
			timeoutMinutes: null,
		});

		const call = vi.mocked(fetch).mock.calls[0];
		const body = JSON.parse(String(call?.[1]?.body ?? "{}")) as Record<
			string,
			unknown
		>;
		expect(body.executionClass).toBe("interactive-cli-agy");
		expect(body.agentImage).toBe(
			"ghcr.io/example/cli-agent-py-sandbox:git-agy",
		);
	});

	it("lets env override benchmark host queue class", async () => {
		vi.stubEnv("BENCHMARK_AGENT_WORKFLOW_HOST_EXECUTION_CLASS", "secure-gvisor");
		vi.stubEnv("BENCHMARK_AGENT_WORKFLOW_HOST_PRIORITY_CLASS", "interactive-agent");

		await maybeProvisionAgentWorkflowHost({
			sessionId: "session-benchmark-2",
			agentConfig: { mcpServers: [] } as never,
			workflowExecutionId: "exec-1",
			benchmarkRunId: "run-1",
			benchmarkInstanceId: "sympy__sympy-20590",
			timeoutMinutes: null,
		});

		const call = vi.mocked(fetch).mock.calls[0];
		const body = JSON.parse(String(call?.[1]?.body ?? "{}")) as Record<
			string,
			unknown
		>;
		expect(body.executionClass).toBe("secure-gvisor");
		expect(body.priorityClass).toBe("interactive-agent");
	});

	it("uses the benchmark run execution class before global benchmark env", async () => {
		vi.stubEnv("BENCHMARK_AGENT_WORKFLOW_HOST_EXECUTION_CLASS", "secure-gvisor");
		vi.stubEnv("BENCHMARK_EXECUTION_CLASS", "benchmark-fast");

		await maybeProvisionAgentWorkflowHost({
			sessionId: "session-benchmark-3",
			agentConfig: { mcpServers: [] } as never,
			workflowExecutionId: "exec-1",
			benchmarkRunId: "run-1",
			benchmarkInstanceId: "sympy__sympy-20590",
			benchmarkExecutionClass: "benchmark-minimal-agent",
			timeoutMinutes: null,
		});

		const call = vi.mocked(fetch).mock.calls[0];
		const body = JSON.parse(String(call?.[1]?.body ?? "{}")) as Record<
			string,
			unknown
		>;
		expect(body.executionClass).toBe("benchmark-minimal-agent");
		expect(body.priorityClass).toBe("swebench-cohort");
	});
});
