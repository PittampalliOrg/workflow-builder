import { describe, expect, it, vi } from "vitest";
import type { TerminalRuntimeHostCleanupPort } from "$lib/server/application/ports";
import { ApplicationSessionRuntimeHostCleanupService } from "$lib/server/application/session-runtime-host-cleanup";
import { runScheduledTerminalRuntimeHostCleanupPass } from "./session-reconciler-deps";
import { SandboxExecutionApiSessionSandboxDestroyer } from "./session-sandbox-destroyer";

describe("scheduled terminal runtime-host cleanup pass", () => {
	it("contains a scan failure and retries the durable obligation on the next tick", async () => {
		const cleanup: TerminalRuntimeHostCleanupPort = {
			requestReap: vi.fn(),
			reapPending: vi
				.fn()
				.mockRejectedValueOnce(new Error("database temporarily unavailable"))
				.mockResolvedValueOnce({
					scanned: 1,
					acknowledged: ["session-1"],
					failed: [],
					dryRun: false,
				}),
		};

		await expect(
			runScheduledTerminalRuntimeHostCleanupPass(cleanup, {
				limit: 20,
				dryRun: false,
			}),
		).resolves.toEqual({
			scanned: 0,
			acknowledged: [],
			failed: [
				{
					sessionId: "<scan>",
					error: "database temporarily unavailable",
				},
			],
			dryRun: false,
		});

		await expect(
			runScheduledTerminalRuntimeHostCleanupPass(cleanup, {
				limit: 20,
				dryRun: false,
			}),
		).resolves.toMatchObject({
			acknowledged: ["session-1"],
			failed: [],
		});
		 expect(cleanup.reapPending).toHaveBeenCalledTimes(2);
	});

	it("returns from the periodic lane when the provider request never settles", async () => {
		const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
		const adapter = new SandboxExecutionApiSessionSandboxDestroyer(
			fetchImpl,
			() => ({ baseUrl: "http://sea:8080", token: "token" }),
			5,
		);
		const cleanup = new ApplicationSessionRuntimeHostCleanupService({
			sessions: {
				listPendingTerminalRuntimeHostCleanups: vi.fn(async () => [
					{
						sessionId: "session-1",
						runtimeAppId: "agent-session-1",
						instanceId: "session-1",
						runtimeSandboxName: "agent-host-agent-session-1",
					},
				]),
				claimTerminalRuntimeHostCleanup: vi.fn(async () => true),
				acknowledgeTerminalRuntimeHostCleanup: vi.fn(async () => true),
			},
			runtimeInspector: {
				inspectRuntimeInstance: vi.fn(async () => "terminal" as const),
			},
			sandboxes: adapter,
		});

		await expect(
			runScheduledTerminalRuntimeHostCleanupPass(cleanup, {
				limit: 20,
				dryRun: false,
			}),
		).resolves.toMatchObject({
			scanned: 1,
			acknowledged: [],
			failed: [
				{
					sessionId: "session-1",
					error: "sandbox-execution-api request timed out after 5ms",
				},
			],
		});
	});

	it("returns from the periodic lane when runtime inspection never settles", async () => {
		const deleteRuntimeSandbox = vi.fn();
		const cleanup = new ApplicationSessionRuntimeHostCleanupService({
			sessions: {
				listPendingTerminalRuntimeHostCleanups: vi.fn(async () => [
					{
						sessionId: "session-1",
						runtimeAppId: "agent-session-1",
						instanceId: "session-1",
						runtimeSandboxName: "agent-host-agent-session-1",
					},
				]),
				claimTerminalRuntimeHostCleanup: vi.fn(async () => true),
				acknowledgeTerminalRuntimeHostCleanup: vi.fn(async () => true),
			},
			runtimeInspector: {
				inspectRuntimeInstance: vi.fn(
					() => new Promise<"terminal">(() => {}),
				),
			},
			sandboxes: { deleteRuntimeSandbox },
			runtimeInspectionTimeoutMs: 5,
		});

		await expect(
			runScheduledTerminalRuntimeHostCleanupPass(cleanup, {
				limit: 20,
				dryRun: false,
			}),
		).resolves.toMatchObject({
			scanned: 1,
			acknowledged: [],
			failed: [
				{
					sessionId: "session-1",
					error: "runtime closure could not be confirmed",
				},
			],
		});
		expect(deleteRuntimeSandbox).not.toHaveBeenCalled();
	});

	it("does not acknowledge a bare SEA 404 from a skewed or missing route", async () => {
		const acknowledge = vi.fn(async () => true);
		const adapter = new SandboxExecutionApiSessionSandboxDestroyer(
			vi.fn<typeof fetch>(async () => new Response("not found", { status: 404 })),
			() => ({ baseUrl: "http://old-sea:8080", token: "token" }),
			50,
		);
		const cleanup = new ApplicationSessionRuntimeHostCleanupService({
			sessions: {
				listPendingTerminalRuntimeHostCleanups: vi.fn(async () => [
					{
						sessionId: "session-1",
						runtimeAppId: "agent-session-1",
						instanceId: "session-1",
						runtimeSandboxName: "agent-host-agent-session-1",
					},
				]),
				claimTerminalRuntimeHostCleanup: vi.fn(async () => true),
				acknowledgeTerminalRuntimeHostCleanup: acknowledge,
			},
			runtimeInspector: {
				inspectRuntimeInstance: vi.fn(async () => "terminal" as const),
			},
			sandboxes: adapter,
		});

		await expect(
			runScheduledTerminalRuntimeHostCleanupPass(cleanup, {
				limit: 8,
				dryRun: false,
			}),
		).resolves.toMatchObject({
			acknowledged: [],
			failed: [
				{
					sessionId: "session-1",
					error: "sandbox-execution-api HTTP 404",
				},
			],
		});
		expect(acknowledge).not.toHaveBeenCalled();
	});
});
