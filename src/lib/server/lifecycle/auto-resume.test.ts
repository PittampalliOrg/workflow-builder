import { describe, expect, it, vi } from "vitest";
import {
	countResumeLineageDepth,
	decideAutoResume,
	DEFAULT_MAX_AUTO_RESTARTS,
	maybeAutoResumeSession,
	resolveAutoResumePolicy,
} from "./auto-resume";

const cliRuntime = {
	family: "interactive-cli" as const,
	capabilities: { interactiveTerminal: true },
};
const durableRuntime = {
	family: "durable-session" as const,
	capabilities: { interactiveTerminal: false },
};

describe("decideAutoResume", () => {
	it("FIRES on a non-graceful crash of an enabled interactive-cli session", () => {
		const d = decideAutoResume({
			runtime: cliRuntime,
			exit: { graceful: false },
			autoResumeEnabled: true,
			restartCount: 0,
			maxRestarts: 3,
		});
		expect(d.shouldResume).toBe(true);
		expect(d.reason).toBe("non_graceful_exit");
	});

	it("RESPECTS the per-agent flag (disabled -> never resumes)", () => {
		const d = decideAutoResume({
			runtime: cliRuntime,
			exit: { graceful: false },
			autoResumeEnabled: false,
			restartCount: 0,
			maxRestarts: 3,
		});
		expect(d.shouldResume).toBe(false);
		expect(d.reason).toBe("auto_resume_disabled");
	});

	it("RESPECTS the restart budget (count >= max -> stop)", () => {
		const atBudget = decideAutoResume({
			runtime: cliRuntime,
			exit: { graceful: false },
			autoResumeEnabled: true,
			restartCount: 3,
			maxRestarts: 3,
		});
		expect(atBudget.shouldResume).toBe(false);
		expect(atBudget.reason).toBe("restart_budget_exhausted");

		const underBudget = decideAutoResume({
			runtime: cliRuntime,
			exit: { graceful: false },
			autoResumeEnabled: true,
			restartCount: 2,
			maxRestarts: 3,
		});
		expect(underBudget.shouldResume).toBe(true);
	});

	it("does NOT resume a graceful exit", () => {
		const d = decideAutoResume({
			runtime: cliRuntime,
			exit: { graceful: true },
			autoResumeEnabled: true,
			restartCount: 0,
			maxRestarts: 3,
		});
		expect(d.shouldResume).toBe(false);
		expect(d.reason).toBe("graceful_exit");
	});

	it("does NOT resume a non-interactive-cli runtime", () => {
		const d = decideAutoResume({
			runtime: durableRuntime,
			exit: { graceful: false },
			autoResumeEnabled: true,
			restartCount: 0,
			maxRestarts: 3,
		});
		expect(d.shouldResume).toBe(false);
		expect(d.reason).toBe("not_interactive_cli");
	});
});

describe("resolveAutoResumePolicy", () => {
	it("is opt-in (disabled by default)", () => {
		expect(resolveAutoResumePolicy(null)).toEqual({
			enabled: false,
			maxRestarts: DEFAULT_MAX_AUTO_RESTARTS,
		});
		expect(resolveAutoResumePolicy({})).toEqual({
			enabled: false,
			maxRestarts: DEFAULT_MAX_AUTO_RESTARTS,
		});
	});
	it("reads autoResume + maxRestarts from agentConfig", () => {
		expect(resolveAutoResumePolicy({ autoResume: true, maxRestarts: 5 })).toEqual({
			enabled: true,
			maxRestarts: 5,
		});
	});
	it("falls back to the default budget on an invalid maxRestarts", () => {
		expect(
			resolveAutoResumePolicy({ autoResume: true, maxRestarts: -1 }),
		).toEqual({ enabled: true, maxRestarts: DEFAULT_MAX_AUTO_RESTARTS });
	});
});

describe("countResumeLineageDepth", () => {
	it("counts the resume chain back to its root", async () => {
		// s3 -> s2 -> s1 -> (root, no parent)
		const parents: Record<string, string | null> = {
			s3: "s2",
			s2: "s1",
			s1: null,
		};
		const depth = await countResumeLineageDepth("s3", async (id) => parents[id] ?? null);
		expect(depth).toBe(2);
	});
	it("returns 0 for a root session", async () => {
		expect(await countResumeLineageDepth("s1", async () => null)).toBe(0);
	});
	it("does not loop on a cyclic lineage", async () => {
		const parents: Record<string, string | null> = { a: "b", b: "a" };
		const depth = await countResumeLineageDepth("a", async (id) => parents[id] ?? null);
		expect(depth).toBeLessThanOrEqual(2);
	});
});

describe("maybeAutoResumeSession (integration)", () => {
	const baseSession = {
		id: "sess-dead",
		agentId: "agent-1",
		agentVersion: 2,
		userId: "user-1",
		projectId: "proj-1",
		title: "my conv",
		resumedFromSessionId: null,
	};

	it("spawns a continuation when the agent opts in and budget allows", async () => {
		const createSession = vi.fn(async () => ({ id: "sess-new" }));
		const spawnSessionWorkflow = vi.fn(async () => undefined);
		const r = await maybeAutoResumeSession(baseSession, {
			resolveAgent: async () => ({
				runtime: "claude-code-cli",
				config: { autoResume: true, maxRestarts: 3 },
			}),
			getRuntimeDescriptor: () => cliRuntime,
			getResumedFrom: async () => null,
			createSession,
			spawnSessionWorkflow,
		});
		expect(r.resumed).toBe(true);
		expect(r.newSessionId).toBe("sess-new");
		expect(createSession).toHaveBeenCalledOnce();
		expect(createSession).toHaveBeenCalledWith(
			expect.objectContaining({
				resumedFromSessionId: "sess-dead",
				agentId: "agent-1",
				userId: "user-1",
			}),
		);
		expect(spawnSessionWorkflow).toHaveBeenCalledWith("sess-new");
	});

	it("does NOT spawn when the flag is off", async () => {
		const createSession = vi.fn(async () => ({ id: "sess-new" }));
		const r = await maybeAutoResumeSession(baseSession, {
			resolveAgent: async () => ({ runtime: "claude-code-cli", config: {} }),
			getRuntimeDescriptor: () => cliRuntime,
			getResumedFrom: async () => null,
			createSession,
			spawnSessionWorkflow: vi.fn(),
		});
		expect(r.resumed).toBe(false);
		expect(r.reason).toBe("auto_resume_disabled");
		expect(createSession).not.toHaveBeenCalled();
	});

	it("does NOT spawn once the restart budget is exhausted", async () => {
		const createSession = vi.fn(async () => ({ id: "sess-new" }));
		// lineage: sess-dead -> p1 -> p2 -> null  => depth 2; maxRestarts 2 => exhausted.
		const parents: Record<string, string | null> = {
			"sess-dead": "p1",
			p1: "p2",
			p2: null,
		};
		const r = await maybeAutoResumeSession(baseSession, {
			resolveAgent: async () => ({
				runtime: "claude-code-cli",
				config: { autoResume: true, maxRestarts: 2 },
			}),
			getRuntimeDescriptor: () => cliRuntime,
			getResumedFrom: async (id) => parents[id] ?? null,
			createSession,
			spawnSessionWorkflow: vi.fn(),
		});
		expect(r.resumed).toBe(false);
		expect(r.reason).toBe("restart_budget_exhausted");
		expect(createSession).not.toHaveBeenCalled();
	});
});
