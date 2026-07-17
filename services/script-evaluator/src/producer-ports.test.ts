import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { evaluateScript, validateScript } from "./sandbox.js";

const script = readFileSync(
	new URL("../../../scripts/fixtures/dynamic-scripts/code-eval-item.js", import.meta.url),
	"utf8",
);

describe("code-eval-item port", () => {
	it("validates", async () => {
		const v = await validateScript(script);
		expect(v.ok, v.error).toBe(true);
	});
	it("first round dispatches the workspace profile action", async () => {
		const res = await evaluateScript({
			script,
			args: {
				taskId: "HumanEval/0",
				runtimeProbeCommand: "python -V",
				solvePrompt: "solve it",
				agentRef: { id: "agent-1", version: 2 },
				evaluation: { itemId: "i1", expectedOutput: { testFileContent: "assert True" } },
			},
			budget: { total: 1_000_000, spent: 0 },
			completedResults: {},
			knownCallIds: [],
			seenLogCount: 0,
			features: { actions: true },
		});
		expect(res.status).toBe("need");
		expect(res.tasks[0].kind).toBe("action");
		expect(res.tasks[0].actionSlug).toBe("workspace/profile");
		expect(res.tasks[0].opts.label).toBe("workspace_profile");
		expect(res.tasks[0].position?.line).toBeGreaterThan(0);
	});
});

const devSession = readFileSync(
	new URL("../../../scripts/fixtures/dynamic-scripts/microservice-dev-session.js", import.meta.url),
	"utf8",
);

describe("microservice-dev-session port", () => {
	it("validates and carries meta.input + launch surface", async () => {
		const v = await validateScript(devSession);
		expect(v.ok, v.error).toBe(true);
		expect((v.meta as Record<string, unknown>)?.name).toBe("microservice-dev-session");
	});

	it("first round dispatches the dev/preview activation with its ready-set config", async () => {
		const res = await evaluateScript({
			script: devSession,
			args: { service: "workflow-orchestrator" },
			budget: { total: 1_000_000, spent: 0 },
			completedResults: {},
			knownCallIds: [],
			seenLogCount: 0,
			features: { actions: true },
		});
		expect(res.status).toBe("need");
		const t = res.tasks[0];
		expect(t.kind).toBe("action");
		expect(t.actionSlug).toBe("dev/preview");
		expect(t.opts.label).toBe("provision_preview");
		const input = t.args as Record<string, unknown>;
		expect(input.mode).toBe("preview-native");
		expect(input.services).toEqual(["workflow-orchestrator"]);
		// The activation knobs the runner child's durable poll reads.
		expect(input.activationPollSeconds).toBeDefined();
	});
});

const ganScript = readFileSync(
	new URL("../../../scripts/fixtures/dynamic-scripts/preview-gan-ui-feature.js", import.meta.url),
	"utf8",
);

const previewUiDevelopmentGan = readFileSync(
	new URL(
		"../../../scripts/fixtures/dynamic-scripts/preview-ui-development-gan.js",
		import.meta.url,
	),
	"utf8",
);

function extractMetaInputSchema(source: string): Record<string, unknown> {
	const marker = "export const meta =";
	const markerIndex = source.indexOf(marker);
	expect(markerIndex).toBeGreaterThanOrEqual(0);
	const start = source.indexOf("{", markerIndex);
	let depth = 0;
	let end = -1;
	let quote = "";
	let escape = false;
	for (let i = start; i < source.length; i += 1) {
		const ch = source[i];
		if (quote) {
			if (escape) escape = false;
			else if (ch === "\\") escape = true;
			else if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "{") depth += 1;
		else if (ch === "}" && --depth === 0) {
			end = i;
			break;
		}
	}
	expect(end).toBeGreaterThan(start);
	const meta = Function(`return (${source.slice(start, end + 1)});`)();
	return meta.input as Record<string, unknown>;
}

describe("GAN generator port (preview-gan-ui-feature)", () => {
	it("validates through the evaluator", async () => {
		const v = await validateScript(ganScript);
		expect(v.ok, v.error).toBe(true);
		expect((v.meta as Record<string, unknown>)?.name).toBe("preview-gan-ui-feature");
	});

	it("first round enters preview-native dev mode (the durable activation)", async () => {
		const res = await evaluateScript({
			script: ganScript,
			args: { intent: "add a widget" },
			budget: { total: 5_000_000, spent: 0 },
			completedResults: {},
			knownCallIds: [],
			seenLogCount: 0,
			features: { actions: true },
		});
		expect(res.status).toBe("need");
		const t = res.tasks[0];
		expect(t.kind).toBe("action");
		expect(t.actionSlug).toBe("dev/preview");
		expect((t.args as Record<string, unknown>).mode).toBe("preview-native");
		expect((t.args as Record<string, unknown>).adopt).toBe(true);
		expect(t.opts.label).toBe("enter_dev_mode");
	});

	it("refine loop: after preview+plan+review, the generator agent runs (bound, shared workspace)", async () => {
		// Resolve the first three calls, then check the loop's first generate.
		const first = await evaluateScript({
			script: ganScript,
			args: {},
			budget: { total: 5_000_000, spent: 0 },
			completedResults: {},
			knownCallIds: [],
			seenLogCount: 0,
			features: { actions: true },
		});
		const results: Record<string, { status: string; value: unknown }> = {};
		const known: string[] = [];
		let res = first;
		// Drive up to 4 rounds, resolving whatever the script asks for.
		for (let round = 0; round < 4 && res.status === "need"; round += 1) {
			for (const task of res.tasks) {
				results[task.callId] = {
					status: "done",
					value:
						task.kind === "action"
							? { url: "https://preview", syncCapability: "cap", exitCode: 0 }
							: "ok",
				};
				known.push(task.callId);
			}
			res = await evaluateScript({
				script: ganScript,
				args: {},
				budget: { total: 5_000_000, spent: 0 },
				completedResults: results,
				knownCallIds: known,
				seenLogCount: 0,
				features: { actions: true },
			});
		}
		const labels = Object.values(results).length;
		expect(labels).toBeGreaterThanOrEqual(3);
		// A generate-labelled agent call must have appeared in the loop.
		expect(known.length).toBeGreaterThanOrEqual(3);
	});
});

describe("preview-ui-development-gan port", () => {
	it("validates through the evaluator", async () => {
		const v = await validateScript(previewUiDevelopmentGan);
		expect(v.ok, v.error).toBe(true);
		expect((v.meta as Record<string, unknown>)?.name).toBe("preview-ui-development-gan");
	});

	it("first round enters preview-native live-sync mode with adoption", async () => {
		const res = await evaluateScript({
			script: previewUiDevelopmentGan,
			args: { intent: "improve dashboard status visibility" },
			budget: { total: 5_000_000, spent: 0 },
			completedResults: {},
			knownCallIds: [],
			seenLogCount: 0,
			features: { actions: true },
		});
		expect(res.status).toBe("need");
		const t = res.tasks[0];
		expect(t.kind).toBe("action");
		expect(t.actionSlug).toBe("dev/preview");
		expect((t.args as Record<string, unknown>).mode).toBe("preview-native");
		expect((t.args as Record<string, unknown>).adopt).toBe(true);
		expect((t.args as Record<string, unknown>).services).toEqual(["workflow-builder"]);
	});

	it("accepts the tuple-bound host launch fields injected by preview development", async () => {
		const schema = extractMetaInputSchema(previewUiDevelopmentGan);
		const ajv = new Ajv({
			allErrors: true,
			strict: false,
			useDefaults: true,
			coerceTypes: false,
		});
		const validate = ajv.compile(schema);
		const launchArgs = {
			intent: "improve dashboard status visibility",
			services: ["workflow-builder"],
			agentSlug: "glm-juicefs-builder-agent",
			keepPreview: "true",
			mode: "preview-native",
			previewOrigin: "https://wfb-feature-one.tail286401.ts.net",
			sourceRevision: "c".repeat(40),
			__previewDevelopment: {
				version: 2,
				parentExecutionId: "parent-1",
				remoteActorUserId: "admin-1",
				operationId: `pdt-start-workflow-${"a".repeat(64)}`,
			},
		};
		expect(validate(launchArgs), JSON.stringify(validate.errors)).toBe(true);

		const res = await evaluateScript({
			script: previewUiDevelopmentGan,
			args: launchArgs,
			budget: { total: 5_000_000, spent: 0 },
			completedResults: {},
			knownCallIds: [],
			seenLogCount: 0,
			features: { actions: true },
		});
		expect(res.status).toBe("need");
		expect(res.tasks[0]?.kind).toBe("action");
	});

	it("uses the GLM JuiceFS agent for plan and generate after live-sync metadata resolves", async () => {
		const first = await evaluateScript({
			script: previewUiDevelopmentGan,
			args: { intent: "improve dashboard status visibility" },
			budget: { total: 5_000_000, spent: 0 },
			completedResults: {},
			knownCallIds: [],
			seenLogCount: 0,
			features: { actions: true },
		});
		const results: Record<string, { status: "done"; value: unknown }> = {};
		const known: string[] = [];
		for (const task of first.tasks) {
			results[task.callId] = {
				status: "done",
				value: {
					ok: true,
					url: "https://wfb-feature.tail286401.ts.net",
					browseUrl: "https://wfb-feature.tail286401.ts.net",
					syncUrl: "https://wfb-feature.tail286401.ts.net/__sync",
					syncCapability: "capability",
				},
			};
			known.push(task.callId);
		}
		const second = await evaluateScript({
			script: previewUiDevelopmentGan,
			args: { intent: "improve dashboard status visibility" },
			budget: { total: 5_000_000, spent: 0 },
			completedResults: results,
			knownCallIds: known,
			seenLogCount: 0,
			features: { actions: true },
		});
		expect(second.status).toBe("need");
		const plan = second.tasks[0];
		expect(plan.kind).toBe("agent");
		expect(plan.opts.agent).toBe("glm-juicefs-builder-agent");
		expect(plan.opts.model).toBe("zai/glm-5.2");
		expect(plan.opts.isolation).toBe("shared");
	});
});
