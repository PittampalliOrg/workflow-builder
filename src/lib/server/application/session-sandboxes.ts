import type {
	SessionLifecycleController,
	SessionRepository,
	SessionSandboxDeleteKind,
	SessionSandboxDeleteResult,
	SessionSandboxDestroyer,
} from "$lib/server/application/ports";

export type SessionSandboxCommandInput = {
	sessionId: string;
	userId: string;
	projectId?: string | null;
};

export type SessionSandboxCommandResult =
	| {
			status: "ok";
			body: Record<string, unknown>;
			httpStatus?: number;
	  }
	| { status: "not_found"; message: string }
	| { status: "conflict"; message: string };

export class ApplicationSessionSandboxService {
	constructor(
		private readonly deps: {
			sessions: Pick<SessionRepository, "getSession">;
			lifecycle: SessionLifecycleController;
			sandboxes: SessionSandboxDestroyer;
		},
	) {}

	async deleteSessionSandboxes(
		input: SessionSandboxCommandInput,
	): Promise<SessionSandboxCommandResult> {
		const access = await this.deps.lifecycle.checkSessionAccess(input);
		if (access.status === "not_found") return sessionNotFound();
		if (access.active) {
			return {
				status: "conflict",
				message:
					"Stop the run before destroying its sandbox (POST /api/v1/sessions/[id]/stop {mode:'purge'})",
			};
		}

		const session = await this.deps.sessions.getSession(input.sessionId);
		if (!session) return sessionNotFound();

		const targets: Array<{ name: string; kind: SessionSandboxDeleteKind }> = [];
		if (session.runtimeSandboxName) {
			targets.push({ name: session.runtimeSandboxName, kind: "runtime" });
		}
		if (
			session.workspaceSandboxName &&
			session.workspaceSandboxName !== session.runtimeSandboxName
		) {
			targets.push({ name: session.workspaceSandboxName, kind: "workspace" });
		}

		if (targets.length === 0) {
			return {
				status: "ok",
				httpStatus: 409,
				body: {
					ok: false,
					error: "session_sandbox_delete_not_supported",
					message: "This session does not have a per-session sandbox to destroy.",
				},
			};
		}

		const results: SessionSandboxDeleteResult[] = [];
		for (const target of targets) {
			results.push(
				target.kind === "runtime"
					? await this.deps.sandboxes.deleteRuntimeSandbox(target.name)
					: await this.deps.sandboxes.deleteWorkspaceSandbox(target.name),
			);
		}

		const errors = results.filter((result) => result.status === "error");
		if (errors.length > 0) {
			return {
				status: "ok",
				httpStatus: 502,
				body: {
					ok: false,
					error: "session_sandbox_delete_failed",
					message: "Failed to destroy one or more session sandboxes.",
					results,
				},
			};
		}

		return {
			status: "ok",
			body: {
				ok: true,
				deleted: results.some((result) => result.status === "deleted"),
				results,
			},
		};
	}
}

function sessionNotFound(): { status: "not_found"; message: string } {
	return { status: "not_found", message: "Session not found" };
}
