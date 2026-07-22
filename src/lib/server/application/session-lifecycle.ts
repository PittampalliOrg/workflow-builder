import type {
	SessionCoordinatorOwner,
	SessionLifecycleController,
	SessionLifecycleStopMode,
	SessionRepository,
} from "$lib/server/application/ports";

export type SessionLifecycleCommandInput = {
	sessionId: string;
	userId: string;
	projectId?: string | null;
};

export type SessionLifecycleResult =
	| {
			status: "ok";
			body: Record<string, unknown>;
			httpStatus?: number;
	  }
	| { status: "not_found"; message: string }
	| { status: "conflict"; message: string }
	| { status: "unavailable"; message: string };

export type StopSessionInput = SessionLifecycleCommandInput & {
	body: Record<string, unknown>;
};

const STOP_MODES = new Set<SessionLifecycleStopMode>([
	"interrupt",
	"terminate",
	"purge",
	"reset",
]);

export class ApplicationSessionLifecycleService {
	constructor(
		private readonly deps: {
			sessions: Pick<SessionRepository, "archiveSession" | "deleteSession">;
			lifecycle: SessionLifecycleController;
		},
	) {}

	getSessionCoordinatorOwner(
		sessionId: string,
	): Promise<SessionCoordinatorOwner | null> {
    return this.deps.lifecycle.getCoordinatorOwner(sessionId).catch(() => null);
	}

	async pauseSession(
		input: SessionLifecycleCommandInput,
	): Promise<SessionLifecycleResult> {
		const access = await this.requireSessionAccess(input);
		if (access.status !== "ok") return access;

		const result = await this.deps.lifecycle.pauseSession(input.sessionId);
		if (!result.ok) {
			if (result.notFound) return sessionNotFound();
			if (result.reason === "not_active") {
				return {
					status: "conflict",
					message: "Session is not active - nothing to pause",
				};
			}
			if (result.reason === "no_runtime") {
				return {
					status: "conflict",
					message: "Session has no running runtime to pause",
				};
			}
			return {
				status: "unavailable",
				message: "Pause could not be applied right now - please retry.",
			};
		}

		return { status: "ok", body: { paused: true } };
	}

	async resumeSession(
		input: SessionLifecycleCommandInput,
	): Promise<SessionLifecycleResult> {
		const access = await this.requireSessionAccess(input);
		if (access.status !== "ok") return access;

		const result = await this.deps.lifecycle.resumeSession(input.sessionId);
		if (!result.ok) {
			if (result.notFound) return sessionNotFound();
			if (result.reason === "no_runtime") {
				return {
					status: "conflict",
					message: "Session has no runtime to resume",
				};
			}
			return {
				status: "unavailable",
				message: "Resume could not be applied right now - please retry.",
			};
		}

		return { status: "ok", body: { resumed: true } };
	}

	async interruptSession(
		input: SessionLifecycleCommandInput,
	): Promise<SessionLifecycleResult> {
		const access = await this.requireSessionAccess(input);
		if (access.status !== "ok") return access;

		const result = await this.deps.lifecycle.stopSession(input.sessionId, {
			mode: "interrupt",
		});
		if (result.notFound) return sessionNotFound();
		if (!result.confirmed) {
			if (result.retryable) {
				return {
					status: "unavailable",
					message: "Interrupt could not be delivered right now - please retry.",
				};
			}
			return {
				status: "conflict",
				message: "Could not interrupt the session (it may not be running yet)",
			};
		}

		return { status: "ok", body: { interrupted: true } };
	}

	async stopSession(input: StopSessionInput): Promise<SessionLifecycleResult> {
		const access = await this.requireSessionAccess(input);
		if (access.status !== "ok") return access;

		const mode = parseStopMode(input.body.mode);
    const owner = await this.deps.lifecycle.getCoordinatorOwner(
      input.sessionId,
    );
		if (owner) {
			return {
				status: "ok",
				httpStatus: 409,
				body: {
					ok: false,
					error: "coordinator_owned",
					ownedBy: owner.kind,
					runId: owner.runId,
					message:
						owner.kind === "benchmarkRun"
							? "This is a benchmark instance - cancel the benchmark run instead."
							: "This is an evaluation instance - cancel the evaluation run instead.",
				},
			};
		}

		if (mode === "interrupt") {
      await this.deps.lifecycle
        .pauseSessionGoal(input.sessionId)
        .catch(() => {});
		}

		const result = await this.deps.lifecycle.stopSession(input.sessionId, {
			mode,
			reason:
				typeof input.body.reason === "string" ? input.body.reason : undefined,
			graceMs:
				typeof input.body.graceMs === "number" ? input.body.graceMs : undefined,
		});
		if (result.notFound) return sessionNotFound();
    if (result.retryable && !result.requested) {
      return {
        status: "unavailable",
        message: "Stop intent could not be persisted - please retry.",
      };
    }

		const httpStatus =
      result.state === "confirmed"
        ? 200
        : result.state === "stopping"
          ? 202
          : 409;
		return {
			status: "ok",
			httpStatus,
			body: { ok: result.confirmed, ...result },
		};
	}

	async getStopStatus(
		input: SessionLifecycleCommandInput,
	): Promise<SessionLifecycleResult> {
		const access = await this.requireSessionAccess(input);
		if (access.status !== "ok") return access;

    const result = await this.deps.lifecycle.confirmSessionStop(
      input.sessionId,
    );
		return { status: "ok", body: { state: result.state } };
	}

	async deleteSession(
		input: SessionLifecycleCommandInput,
	): Promise<SessionLifecycleResult> {
		const access = await this.requireSessionAccess(input);
		if (access.status !== "ok") return access;
		if (access.active) {
			return {
				status: "conflict",
				message: "Stop the run before deleting this session",
			};
		}

		const ok = await this.deps.sessions.deleteSession(input.sessionId);
		return ok ? { status: "ok", body: { deleted: true } } : sessionNotFound();
	}

	async archiveSession(
		input: SessionLifecycleCommandInput,
	): Promise<SessionLifecycleResult> {
		const access = await this.requireSessionAccess(input);
		if (access.status !== "ok") return access;
		if (access.active) {
			return {
				status: "conflict",
				message: "Stop the run before archiving this session",
			};
		}

		const ok = await this.deps.sessions.archiveSession(input.sessionId);
		return ok ? { status: "ok", body: { archived: true } } : sessionNotFound();
	}

	private async requireSessionAccess(input: SessionLifecycleCommandInput) {
		const access = await this.deps.lifecycle.checkSessionAccess(input);
		return access.status === "not_found" ? sessionNotFound() : access;
	}
}

function parseStopMode(value: unknown): SessionLifecycleStopMode {
  return typeof value === "string" &&
    STOP_MODES.has(value as SessionLifecycleStopMode)
		? (value as SessionLifecycleStopMode)
		: "terminate";
}

function sessionNotFound(): { status: "not_found"; message: string } {
	return { status: "not_found", message: "Session not found" };
}
