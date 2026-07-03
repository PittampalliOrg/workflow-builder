import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationSessionGoalService } from "$lib/server/application/session-goals";
import type {
	SessionGoalHarnessResolver,
	SessionGoalLoopDriver,
	SessionGoalScopeGuard,
	SessionGoalStore,
	SessionRepository,
	SessionUserEventCommandPort,
} from "$lib/server/application/ports";
import type { SessionDetail } from "$lib/types/sessions";

describe("ApplicationSessionGoalService", () => {
	let sessions: SessionRepository;
	let goals: SessionGoalStore;
	let goalLoop: SessionGoalLoopDriver;
	let goalHarness: SessionGoalHarnessResolver;
	let scopeGuard: SessionGoalScopeGuard;
	let userEvents: SessionUserEventCommandPort;
	let service: ApplicationSessionGoalService;

	beforeEach(() => {
		sessions = {
			getSession: vi.fn(async () => sampleSession()),
		} as unknown as SessionRepository;
		goals = {
			getCurrentGoal: vi.fn(async () => sampleGoal()),
			createOrReplaceGoal: vi.fn(async () => sampleGoal()),
			markGoalComplete: vi.fn(async () => sampleGoal({ status: "complete" })),
			pauseGoal: vi.fn(async () => sampleGoal({ status: "paused" })),
		};
		goalLoop = {
			kickSessionGoalLoop: vi.fn(async () => undefined),
		};
		goalHarness = {
			sessionHasNativeGoalHarness: vi.fn(async () => false),
			decideGoalHarness: vi.fn((rawObjective: string, hasNative: boolean) => ({
				native: hasNative && rawObjective.startsWith("/goal "),
				objective: rawObjective.replace(/^\/goal\s*/, "").trim(),
			})),
		};
		scopeGuard = {
			checkSessionScope: vi.fn(async (): Promise<"ok"> => "ok"),
		};
		userEvents = {
			appendSessionUserEvents: vi.fn(async (): Promise<"ok"> => "ok"),
		};
		service = new ApplicationSessionGoalService({
			sessions,
			goals,
			goalLoop,
			goalHarness,
			scopeGuard,
			userEvents,
		});
	});

	it("loads the current goal and native harness availability after scope check", async () => {
		vi.mocked(goalHarness.sessionHasNativeGoalHarness).mockResolvedValue(true);

		const result = await service.getSessionGoal(commandInput());

		expect(result).toEqual({
			status: "ok",
			goal: sampleGoal(),
			nativeGoalAvailable: true,
		});
		expect(scopeGuard.checkSessionScope).toHaveBeenCalledWith(commandInput());
	});

	it("creates evaluator goals with parsed criteria and kicks the loop", async () => {
		const result = await service.setSessionGoal({
			...commandInput(),
			body: {
				objective: "ship it",
				tokenBudget: 1000,
				maxIterations: 7,
				acceptanceCriteria: [" passes ", ""],
				evidence: { commands: ["pnpm check"] },
			},
		});

		expect(result).toEqual({ status: "goal", goal: sampleGoal() });
		expect(goals.createOrReplaceGoal).toHaveBeenCalledWith({
			sessionId: "session-1",
			objective: "ship it",
			tokenBudget: 1000,
			maxIterations: 7,
			workflowExecutionId: "execution-1",
			acceptanceCriteria: ["passes"],
			evidencePlan: { commands: ["pnpm check"] },
		});
		expect(goalLoop.kickSessionGoalLoop).toHaveBeenCalledWith("session-1", {
			kickoff: true,
		});
	});

	it("hands prefixed goals to native CLI harnesses without creating BFF rows", async () => {
		vi.mocked(goalHarness.sessionHasNativeGoalHarness).mockResolvedValue(true);

		const result = await service.setSessionGoal({
			...commandInput(),
			body: { objective: "/goal finish the task" },
		});

		expect(result).toEqual({
			status: "native",
			native: true,
			objective: "finish the task",
		});
		expect(userEvents.appendSessionUserEvents).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
			userId: "user-1",
			events: [
				expect.objectContaining({
					type: "user.message",
					content: [{ type: "text", text: "/goal finish the task" }],
					origin: "goal-native",
				}),
			],
		});
		expect(goals.createOrReplaceGoal).not.toHaveBeenCalled();
		expect(goalLoop.kickSessionGoalLoop).not.toHaveBeenCalled();
	});

	it("clears native goals when no evaluator goal row exists", async () => {
		vi.mocked(goals.pauseGoal).mockResolvedValue(null);
		vi.mocked(goalHarness.sessionHasNativeGoalHarness).mockResolvedValue(true);

		const result = await service.updateSessionGoalStatus({
			...commandInput(),
			body: { status: "paused" },
		});

		expect(result).toEqual({ status: "native", native: true });
		expect(userEvents.appendSessionUserEvents).toHaveBeenCalledWith(
			expect.objectContaining({
				events: [
					expect.objectContaining({
						type: "user.message",
						content: [{ type: "text", text: "/goal clear" }],
					}),
				],
			}),
		);
	});

	it("returns not_found before storage access when scope rejects the session", async () => {
		vi.mocked(scopeGuard.checkSessionScope).mockResolvedValue("not_found");

		const result = await service.getSessionGoal(commandInput());

		expect(result).toEqual({ status: "not_found", message: "Session not found" });
		expect(goals.getCurrentGoal).not.toHaveBeenCalled();
	});

	it("creates workflow evaluator goals without route-side repository access", async () => {
		vi.mocked(goals.getCurrentGoal).mockResolvedValue(null);

		const result = await service.ensureWorkflowEvaluatorGoal({
			sessionId: "session-1",
			objective: "finish the workflow",
			tokenBudget: 500,
			maxIterations: 9,
			workflowExecutionId: "execution-1",
			acceptanceCriteria: ["tests pass"],
			evidencePlan: { commands: ["pnpm check"] },
		});

		expect(result).toEqual({ status: "created", goal: sampleGoal() });
		expect(goals.createOrReplaceGoal).toHaveBeenCalledWith({
			sessionId: "session-1",
			objective: "finish the workflow",
			tokenBudget: 500,
			maxIterations: 9,
			workflowExecutionId: "execution-1",
			acceptanceCriteria: ["tests pass"],
			evidencePlan: { commands: ["pnpm check"] },
		});
	});

	it("does not reset an existing non-complete workflow evaluator goal", async () => {
		const existing = sampleGoal({ objective: "already running" });
		vi.mocked(goals.getCurrentGoal).mockResolvedValue(existing);

		const result = await service.ensureWorkflowEvaluatorGoal({
			sessionId: "session-1",
			objective: "new objective",
		});

		expect(result).toEqual({ status: "skipped", goal: existing });
		expect(goals.createOrReplaceGoal).not.toHaveBeenCalled();
	});

	it("keeps workflow evaluator goal persistence best-effort", async () => {
		vi.mocked(goals.getCurrentGoal).mockRejectedValue(new Error("db offline"));

		const result = await service.ensureWorkflowEvaluatorGoal({
			sessionId: "session-1",
			objective: "keep going",
		});

		expect(result).toEqual({ status: "failed", message: "db offline" });
		expect(goals.createOrReplaceGoal).not.toHaveBeenCalled();
	});

	it("keeps thread goal persistence behind the sessions adapter boundary", () => {
		const source = readFileSync(
			join(process.cwd(), "src/lib/server/application/adapters/sessions.ts"),
			"utf8",
		);

		expect(source).toContain("export class PostgresSessionGoalStore");
		expect(source).toContain("from(threadGoals)");
		expect(source).not.toContain("$lib/server/goals/repo");
		expect(source).not.toContain("RepositorySessionGoalStore");
	});

	it("keeps the session adapter off the legacy DB registry shim", () => {
		const source = readFileSync(
			join(process.cwd(), "src/lib/server/application/adapters/sessions.ts"),
			"utf8",
		);

		expect(source).not.toContain("$lib/server/sessions/registry");
	});
});

function commandInput() {
	return {
		sessionId: "session-1",
		userId: "user-1",
		projectId: "project-1",
	};
}

function sampleGoal(overrides: Record<string, unknown> = {}) {
	return {
		id: "goal-row-1",
		sessionId: "session-1",
		goalId: "goal-1",
		objective: "ship it",
		status: "active",
		tokenBudget: null,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		iterations: 0,
		maxIterations: 50,
		acceptanceCriteria: null,
		evidencePlan: null,
		budgetSteeredAt: null,
		lastContinuationAt: null,
		stopReason: null,
		workflowExecutionId: "execution-1",
		createdAt: new Date("2026-05-15T12:00:00.000Z"),
		updatedAt: new Date("2026-05-15T12:00:00.000Z"),
		completedAt: null,
		...overrides,
	};
}

function sampleSession(): SessionDetail {
	return {
		id: "session-1",
		title: "Session 1",
		status: "idle",
		stopReason: null,
		agentId: "agent-1",
		agentVersion: 1,
		projectId: "project-1",
		environmentId: null,
		environmentVersion: null,
		vaultIds: [],
		usage: {},
		errorMessage: null,
		workflowExecutionId: "execution-1",
		mlflowExperimentId: null,
		mlflowRunId: null,
		mlflowParentRunId: null,
		mlflowSessionId: "session-1",
		workflowId: null,
		workflowName: null,
		agentName: "Coding Agent",
		agentSlug: "coding-agent",
		agentAvatar: null,
		agentEphemeral: false,
		createdAt: "2026-05-15T12:00:00.000Z",
		updatedAt: "2026-05-15T12:00:00.000Z",
		completedAt: null,
		archivedAt: null,
		daprInstanceId: "session-1",
		natsSubject: "session.events.session-1",
		parentExecutionId: null,
		resumedFromSessionId: null,
		sandboxName: "dapr-agent-py",
		workspaceSandboxName: null,
		runtimeAppId: null,
		runtimeSandboxName: null,
		pausedAt: null,
	};
}
