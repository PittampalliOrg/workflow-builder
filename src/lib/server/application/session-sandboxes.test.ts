import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationSessionSandboxService } from "$lib/server/application/session-sandboxes";
import type {
	SessionLifecycleController,
	SessionRepository,
	SessionSandboxDestroyer,
} from "$lib/server/application/ports";
import type { SessionDetail } from "$lib/types/sessions";

describe("ApplicationSessionSandboxService", () => {
	let sessions: Pick<SessionRepository, "getSession">;
	let lifecycle: SessionLifecycleController;
	let sandboxes: SessionSandboxDestroyer;
	let service: ApplicationSessionSandboxService;

	beforeEach(() => {
		sessions = {
			getSession: vi.fn(async () =>
				sessionDetail({
					runtimeSandboxName: "runtime-sandbox",
					workspaceSandboxName: "workspace-sandbox",
				}),
			),
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
		sandboxes = {
			deleteRuntimeSandbox: vi.fn(async (name) => ({
				name,
				kind: "runtime" as const,
				status: "deleted" as const,
			})),
			deleteWorkspaceSandbox: vi.fn(async (name) => ({
				name,
				kind: "workspace" as const,
				status: "deleted" as const,
			})),
		};
		service = new ApplicationSessionSandboxService({
			sessions,
			lifecycle,
			sandboxes,
		});
	});

	it("blocks sandbox deletion while the durable run is active", async () => {
		vi.mocked(lifecycle.checkSessionAccess).mockResolvedValue({
			status: "ok",
			active: true,
		});

		const result = await service.deleteSessionSandboxes(commandInput());

		expect(result).toEqual({
			status: "conflict",
			message:
				"Stop the run before destroying its sandbox (POST /api/v1/sessions/[id]/stop {mode:'purge'})",
		});
		expect(sessions.getSession).not.toHaveBeenCalled();
		expect(sandboxes.deleteRuntimeSandbox).not.toHaveBeenCalled();
		expect(sandboxes.deleteWorkspaceSandbox).not.toHaveBeenCalled();
	});

	it("returns not found when lifecycle scope rejects the session", async () => {
		vi.mocked(lifecycle.checkSessionAccess).mockResolvedValue({
			status: "not_found",
		});

		const result = await service.deleteSessionSandboxes(commandInput());

		expect(result).toEqual({ status: "not_found", message: "Session not found" });
		expect(sessions.getSession).not.toHaveBeenCalled();
	});

	it("returns a route-safe conflict body when the session has no per-session sandbox", async () => {
		vi.mocked(sessions.getSession).mockResolvedValue(
			sessionDetail({
				runtimeSandboxName: null,
				workspaceSandboxName: null,
			}),
		);

		const result = await service.deleteSessionSandboxes(commandInput());

		expect(result).toEqual({
			status: "ok",
			httpStatus: 409,
			body: {
				ok: false,
				error: "session_sandbox_delete_not_supported",
				message: "This session does not have a per-session sandbox to destroy.",
			},
		});
		expect(sandboxes.deleteRuntimeSandbox).not.toHaveBeenCalled();
		expect(sandboxes.deleteWorkspaceSandbox).not.toHaveBeenCalled();
	});

	it("deletes runtime and distinct workspace sandboxes", async () => {
		const result = await service.deleteSessionSandboxes(commandInput());

		expect(sandboxes.deleteRuntimeSandbox).toHaveBeenCalledWith("runtime-sandbox");
		expect(sandboxes.deleteWorkspaceSandbox).toHaveBeenCalledWith(
			"workspace-sandbox",
		);
		expect(result).toEqual({
			status: "ok",
			body: {
				ok: true,
				deleted: true,
				results: [
					{
						name: "runtime-sandbox",
						kind: "runtime",
						status: "deleted",
					},
					{
						name: "workspace-sandbox",
						kind: "workspace",
						status: "deleted",
					},
				],
			},
		});
	});

	it("does not delete the same sandbox twice when runtime and workspace names match", async () => {
		vi.mocked(sessions.getSession).mockResolvedValue(
			sessionDetail({
				runtimeSandboxName: "shared-sandbox",
				workspaceSandboxName: "shared-sandbox",
			}),
		);

		await service.deleteSessionSandboxes(commandInput());

		expect(sandboxes.deleteRuntimeSandbox).toHaveBeenCalledWith("shared-sandbox");
		expect(sandboxes.deleteWorkspaceSandbox).not.toHaveBeenCalled();
	});

	it("surfaces adapter errors without throwing out of the route contract", async () => {
		vi.mocked(sandboxes.deleteWorkspaceSandbox).mockResolvedValue({
			name: "workspace-sandbox",
			kind: "workspace",
			status: "error",
			error: "openshell unavailable",
		});

		const result = await service.deleteSessionSandboxes(commandInput());

		expect(result).toEqual({
			status: "ok",
			httpStatus: 502,
			body: {
				ok: false,
				error: "session_sandbox_delete_failed",
				message: "Failed to destroy one or more session sandboxes.",
				results: [
					{
						name: "runtime-sandbox",
						kind: "runtime",
						status: "deleted",
					},
					{
						name: "workspace-sandbox",
						kind: "workspace",
						status: "error",
						error: "openshell unavailable",
					},
				],
			},
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

function sessionDetail(
	overrides: Partial<SessionDetail> = {},
): SessionDetail {
	return {
		id: "session-1",
		title: "Session",
		status: "terminated",
		stopReason: null,
		agentId: "agent-1",
		agentVersion: 1,
		projectId: "project-1",
		environmentId: null,
		environmentVersion: null,
		vaultIds: [],
		usage: {},
		errorMessage: null,
		workflowExecutionId: null,
		mlflowExperimentId: null,
		mlflowRunId: null,
		mlflowParentRunId: null,
		mlflowSessionId: null,
		workflowId: null,
		workflowName: null,
		agentName: null,
		agentSlug: null,
		agentAvatar: null,
		agentEphemeral: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		completedAt: "2026-01-01T00:00:00.000Z",
		archivedAt: null,
		daprInstanceId: null,
		natsSubject: null,
		parentExecutionId: null,
		resumedFromSessionId: null,
		sandboxName: null,
		workspaceSandboxName: null,
		runtimeAppId: null,
		runtimeSandboxName: null,
		pausedAt: null,
		...overrides,
	};
}
