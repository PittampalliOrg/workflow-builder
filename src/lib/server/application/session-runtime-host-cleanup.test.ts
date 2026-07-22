import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	SessionRepository,
	SessionSandboxDestroyer,
} from "$lib/server/application/ports";
import {
	ApplicationSessionRuntimeHostCleanupService,
	CoalescingTerminalRuntimeHostCleanupRunner,
} from "./session-runtime-host-cleanup";

describe("ApplicationSessionRuntimeHostCleanupService", () => {
	const candidate = {
		sessionId: "session-pydantic",
		runtimeAppId: "agent-session-pydantic",
		instanceId: "session-pydantic",
		runtimeSandboxName: "agent-host-agent-session-pydantic",
	};
	let sessions: Pick<
		SessionRepository,
		| "listPendingTerminalRuntimeHostCleanups"
		| "claimTerminalRuntimeHostCleanup"
		| "acknowledgeTerminalRuntimeHostCleanup"
	>;
	let sandboxes: Pick<SessionSandboxDestroyer, "deleteRuntimeSandbox">;
	let service: ApplicationSessionRuntimeHostCleanupService;

	beforeEach(() => {
		sessions = {
			listPendingTerminalRuntimeHostCleanups: vi.fn(async () => [candidate]),
			claimTerminalRuntimeHostCleanup: vi.fn(async () => true),
			acknowledgeTerminalRuntimeHostCleanup: vi.fn(async () => true),
		};
		sandboxes = {
			deleteRuntimeSandbox: vi.fn(async (name) => ({
				name,
				kind: "runtime" as const,
				status: "deleted" as const,
			})),
		};
		service = new ApplicationSessionRuntimeHostCleanupService({
			sessions,
			runtimeInspector: {
				inspectRuntimeInstance: vi.fn(async () => "terminal" as const),
			},
			sandboxes,
			now: () => new Date("2026-07-22T12:00:00.000Z"),
		});
	});

	it("acknowledges a naturally completed Pydantic host after SEA deletion", async () => {
		await expect(
			service.reapPending({ sessionId: "session-pydantic", limit: 1 }),
		).resolves.toEqual({
			scanned: 1,
			acknowledged: ["session-pydantic"],
			failed: [],
			dryRun: false,
		});
		expect(sandboxes.deleteRuntimeSandbox).toHaveBeenCalledWith(
			"agent-host-agent-session-pydantic",
		);
		expect(sessions.acknowledgeTerminalRuntimeHostCleanup).toHaveBeenCalledWith({
				sessionId: "session-pydantic",
				runtimeAppId: "agent-session-pydantic",
				instanceId: "session-pydantic",
				runtimeSandboxName: "agent-host-agent-session-pydantic",
				completedAt: new Date("2026-07-22T12:00:00.000Z"),
		});
	});

	it("leaves the durable obligation pending on failure and retries it", async () => {
		vi.mocked(sandboxes.deleteRuntimeSandbox)
			.mockResolvedValueOnce({
				name: candidate.runtimeSandboxName,
				kind: "runtime",
				status: "error",
				error: "SEA unavailable",
			})
			.mockResolvedValueOnce({
				name: candidate.runtimeSandboxName,
				kind: "runtime",
				status: "missing",
			});

		const failed = await service.reapPending({ sessionId: candidate.sessionId });
		expect(failed.failed).toEqual([
			{ sessionId: candidate.sessionId, error: "SEA unavailable" },
		]);
		expect(sessions.acknowledgeTerminalRuntimeHostCleanup).not.toHaveBeenCalled();

		const retried = await service.reapPending({ sessionId: candidate.sessionId });
		expect(retried.acknowledged).toEqual([candidate.sessionId]);
		expect(sandboxes.deleteRuntimeSandbox).toHaveBeenCalledTimes(2);
		expect(sessions.acknowledgeTerminalRuntimeHostCleanup).toHaveBeenCalledOnce();
	});

	it("does not mutate the provider or acknowledgement in dry-run mode", async () => {
		const result = await service.reapPending({ dryRun: true });
		expect(result).toMatchObject({ scanned: 1, dryRun: true });
		expect(sandboxes.deleteRuntimeSandbox).not.toHaveBeenCalled();
		expect(sessions.claimTerminalRuntimeHostCleanup).not.toHaveBeenCalled();
		expect(sessions.acknowledgeTerminalRuntimeHostCleanup).not.toHaveBeenCalled();
	});

	it.each(["active", "unknown"] as const)(
		"leaves the host pending when runtime closure is %s",
		async (state) => {
			const runtimeInspector = {
				inspectRuntimeInstance: vi.fn(async () => state),
			};
			service = new ApplicationSessionRuntimeHostCleanupService({
				sessions,
				runtimeInspector,
				sandboxes,
			});

			const result = await service.reapPending({ sessionId: candidate.sessionId });

			expect(result.failed).toEqual([
				{
					sessionId: candidate.sessionId,
					error:
						state === "active"
							? "runtime instance is still active"
							: "runtime closure could not be confirmed",
				},
			]);
			expect(sandboxes.deleteRuntimeSandbox).not.toHaveBeenCalled();
			expect(sessions.acknowledgeTerminalRuntimeHostCleanup).not.toHaveBeenCalled();
		},
	);

	it("does not delete or acknowledge a mismatched runtime target", async () => {
		vi.mocked(sessions.listPendingTerminalRuntimeHostCleanups).mockResolvedValue([
			{
				...candidate,
				runtimeSandboxName: "agent-host-agent-session-stale",
			},
		]);

		await expect(service.reapPending({ limit: 1 })).resolves.toMatchObject({
			acknowledged: [],
			failed: [
				{
					sessionId: candidate.sessionId,
					error:
						"runtime target mismatch: agent-session-pydantic does not own agent-host-agent-session-stale",
				},
			],
		});
		expect(sandboxes.deleteRuntimeSandbox).not.toHaveBeenCalled();
		expect(sessions.acknowledgeTerminalRuntimeHostCleanup).not.toHaveBeenCalled();
	});

	it("bounds each pass and deletes with limited concurrency", async () => {
		const candidates = Array.from({ length: 12 }, (_, index) => ({
			sessionId: `session-${index}`,
			runtimeAppId: `agent-session-${index}`,
			instanceId: `session-${index}`,
			runtimeSandboxName: `agent-host-agent-session-${index}`,
		}));
		vi.mocked(sessions.listPendingTerminalRuntimeHostCleanups).mockResolvedValue(
			candidates,
		);
		let active = 0;
		let maxActive = 0;
		vi.mocked(sandboxes.deleteRuntimeSandbox).mockImplementation(async (name) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active -= 1;
			return { name, kind: "runtime", status: "missing" };
		});

		const result = await service.reapPending({ limit: 100 });

		expect(result).toMatchObject({ scanned: 12, failed: [] });
		expect(result.acknowledged).toHaveLength(8);
		expect(sandboxes.deleteRuntimeSandbox).toHaveBeenCalledTimes(8);
		expect(maxActive).toBe(4);
		expect(sessions.listPendingTerminalRuntimeHostCleanups).toHaveBeenCalledWith({
			limit: 32,
			availableBefore: new Date("2026-07-22T11:59:00.000Z"),
			sessionId: undefined,
			workflowExecutionId: undefined,
		});
	});

	it("coalesces a burst into one running and one follow-up fair sweep", async () => {
		let releaseFirstPass: (() => void) | undefined;
		const firstPass = new Promise<void>((resolve) => {
			releaseFirstPass = resolve;
		});
		vi.mocked(sessions.listPendingTerminalRuntimeHostCleanups)
			.mockImplementationOnce(async () => {
				await firstPass;
				return [];
			})
			.mockResolvedValue([]);
		service = new ApplicationSessionRuntimeHostCleanupService({
			sessions,
			runtimeInspector: {
				inspectRuntimeInstance: vi.fn(async () => "terminal" as const),
			},
			sandboxes,
			eagerRunner: new CoalescingTerminalRuntimeHostCleanupRunner(),
		});

		for (let index = 0; index < 100; index += 1) service.requestReap();
		await vi.waitFor(() =>
			expect(sessions.listPendingTerminalRuntimeHostCleanups).toHaveBeenCalledTimes(
				1,
			),
		);
		releaseFirstPass?.();
		await vi.waitFor(() =>
			expect(sessions.listPendingTerminalRuntimeHostCleanups).toHaveBeenCalledTimes(
				2,
			),
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(sessions.listPendingTerminalRuntimeHostCleanups).toHaveBeenCalledTimes(2);
	});
});
