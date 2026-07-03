import type { UserEvent } from "$lib/types/sessions";
import type {
	SessionGoalHarnessResolver,
	SessionGoalLoopDriver,
	SessionGoalRecord,
	SessionGoalScopeGuard,
	SessionGoalStore,
	SessionRepository,
	SessionUserEventCommandPort,
} from "$lib/server/application/ports";

export type SessionGoalCommandInput = {
	sessionId: string;
	userId: string;
	projectId?: string | null;
};

export type GetSessionGoalResult =
	| {
			status: "ok";
			goal: SessionGoalRecord | null;
			nativeGoalAvailable: boolean;
	  }
	| { status: "not_found"; message: string };

export type SetSessionGoalInput = SessionGoalCommandInput & {
	body: Record<string, unknown>;
};

export type SetSessionGoalResult =
	| { status: "goal"; goal: SessionGoalRecord }
	| { status: "native"; native: true; objective: string }
	| { status: "invalid"; message: string }
	| { status: "not_found"; message: string };

export type UpdateSessionGoalStatusInput = SessionGoalCommandInput & {
	body: Record<string, unknown>;
};

export type UpdateSessionGoalStatusResult =
	| { status: "goal"; goal: SessionGoalRecord }
	| { status: "native"; native: true }
	| { status: "invalid"; message: string }
	| { status: "not_found"; message: string };

export type EnsureWorkflowEvaluatorGoalInput = {
	sessionId: string;
	objective: string;
	tokenBudget?: number | null;
	maxIterations?: number | null;
	workflowExecutionId?: string | null;
	acceptanceCriteria?: string[] | null;
	evidencePlan?: { commands: string[] } | null;
};

export type EnsureWorkflowEvaluatorGoalResult =
	| { status: "created"; goal: SessionGoalRecord }
	| { status: "skipped"; goal: SessionGoalRecord }
	| { status: "failed"; message: string };

export class ApplicationSessionGoalService {
	constructor(
		private readonly deps: {
			sessions: SessionRepository;
			goals: SessionGoalStore;
			goalLoop: SessionGoalLoopDriver;
			goalHarness: SessionGoalHarnessResolver;
			scopeGuard: SessionGoalScopeGuard;
			userEvents: SessionUserEventCommandPort;
		},
	) {}

	async getSessionGoal(
		input: SessionGoalCommandInput,
	): Promise<GetSessionGoalResult> {
		const scoped = await this.deps.scopeGuard.checkSessionScope(input);
		if (scoped === "not_found") {
			return { status: "not_found", message: "Session not found" };
		}

		const [goal, nativeGoalAvailable] = await Promise.all([
			this.deps.goals.getCurrentGoal(input.sessionId),
			this.deps.goalHarness.sessionHasNativeGoalHarness(input.sessionId),
		]);
		return { status: "ok", goal, nativeGoalAvailable };
	}

	async setSessionGoal(
		input: SetSessionGoalInput,
	): Promise<SetSessionGoalResult> {
		const scoped = await this.deps.scopeGuard.checkSessionScope(input);
		if (scoped === "not_found") {
			return { status: "not_found", message: "Session not found" };
		}

		const rawObjective =
			typeof input.body.objective === "string"
				? input.body.objective.trim()
				: "";
		if (!rawObjective) {
			return { status: "invalid", message: "objective is required" };
		}

		const { native, objective } = this.deps.goalHarness.decideGoalHarness(
			rawObjective,
			await this.deps.goalHarness.sessionHasNativeGoalHarness(input.sessionId),
		);
		if (native) {
			await this.sendNativeGoalCommand(input, `/goal ${objective}`);
			return { status: "native", native: true, objective };
		}

		const session = await this.deps.sessions.getSession(input.sessionId);
		if (!session) return { status: "not_found", message: "Session not found" };

		const tokenBudget =
			typeof input.body.tokenBudget === "number" ? input.body.tokenBudget : null;
		const maxIterations =
			typeof input.body.maxIterations === "number"
				? input.body.maxIterations
				: undefined;
		const acceptanceCriteria = parseStringArray(input.body.acceptanceCriteria);
		const evidenceCommands = parseStringArray(
			(input.body.evidence as Record<string, unknown> | undefined)?.commands,
		);

		const goal = await this.deps.goals.createOrReplaceGoal({
			sessionId: input.sessionId,
			objective,
			tokenBudget,
			maxIterations,
			workflowExecutionId: session.workflowExecutionId ?? null,
			acceptanceCriteria,
			evidencePlan: evidenceCommands ? { commands: evidenceCommands } : null,
		});

		await this.deps.goalLoop.kickSessionGoalLoop(input.sessionId, {
			kickoff: true,
		});
		return { status: "goal", goal };
	}

	async updateSessionGoalStatus(
		input: UpdateSessionGoalStatusInput,
	): Promise<UpdateSessionGoalStatusResult> {
		const scoped = await this.deps.scopeGuard.checkSessionScope(input);
		if (scoped === "not_found") {
			return { status: "not_found", message: "Session not found" };
		}

		const status = typeof input.body.status === "string" ? input.body.status : "";
		if (status !== "complete" && status !== "paused") {
			return { status: "invalid", message: "status must be 'complete' or 'paused'" };
		}

		const goal =
			status === "complete"
				? await this.deps.goals.markGoalComplete(input.sessionId)
				: await this.deps.goals.pauseGoal(input.sessionId);
		if (goal) return { status: "goal", goal };

		if (await this.deps.goalHarness.sessionHasNativeGoalHarness(input.sessionId)) {
			await this.sendNativeGoalCommand(input, "/goal clear");
			return { status: "native", native: true };
		}

		return { status: "not_found", message: "No active goal for this session" };
	}

	async ensureWorkflowEvaluatorGoal(
		input: EnsureWorkflowEvaluatorGoalInput,
	): Promise<EnsureWorkflowEvaluatorGoalResult> {
		try {
			const existing = await this.deps.goals.getCurrentGoal(input.sessionId);
			if (existing && existing.status !== "complete") {
				return { status: "skipped", goal: existing };
			}
			const goal = await this.deps.goals.createOrReplaceGoal({
				sessionId: input.sessionId,
				objective: input.objective,
				tokenBudget: input.tokenBudget,
				maxIterations: input.maxIterations ?? undefined,
				workflowExecutionId: input.workflowExecutionId ?? null,
				acceptanceCriteria: input.acceptanceCriteria,
				evidencePlan: input.evidencePlan,
			});
			return { status: "created", goal };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.warn(
				`[session-goals] ensureWorkflowEvaluatorGoal failed for ${input.sessionId}:`,
				message,
			);
			return { status: "failed", message };
		}
	}

	private async sendNativeGoalCommand(
		input: SessionGoalCommandInput,
		text: string,
	): Promise<void> {
		const userMessage = {
			type: "user.message",
			content: [{ type: "text", text }],
			origin: "goal-native",
		};
		const result = await this.deps.userEvents.appendSessionUserEvents({
			sessionId: input.sessionId,
			projectId: input.projectId ?? null,
			userId: input.userId,
			events: [userMessage as unknown as UserEvent],
		});
		if (result === "not_found") {
			throw new Error("Session not found");
		}
	}
}

function parseStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const out = value
		.filter((v): v is string => typeof v === "string")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	return out.length ? out : null;
}
