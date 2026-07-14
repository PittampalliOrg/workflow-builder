/**
 * Guard suite for the PORTED producers (cutover P3, item 17).
 *
 * The SW-era guards asserted with regex/lookups over `fixture.do` — a structural
 * proxy. These assert on what the engine ACTUALLY plans: the script is fed to the
 * real `script-evaluator` sandbox and the emitted `/evaluate` task plan is checked
 * (kinds, slugs, labels, opts, and the loop's behavior across rounds). That is
 * strictly stronger: a script that parses but plans the wrong calls fails here,
 * and every assertion exercises the same code path the pump uses in production.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	evaluateScript,
	validateScript,
	type EvaluateResponse,
	type EvaluateTask,
} from "../../../services/script-evaluator/src/sandbox";
import { PREVIEW_GAN_UI_FEATURE_CONFIG } from "./gen/gan-config";
import { generateGanScript } from "./gen/gan-script-generator";

const read = (relative: string) =>
	readFileSync(resolve(process.cwd(), relative), "utf8");

const FEATURES = { actions: true } as const;

async function plan(
	script: string,
	args: unknown,
	completedResults: Record<string, { status: string; value: unknown }> = {},
	knownCallIds: string[] = [],
): Promise<EvaluateResponse> {
	return evaluateScript({
		script,
		args,
		budget: { total: 5_000_000, spent: 0 },
		completedResults,
		knownCallIds,
		seenLogCount: 0,
		features: FEATURES,
	});
}

/** Drive the script to completion, resolving every task the plan asks for. */
async function drive(
	script: string,
	args: unknown,
	resolveTask: (task: EvaluateTask, round: number) => unknown,
	maxRounds = 12,
): Promise<{ rounds: number; tasks: EvaluateTask[]; final: EvaluateResponse }> {
	const completed: Record<string, { status: string; value: unknown }> = {};
	const known: string[] = [];
	const seen: EvaluateTask[] = [];
	let res = await plan(script, args);
	let rounds = 0;
	while (res.status === "need" && rounds < maxRounds) {
		for (const task of res.tasks) {
			seen.push(task);
			completed[task.callId] = { status: "done", value: resolveTask(task, rounds) };
			known.push(task.callId);
		}
		rounds += 1;
		res = await plan(script, args, completed, known);
	}
	return { rounds, tasks: seen, final: res };
}

// ── GAN generator (preview-gan-ui-feature) ───────────────────────────────────

describe("GAN generator: emitted script plans the harness", () => {
	const script = generateGanScript(PREVIEW_GAN_UI_FEATURE_CONFIG);

	it("is byte-identical to the checked-in emitted fixture (drift guard)", () => {
		expect(read("scripts/fixtures/dynamic-scripts/preview-gan-ui-feature.js")).toBe(script);
	});

	it("validates in the real evaluator", async () => {
		const v = await validateScript(script);
		expect(v.ok, v.error).toBe(true);
	});

	it("plans: dev/preview (preview-native adopt) → plan → design_review", async () => {
		const first = await plan(script, { intent: "x" });
		expect(first.status).toBe("need");
		const preview = first.tasks[0];
		expect(preview.kind).toBe("action");
		expect(preview.actionSlug).toBe("dev/preview");
		expect((preview.args as Record<string, unknown>).mode).toBe("preview-native");
		expect((preview.args as Record<string, unknown>).adopt).toBe(true);

		const { tasks } = await drive(
			script,
			{ intent: "x", maxIterations: 1 },
			(task) =>
				task.kind === "action"
					? { url: "https://p", syncCapability: "cap", exitCode: 0 }
					: task.opts.schema
						? { accepted: true, score: 9, failing: [], summary: "ok" }
						: "agent text",
			8,
		);
		const labels = tasks.map((t) => String(t.opts.label ?? t.actionSlug));
		expect(labels).toContain("enter_dev_mode");
		expect(labels).toContain("plan");
		expect(labels).toContain("design_review");
	});

	it("refine loop: generate → deterministic gate → schema'd critic, then promote on accept", async () => {
		const { tasks, final } = await drive(
			script,
			{ intent: "x", maxIterations: 2 },
			(task) =>
				task.kind === "action"
					? { url: "https://p", syncCapability: "cap", exitCode: 0 }
					: task.opts.schema
						? { accepted: true, score: 9, failing: [], summary: "ok" }
						: "agent text",
			10,
		);
		const labels = tasks.map((t) => String(t.opts.label ?? t.actionSlug));
		expect(labels.some((l) => l.startsWith("generate #"))).toBe(true);
		expect(labels.some((l) => l.startsWith("gate #"))).toBe(true);
		expect(labels.some((l) => l.startsWith("critique #"))).toBe(true);
		// The critic call is schema'd (structured verdict) — the loop-exit authority.
		const critic = tasks.find((t) => String(t.opts.label).startsWith("critique #"));
		expect(critic?.opts.schema).toBeTruthy();
		// Accepted on the first verdict -> promote runs, and the run finishes.
		expect(labels).toContain("promote");
		expect(final.status).toBe("done");
		expect((final.returnValue as Record<string, unknown>).accepted).toBe(true);
	});

	it("a FAILING build gate skips the critic and re-generates with the failure fed back", async () => {
		const { tasks } = await drive(
			script,
			{ intent: "x", maxIterations: 2 },
			(task) =>
				task.kind === "action"
					? // gate fails (non-zero exit); dev/preview still succeeds
						task.actionSlug === "workspace/command"
						? { exitCode: 1, stderr: "boom" }
						: { url: "https://p", syncCapability: "cap" }
					: "agent text",
			10,
		);
		const labels = tasks.map((t) => String(t.opts.label ?? t.actionSlug));
		// Two generate attempts (the cap), no critic call at all.
		expect(labels.filter((l) => l.startsWith("generate #")).length).toBe(2);
		expect(labels.some((l) => l.startsWith("critique #"))).toBe(false);
	});

	it("agents are bound to ONE shared workspace (the run's sandbox)", async () => {
		const first = await plan(script, {});
		const { tasks } = await drive(
			script,
			{ maxIterations: 1 },
			(task) =>
				task.kind === "action"
					? { url: "https://p", syncCapability: "cap", exitCode: 0 }
					: task.opts.schema
						? { accepted: true }
						: "text",
			8,
		);
		expect(first.status).toBe("need");
		for (const agentTask of tasks.filter((t) => t.kind === "agent")) {
			expect(agentTask.opts.isolation).toBe("shared");
			const sandbox = agentTask.opts.sandbox as Record<string, unknown>;
			expect(sandbox.workspaceRef).toBe("@workspace"); // the pump substitutes the real ref
		}
	});
});

// ── microservice-dev-session ─────────────────────────────────────────────────

describe("microservice-dev-session: emitted plan", () => {
	const script = read("scripts/fixtures/dynamic-scripts/microservice-dev-session.js");

	it("plans provision(dev/preview) → seed(workspace/command) → handoff(session/spawn)", async () => {
		const { tasks, final } = await drive(
			script,
			{ service: "workflow-orchestrator" },
			(task) =>
				task.actionSlug === "dev/preview"
					? { ready: true, browseUrl: "https://x", services: [] }
					: task.actionSlug === "session/spawn"
						? { sessionId: "sess-1" }
						: { exitCode: 0 },
			6,
		);
		const slugs = tasks.map((t) => t.actionSlug);
		expect(slugs).toEqual(["dev/preview", "workspace/command", "session/spawn"]);
		expect(final.status).toBe("done");
		expect((final.returnValue as Record<string, unknown>).sessionId).toBe("sess-1");
	});

	it("the dev/preview call carries its durable-activation knobs", async () => {
		const first = await plan(script, {});
		const args = first.tasks[0].args as Record<string, unknown>;
		expect(args.mode).toBe("preview-native");
		expect(args.activationPollSeconds).toBeDefined();
		expect(args.activationTimeoutSeconds).toBeDefined();
	});
});

// ── pr-heavy-review ──────────────────────────────────────────────────────────

describe("pr-heavy-review: emitted plan", () => {
	const script = read("scripts/fixtures/dynamic-scripts/pr-heavy-review.js");

	it("plans review → judge → publish, three agents on ONE shared workspace", async () => {
		const { tasks, final } = await drive(
			script,
			{ repository: "PittampalliOrg/workflow-builder", prNumber: 42, prTitle: "T" },
			() => "agent output",
			6,
		);
		const labels = tasks.map((t) => String(t.opts.label));
		expect(labels).toEqual(["review", "judge", "publish"]);
		for (const task of tasks) {
			expect(task.kind).toBe("agent");
			expect(task.opts.isolation).toBe("shared");
			expect((task.opts.sandbox as Record<string, unknown>).workspaceRef).toBe("@workspace");
		}
		expect(final.status).toBe("done");
		expect((final.returnValue as Record<string, unknown>).pr_number).toBe(42);
	});

	it("the judge is INDEPENDENT of the reviewer (its own agent call, grounded prompt)", async () => {
		const first = await plan(script, { repository: "r", prNumber: 1 });
		expect(first.tasks[0].opts.label).toBe("review");
		// The judge only appears after the review resolves (sequential gate).
		expect(first.tasks.length).toBe(1);
	});
});

// ── code-eval-item ───────────────────────────────────────────────────────────

describe("code-eval-item: emitted plan", () => {
	const script = read("scripts/fixtures/dynamic-scripts/code-eval-item.js");

	it("plans profile → probe → write_test → solve → restore → pytest → read → capture", async () => {
		const { tasks, final } = await drive(
			script,
			{
				taskId: "HumanEval/0",
				runtimeProbeCommand: "python -V",
				solvePrompt: "solve",
				agentRef: { id: "agent-1" },
				evaluation: { itemId: "i1", expectedOutput: { testFileContent: "assert True" } },
			},
			(task) =>
				task.kind === "agent"
					? "done"
					: task.actionSlug === "workspace/profile"
						? { workspaceRef: "ws-1", sandboxName: "sb-1" }
						: task.actionSlug === "workspace/read_file"
							? { result: { content: "def solve(): pass" }, backend: "openshell" }
							: { result: { exitCode: 0, stdout: "{}", stderr: "" }, backend: "openshell" },
			10,
		);
		const labels = tasks.map((t) => String(t.opts.label ?? t.actionSlug));
		expect(labels).toEqual([
			"workspace_profile",
			"validate_runtime",
			"write_test",
			"solve",
			"restore_test",
			"run_tests",
			"read_solution",
			"capture_metadata",
		]);
		expect(final.status).toBe("done");
		const out = final.returnValue as Record<string, unknown>;
		expect(out.passed).toBe(true);
		expect(out.taskId).toBe("HumanEval/0");
	});

	it("a FAILING runtime probe short-circuits the item (no agent, no pytest)", async () => {
		const { tasks, final } = await drive(
			script,
			{
				taskId: "HumanEval/1",
				runtimeProbeCommand: "python -V",
				solvePrompt: "solve",
				agentRef: { id: "agent-1" },
				evaluation: { itemId: "i2", expectedOutput: { testFileContent: "assert True" } },
			},
			(task) =>
				task.actionSlug === "workspace/profile"
					? { workspaceRef: "ws-1", sandboxName: "sb-1" }
					: { result: { exitCode: 1, stderr: "no python" }, backend: "openshell" },
			6,
		);
		expect(tasks.filter((t) => t.kind === "agent")).toHaveLength(0);
		expect(tasks.map((t) => t.opts.label)).toEqual(["workspace_profile", "validate_runtime"]);
		expect(final.status).toBe("done");
		expect((final.returnValue as Record<string, unknown>).passed).toBe(false);
	});

	// The agent is bound to the sandbox the script provisioned (the capability that
	// unblocked every workspace-shaped producer).
	it("the solve agent binds the profile's workspace + sandbox", async () => {
		const { tasks } = await drive(
			script,
			{
				taskId: "t",
				runtimeProbeCommand: "python -V",
				solvePrompt: "solve",
				agentRef: { id: "agent-1", version: 3 },
				evaluation: { itemId: "i", expectedOutput: { testFileContent: "x" } },
			},
			(task) =>
				task.kind === "agent"
					? "done"
					: task.actionSlug === "workspace/profile"
						? { workspaceRef: "ws-9", sandboxName: "sb-9" }
						: { result: { exitCode: 0, stdout: "{}" }, backend: "openshell" },
			10,
		);
		const solve = tasks.find((t) => t.kind === "agent");
		expect(solve?.opts.agent).toBe("agent-1");
		expect(solve?.opts.agentVersion).toBe(3);
		const sandbox = solve?.opts.sandbox as Record<string, unknown>;
		expect(sandbox.workspaceRef).toBe("ws-9");
		expect(sandbox.sandboxName).toBe("sb-9");
		expect(sandbox.cwd).toBe("/sandbox");
	});
});
