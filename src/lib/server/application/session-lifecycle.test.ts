import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationSessionLifecycleService } from "$lib/server/application/session-lifecycle";
import type {
	SessionLifecycleController,
	SessionRepository,
} from "$lib/server/application/ports";

describe("ApplicationSessionLifecycleService", () => {
	let sessions: Pick<SessionRepository, "archiveSession" | "deleteSession">;
	let lifecycle: SessionLifecycleController;
	let service: ApplicationSessionLifecycleService;

	beforeEach(() => {
		sessions = {
			archiveSession: vi.fn(async () => true),
			deleteSession: vi.fn(async () => true),
		};
		lifecycle = {
			checkSessionAccess: vi.fn(async () => ({
				status: "ok" as const,
				active: false,
			})),
			pauseSession: vi.fn(async () => ({ ok: true })),
			resumeSession: vi.fn(async () => ({ ok: true })),
			stopSession: vi.fn(async () => ({
				confirmed: true,
				state: "confirmed",
			})),
			confirmSessionStop: vi.fn(async () => ({ state: "confirmed" })),
			getCoordinatorOwner: vi.fn(async () => null),
			pauseSessionGoal: vi.fn(async () => undefined),
		};
		service = new ApplicationSessionLifecycleService({ sessions, lifecycle });
	});

	it("pauses sessions after application-owned access checks", async () => {
		const result = await service.pauseSession(commandInput());

		expect(result).toEqual({ status: "ok", body: { paused: true } });
		expect(lifecycle.checkSessionAccess).toHaveBeenCalledWith(commandInput());
		expect(lifecycle.pauseSession).toHaveBeenCalledWith("session-1");
	});

	it("maps pause controller reasons to route-safe conflicts", async () => {
		vi.mocked(lifecycle.pauseSession).mockResolvedValue({
			ok: false,
			reason: "not_active",
		});

		const result = await service.pauseSession(commandInput());

		expect(result).toEqual({
			status: "conflict",
			message: "Session is not active - nothing to pause",
		});
	});

	it("redirects coordinator-owned session stops to the owning run", async () => {
		vi.mocked(lifecycle.getCoordinatorOwner).mockResolvedValue({
			kind: "benchmarkRun",
			runId: "bench-1",
		});

		const result = await service.stopSession({
			...commandInput(),
			body: { mode: "terminate" },
		});

		expect(result).toEqual({
			status: "ok",
			httpStatus: 409,
			body: {
				ok: false,
				error: "coordinator_owned",
				ownedBy: "benchmarkRun",
				runId: "bench-1",
				message: "This is a benchmark instance - cancel the benchmark run instead.",
			},
		});
		expect(lifecycle.stopSession).not.toHaveBeenCalled();
		expect(lifecycle.pauseSessionGoal).not.toHaveBeenCalled();
	});

	it("pauses the goal row for interrupt-mode stop requests", async () => {
		vi.mocked(lifecycle.stopSession).mockResolvedValue({
			confirmed: false,
			state: "stopping",
		});

		const result = await service.stopSession({
			...commandInput(),
			body: { mode: "interrupt", reason: "user", graceMs: 250 },
		});

		expect(lifecycle.pauseSessionGoal).toHaveBeenCalledWith("session-1");
		expect(lifecycle.stopSession).toHaveBeenCalledWith("session-1", {
			mode: "interrupt",
			reason: "user",
			graceMs: 250,
		});
		expect(result).toEqual({
			status: "ok",
			httpStatus: 202,
			body: { ok: false, confirmed: false, state: "stopping" },
		});
	});

	it("blocks delete while the durable run is still active", async () => {
		vi.mocked(lifecycle.checkSessionAccess).mockResolvedValue({
			status: "ok",
			active: true,
		});

		const result = await service.deleteSession(commandInput());

		expect(result).toEqual({
			status: "conflict",
			message: "Stop the run before deleting this session",
		});
		expect(sessions.deleteSession).not.toHaveBeenCalled();
	});

	it("maps retryable interrupt failures to unavailable", async () => {
		vi.mocked(lifecycle.stopSession).mockResolvedValue({
			confirmed: false,
			retryable: true,
		});

		const result = await service.interruptSession(commandInput());

		expect(result).toEqual({
			status: "unavailable",
			message: "Interrupt could not be delivered right now - please retry.",
		});
	});
});

function commandInput() {
	return {
		sessionId: "session-1",
		userId: "user-1",
		projectId: "project-1",
	};
}
