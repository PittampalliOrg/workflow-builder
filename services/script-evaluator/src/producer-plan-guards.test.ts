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
} from "./sandbox";
import { PREVIEW_GAN_UI_FEATURE_CONFIG } from "../../../scripts/fixtures/generator-critic/gen/gan-config";
import { generateGanScript } from "../../../scripts/fixtures/generator-critic/gen/gan-script-generator";

/** Repo root, regardless of which package vitest was invoked from. */
const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "../../..");
const read = (relative: string) => readFileSync(resolve(REPO_ROOT, relative), "utf8");

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

	it("plans provision → seed → handoff, then waits for typed control", async () => {
		const { tasks, final } = await drive(
			script,
			{ service: "workflow-orchestrator" },
			(task) =>
				task.kind === "event"
					? { action: "discard" }
					: task.actionSlug === "dev/preview"
						? { ready: true, browseUrl: "https://x", services: [] }
						: task.actionSlug === "session/spawn"
							? { sessionId: "sess-1" }
							: { exitCode: 0 },
			6,
		);
		const slugs = tasks.filter((task) => task.kind === "action").map((t) => t.actionSlug);
		expect(slugs).toEqual(["dev/preview", "workspace/command", "session/spawn"]);
		expect(tasks.find((task) => task.kind === "event")?.eventName).toBe(
			"preview.development.control",
		);
		expect(final.status).toBe("done");
		expect((final.returnValue as Record<string, unknown>).sessionId).toBe("sess-1");
		expect((final.returnValue as Record<string, unknown>).controlOutcome).toBe("discarded");
	});

	it("the dev/preview call carries its durable-activation knobs", async () => {
		const first = await plan(script, {});
		const args = first.tasks[0].args as Record<string, unknown>;
		expect(args.mode).toBe("preview-native");
		expect(args.activationPollSeconds).toBeDefined();
		expect(args.activationTimeoutSeconds).toBeDefined();
	});

	it("hands off one logged sync and receipt-based verification", async () => {
		const { tasks } = await drive(
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
		const handoff = tasks.find((task) => task.actionSlug === "session/spawn");
		expect((handoff?.args as Record<string, unknown> | undefined)?.agentSlug).toBe(
			"glm-juicefs-builder-agent",
		);
		const instructions = String(
			(handoff?.args as Record<string, unknown> | undefined)?.instructions ?? "",
		);
		const syncCommand = "/sandbox/work/sync.sh > /sandbox/work/sync.log 2>&1";

		expect(instructions.split(syncCommand)).toHaveLength(2);
		expect(instructions.indexOf(syncCommand)).toBeLessThan(
			instructions.indexOf("inspect `/sandbox/work/sync.log`"),
		);
		expect(instructions).toContain("an `APPLIED ...` receipt for every selected service");
		expect(instructions).toContain("the final global `SYNCED ...` line");
		expect(instructions).toContain(
			"Never rerun the sync command merely to recover tool output that was truncated",
		);
	});

	it("defaults direct handoff to the Kimi K3 dapr-agent-py JuiceFS agent", async () => {
		const { tasks } = await drive(
			script,
			{ service: "workflow-builder" },
			(task) =>
				task.kind === "event"
					? { action: "discard" }
					: task.actionSlug === "dev/preview"
						? { ready: true, browseUrl: "https://x", services: [] }
						: task.actionSlug === "session/spawn"
							? { sessionId: "sess-1" }
							: { exitCode: 0 },
			6,
		);
		const handoff = tasks.find((task) => task.actionSlug === "session/spawn");
		expect((handoff?.args as Record<string, unknown> | undefined)?.agentSlug).toBe(
			"glm-juicefs-builder-agent",
		);
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
					: { success: false, error: "probe failed", data: { result: { exitCode: 1, stderr: "no python" } } },
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

// ── preview-gan-redesign ─────────────────────────────────────────────────────

describe("preview-gan-redesign: emitted plan", () => {
	const script = read("scripts/fixtures/dynamic-scripts/preview-gan-redesign.js");

	it("validates and plans dev/preview (adopt:false) → plan → design_review", async () => {
		const v = await validateScript(script);
		expect(v.ok, v.error).toBe(true);
		const first = await plan(script, { intent: "redesign" });
		const preview = first.tasks[0];
		expect(preview.actionSlug).toBe("dev/preview");
		expect((preview.args as Record<string, unknown>).adopt).toBe(false);
	});

	it("refine loop: generate → snapshot → SCHEMA'D critic; exits on meets_criteria + score", async () => {
		const { tasks, final } = await drive(
			script,
			{ intent: "redesign" },
			(task) =>
				task.kind === "action"
					? { url: "https://p", ready: true }
					: task.opts.schema
						? { meets_criteria: true, score: 9, failing: [] }
						: "generator text",
			10,
		);
		const labels = tasks.map((t) => String(t.opts.label ?? t.actionSlug));
		expect(labels).toContain("plan");
		expect(labels).toContain("design_review");
		expect(labels.some((l) => l.startsWith("generate #"))).toBe(true);
		expect(labels.some((l) => l.startsWith("snapshot #"))).toBe(true);
		const critic = tasks.find((t) => String(t.opts.label).startsWith("critique #"));
		expect(critic?.opts.schema).toBeTruthy();
		expect(final.status).toBe("done");
		expect((final.returnValue as Record<string, unknown>).accepted).toBe(true);
	});

	it("a LOW score keeps looping (the SW while-gate semantics)", async () => {
		const { tasks } = await drive(
			script,
			{ intent: "redesign" },
			(task) =>
				task.kind === "action"
					? { url: "https://p" }
					: task.opts.schema
						? { meets_criteria: true, score: 3, failing: ["contrast"] } // score < 8
						: "generator text",
			14,
		);
		const generates = tasks.filter((t) => String(t.opts.label).startsWith("generate #"));
		expect(generates.length).toBeGreaterThan(1);
	});
});

// ── gan-harness-dapr-showcase ────────────────────────────────────────────────

describe("gan-harness-dapr-showcase: emitted plan", () => {
	const script = read("scripts/fixtures/dynamic-scripts/gan-harness-dapr-showcase.js");

	it("validates; plans profile → clone → plan → init_state → approval GATE", async () => {
		const v = await validateScript(script);
		expect(v.ok, v.error).toBe(true);

		const results: Record<string, { status: string; value: unknown }> = {};
		const known: string[] = [];
		let res = await plan(script, {});
		const seen: EvaluateTask[] = [];
		for (let round = 0; round < 5 && res.status === "need"; round += 1) {
			for (const task of res.tasks) {
				seen.push(task);
				// Stop right before resolving the gate so we can assert on it.
				if (task.kind === "event") continue;
				results[task.callId] = {
					status: "done",
					value:
						task.actionSlug === "workspace/profile"
							? { result: { workspaceRef: "ws-1", sandbox: { details: { sandboxName: "sb-1" } } } }
							: task.kind === "agent"
								? "text"
								: { result: { exitCode: 0, stdout: "" } },
				};
				known.push(task.callId);
			}
			if (seen.some((t) => t.kind === "event")) break;
			res = await plan(script, {}, results, known);
		}
		const labels = seen.map((t) => String(t.opts.label ?? t.actionSlug ?? t.kind));
		expect(labels).toContain("workspace_profile");
		expect(labels).toContain("clone_repo");
		expect(labels).toContain("plan");
		expect(labels).toContain("init_state");
		// The SW `listen` gate became a first-class event call.
		const gate = seen.find((t) => t.kind === "event");
		expect(gate).toBeTruthy();
		expect(gate?.eventName).toBe("approval");
	});

	it("a DENIED/timed-out gate short-circuits before the design loop", async () => {
		const { tasks, final } = await drive(
			script,
			{},
			(task) =>
				task.kind === "event"
					? { approved: false, timedOut: true }
					: task.actionSlug === "workspace/profile"
						? { result: { workspaceRef: "ws-1", sandbox: { details: { sandboxName: "sb-1" } } } }
						: task.kind === "agent"
							? "text"
							: { result: { exitCode: 0, stdout: "" } },
			8,
		);
		expect(final.status).toBe("done");
		const out = final.returnValue as Record<string, unknown>;
		expect(out.approved).toBe(false);
		expect(out.timedOut).toBe(true);
		// No design/negotiate/refine work ran.
		expect(tasks.some((t) => String(t.opts.label).startsWith("design_propose"))).toBe(false);
	});

	it("approved: design → negotiate → refine loops run, with schema'd verdicts and paired critics", async () => {
		const { tasks, final } = await drive(
			script,
			{ maxIterations: 1 },
			(task) =>
				task.kind === "event"
					? { approved: true }
					: task.actionSlug === "workspace/profile"
						? { result: { workspaceRef: "ws-1", sandbox: { details: { sandboxName: "sb-1" } } } }
						: task.opts.schema
							? { meets_criteria: true, score: 9, failing: [] }
							: task.kind === "agent"
								? "text"
								: { result: { exitCode: 0, stdout: "OBJECTIVE PASS" } },
			16,
		);
		const labels = tasks.map((t) => String(t.opts.label ?? t.actionSlug));
		expect(labels.some((l) => l.startsWith("design_propose"))).toBe(true);
		expect(labels.some((l) => l.startsWith("propose"))).toBe(true);
		expect(labels.some((l) => l.startsWith("generate #"))).toBe(true);
		expect(labels.some((l) => l.startsWith("gate #"))).toBe(true);
		// The two independent critics run in the SAME round (Promise.all).
		expect(labels.some((l) => l.startsWith("evaluate_ui #"))).toBe(true);
		expect(labels.some((l) => l.startsWith("evaluate_code #"))).toBe(true);
		expect(labels).toContain("pr");
		expect(final.status).toBe("done");
		expect((final.returnValue as Record<string, unknown>).accepted).toBe(true);
	});
});
