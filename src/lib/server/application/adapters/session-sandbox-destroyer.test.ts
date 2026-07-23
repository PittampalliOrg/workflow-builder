import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxExecutionApiSessionSandboxDestroyer } from "./session-sandbox-destroyer";

describe("SandboxExecutionApiSessionSandboxDestroyer", () => {
	const fetchImpl = vi.fn<typeof fetch>();
	const adapter = new SandboxExecutionApiSessionSandboxDestroyer(fetchImpl, () => ({
		baseUrl: "http://sea:8080",
		token: "sea-token",
	}));

	beforeEach(() => {
		fetchImpl.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([
		["deleted", "deleted"],
		["not-found", "missing"],
	] as const)("maps SEA %s to %s", async (outcome, status) => {
		fetchImpl.mockResolvedValue(
			new Response(
				JSON.stringify({
					outcome,
					agentAppId: "agent-session-abc",
					sandboxName: "agent-host-agent-session-abc",
				}),
				{
				status: 200,
				headers: { "content-type": "application/json" },
				},
			),
		);

		await expect(
			adapter.deleteRuntimeSandbox("agent-host-agent-session-abc"),
		).resolves.toEqual({
			name: "agent-host-agent-session-abc",
			kind: "runtime",
			status,
		});
			expect(fetchImpl).toHaveBeenCalledWith(
				"http://sea:8080/api/v1/agent-workflow-hosts/agent-session-abc",
				expect.objectContaining({
					method: "DELETE",
					headers: { Authorization: "Bearer sea-token" },
					signal: expect.any(AbortSignal),
				}),
			);
	});

	it("keeps SEA error outcomes retryable", async () => {
		fetchImpl.mockResolvedValue(
			new Response(
				JSON.stringify({
					outcome: "error",
					message: "host still terminating",
					agentAppId: "agent-session-abc",
					sandboxName: "agent-host-agent-session-abc",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		await expect(
			adapter.deleteRuntimeSandbox("agent-host-agent-session-abc"),
		).resolves.toEqual({
			name: "agent-host-agent-session-abc",
			kind: "runtime",
			status: "error",
			error: "host still terminating",
		});
	});

	it("keeps a bare 404 retryable as a possible route or version mismatch", async () => {
		fetchImpl.mockResolvedValue(new Response("not found", { status: 404 }));

		await expect(
			adapter.deleteRuntimeSandbox("agent-host-agent-session-abc"),
		).resolves.toMatchObject({
			status: "error",
			error: "sandbox-execution-api HTTP 404",
		});
	});

	it("times out while a response body never finishes", async () => {
		const stalledFetch = vi.fn<typeof fetch>(async () =>
			new Response(
				new ReadableStream({
					start() {},
				}),
				{ status: 200 },
			),
		);
		const bounded = new SandboxExecutionApiSessionSandboxDestroyer(
			stalledFetch,
			() => ({ baseUrl: "http://sea:8080", token: "token" }),
			5,
		);

		await expect(
			bounded.deleteRuntimeSandbox("agent-host-agent-session-abc"),
		).resolves.toMatchObject({
			status: "error",
			error: "sandbox-execution-api request timed out after 5ms",
		});
	});

	it("normalizes an abort-aware fetch rejection to the stable timeout error", async () => {
		vi.useFakeTimers();
		const abortAwareFetch = vi.fn<typeof fetch>(
			async (_input, init) =>
				await new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) {
						reject(new Error("test request did not receive an abort signal"));
						return;
					}
					signal.addEventListener(
						"abort",
						() => reject(new DOMException("request aborted", "AbortError")),
						{ once: true },
					);
				}),
		);
		const bounded = new SandboxExecutionApiSessionSandboxDestroyer(
			abortAwareFetch,
			() => ({ baseUrl: "http://sea:8080", token: "token" }),
			5,
		);

		const cleanup = bounded.deleteRuntimeSandbox(
			"agent-host-agent-session-abc",
		);
		await vi.advanceTimersByTimeAsync(5);

		await expect(cleanup).resolves.toMatchObject({
			status: "error",
			error: "sandbox-execution-api request timed out after 5ms",
		});
	});

	it("awaits a delayed authoritative receipt under a scoped 45s deadline", async () => {
		vi.useFakeTimers();
		const delayedFetch = vi.fn<typeof fetch>(
			async (_input, init) =>
				await new Promise<Response>((resolve, reject) => {
					const timer = setTimeout(
						() =>
							resolve(
								new Response(
									JSON.stringify({
										outcome: "deleted",
										agentAppId: "agent-session-abc",
										sandboxName: "agent-host-agent-session-abc",
									}),
									{
										status: 200,
										headers: { "content-type": "application/json" },
									},
								),
							),
						31_000,
					);
					init?.signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(new DOMException("request aborted", "AbortError"));
						},
						{ once: true },
					);
				}),
		);
		const destroyer = new SandboxExecutionApiSessionSandboxDestroyer(
			delayedFetch,
			() => ({ baseUrl: "http://sea:8080", token: "token" }),
		);

		const cleanup = destroyer.deleteRuntimeSandbox(
			"agent-host-agent-session-abc",
			{ timeoutMs: 45_000 },
		);
		await vi.advanceTimersByTimeAsync(31_000);

		await expect(cleanup).resolves.toEqual({
			name: "agent-host-agent-session-abc",
			kind: "runtime",
			status: "deleted",
		});
	});

	it("rejects non-agent runtime Sandbox names without issuing a request", async () => {
		await expect(adapter.deleteRuntimeSandbox("shared-runtime")).resolves.toMatchObject({
			kind: "runtime",
			status: "error",
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
