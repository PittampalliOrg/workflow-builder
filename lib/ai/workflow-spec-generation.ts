import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { compileWorkflowSpecToGraph } from "@/lib/workflow-spec/compile";
import { loadInstalledWorkflowSpecCatalog } from "@/lib/workflow-spec/catalog-server";
import { lintWorkflowSpec } from "@/lib/workflow-spec/lint";
import { normalizeWorkflowNodes } from "@/lib/workflows/normalize-nodes";
import {
	WorkflowSpecSchema,
	type WorkflowSpec,
} from "@/lib/workflow-spec/types";
import { getSecretValueAsync } from "@/lib/dapr/config-provider";

type Operation = {
	op:
		| "setName"
		| "setDescription"
		| "addNode"
		| "addEdge"
		| "removeNode"
		| "removeEdge"
		| "updateNode";
	name?: string;
	description?: string;
	node?: unknown;
	edge?: unknown;
	nodeId?: string;
	edgeId?: string;
	updates?: {
		position?: { x: number; y: number };
		data?: unknown;
	};
};

function encodeMessage(encoder: TextEncoder, message: object): Uint8Array {
	return encoder.encode(`${JSON.stringify(message)}\n`);
}

const WorkflowSpecJsonEnvelopeSchema = z.object({
	// Anthropic structured output schemas have strict limits on optional/union types and
	// overall grammar size. We therefore ask for the spec as a JSON string and then
	// deterministically parse + lint + repair.
	specJson: z.string().min(1),
});

function hydrateJsonishStrings(value: unknown): unknown {
	const visit = (v: unknown): unknown => {
		if (typeof v === "string") {
			const s = v.trim();
			if (!s) return v;

			// Preserve template refs and other non-JSON strings.
			if (s.includes("{{") && s.includes("}}")) return v;

			if (
				(s.startsWith("{") && s.endsWith("}")) ||
				(s.startsWith("[") && s.endsWith("]"))
			) {
				try {
					return JSON.parse(s) as unknown;
				} catch {
					return v;
				}
			}

			if (s === "true") return true;
			if (s === "false") return false;
			if (s === "null") return null;

			// Only coerce clean numeric strings (no whitespace, no trailing chars).
			if (/^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?$/.test(s)) {
				const n = Number(s);
				if (Number.isFinite(n)) return n;
			}

			return v;
		}

		if (Array.isArray(v)) return v.map(visit);

		if (v && typeof v === "object") {
			const out: Record<string, unknown> = {};
			for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
				out[k] = visit(val);
			}
			return out;
		}

		return v;
	};

	return visit(value);
}

function hydrateWorkflowSpecCandidateConfigs(candidate: unknown): unknown {
	if (!candidate || typeof candidate !== "object") return candidate;
	const out = structuredClone(candidate) as Record<string, unknown>;

	const trigger = out.trigger;
	if (trigger && typeof trigger === "object") {
		const t = structuredClone(trigger) as Record<string, unknown>;
		if ("config" in t) t.config = hydrateJsonishStrings(t.config);
		out.trigger = t;
	}

	const steps = out.steps;
	if (Array.isArray(steps)) {
		out.steps = steps.map((s) => {
			if (!s || typeof s !== "object") return s;
			const step = structuredClone(s) as Record<string, unknown>;
			if ("config" in step) step.config = hydrateJsonishStrings(step.config);
			return step;
		});
	}

	return out;
}

async function getAi(): Promise<{
	model: Parameters<typeof generateObject>[0]["model"];
	provider: "anthropic" | "openai";
}> {
	const anthropicKey =
		(await getSecretValueAsync("ANTHROPIC_API_KEY").catch(() => "")) ||
		process.env.ANTHROPIC_API_KEY;
	if (anthropicKey) {
		const provider = createAnthropic({ apiKey: anthropicKey });
		const modelId =
			process.env.ANTHROPIC_MODEL ||
			(process.env.AI_MODEL?.startsWith("claude-")
				? process.env.AI_MODEL
				: "") ||
			"claude-opus-4-6";
		return { model: provider.chat(modelId), provider: "anthropic" };
	}

	const gatewayBaseURL = process.env.AI_GATEWAY_BASE_URL;

	const openaiKey =
		(await getSecretValueAsync("OPENAI_API_KEY").catch(() => "")) ||
		process.env.OPENAI_API_KEY;
	const gatewayKey =
		(await getSecretValueAsync("AI_GATEWAY_API_KEY").catch(() => "")) ||
		process.env.AI_GATEWAY_API_KEY;

	const apiKey = gatewayBaseURL
		? gatewayKey || openaiKey
		: openaiKey || gatewayKey;
	if (!apiKey) {
		throw new Error(
			"Missing AI API key (set ANTHROPIC_API_KEY or OPENAI_API_KEY or AI_GATEWAY_API_KEY).",
		);
	}

	const modelId =
		process.env.OPENAI_MODEL ||
		(!process.env.AI_MODEL?.startsWith("claude-")
			? process.env.AI_MODEL
			: "") ||
		(gatewayBaseURL ? "openai/gpt-5.3-codex" : "gpt-5.3-codex");

	const provider = createOpenAI({
		apiKey,
		...(gatewayBaseURL ? { baseURL: gatewayBaseURL } : {}),
	});

	return { model: provider.chat(modelId), provider: "openai" };
}

function formatIssuesForPrompt(issues: {
	errors: Array<{ path: string; message: string; code: string }>;
}) {
	return issues.errors
		.slice(0, 50)
		.map((e) => `- ${e.path}: ${e.message} (${e.code})`)
		.join("\n");
}

function buildSystemPrompt(actionList: string): string {
	return `You generate workflows as JSON objects that match the Zod schema for WorkflowSpec v1.

Rules:
- Output MUST match the schema, no markdown.
- Use apiVersion "workflow-spec/v1".
- All steps must have unique ids (short, stable, like "fetch_user", "send_slack").
- steps must contain at least 1 step (a "note" step is acceptable if needed).
- Use steps[].next to connect the workflow (DAG). The trigger will connect to root steps automatically if you omit trigger.next.
- Never output empty arrays for any next field. If a node has no next, omit the next field entirely.
- For if-else, next.true and next.false must each be a single step id or a non-empty array of step ids (never []).
- For action steps, config MUST include actionType and required fields for that action.
- Template strings are allowed in config values, and must use the canonical format: {{@nodeId:Label.field}}.

Available actions (actionType + example config):
${actionList}
`;
}

export async function generateWorkflowSpecWithRepairs(input: {
	prompt: string;
	maxAttempts?: number;
	actionListPrompt: string;
}): Promise<{ spec: WorkflowSpec; warnings: unknown[] }> {
	const maxAttempts = input.maxAttempts ?? 3;
	const catalog = await loadInstalledWorkflowSpecCatalog();
	const system = buildSystemPrompt(input.actionListPrompt);
	const ai = await getAi();

	let lastRawJson: string | null = null;
	let lastErrorsText: string | null = null;
	let lastCandidate: unknown = null;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const prompt = (() => {
			if (attempt === 1) {
				return input.prompt;
			}

			return `Fix the workflow spec JSON to resolve these validation errors.

Errors:
${lastErrorsText || "- /: Unknown error (UNKNOWN)"}

Previous spec JSON:
${lastRawJson || "{}"}
`;
		})();

		let rawJson: string;
		let candidate: unknown;

		if (ai.provider === "anthropic") {
			const { object } = await generateObject({
				model: ai.model,
				system,
				prompt,
				schema: WorkflowSpecJsonEnvelopeSchema,
			});
			rawJson = object.specJson;
			try {
				candidate = JSON.parse(rawJson);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Failed to parse JSON";
				lastRawJson = rawJson;
				lastCandidate = rawJson;
				lastErrorsText = `- /: Invalid JSON: ${message} (INVALID_JSON)`;
				continue;
			}
		} else {
			const { object } = await generateObject({
				model: ai.model,
				system,
				prompt,
				schema: WorkflowSpecSchema,
			});
			candidate = object;
			rawJson = JSON.stringify(object, null, 2);
		}

		const hydratedCandidate = hydrateWorkflowSpecCandidateConfigs(candidate);
		const linted = lintWorkflowSpec(hydratedCandidate, {
			catalog,
			unknownActionType: "error",
		});

		if (linted.result.errors.length === 0 && linted.spec) {
			return { spec: linted.spec, warnings: linted.result.warnings };
		}

		lastRawJson = rawJson;
		lastCandidate = hydratedCandidate;
		lastErrorsText = formatIssuesForPrompt({ errors: linted.result.errors });
	}

	const linted = lintWorkflowSpec(lastCandidate, {
		catalog,
		unknownActionType: "error",
	});
	throw new Error(
		`Failed to generate a valid workflow spec after ${maxAttempts} attempts: ${linted.result.errors[0]?.message ?? "Unknown error"}`,
	);
}

function specToOperations(spec: WorkflowSpec): Operation[] {
	const { nodes, edges } = compileWorkflowSpecToGraph(spec);
	const normalizedNodes = normalizeWorkflowNodes(nodes) as typeof nodes;

	const ops: Operation[] = [
		{ op: "setName", name: spec.name },
		...(spec.description
			? [{ op: "setDescription" as const, description: spec.description }]
			: []),
	];

	for (const node of normalizedNodes) {
		ops.push({ op: "addNode", node });
	}
	for (const edge of edges) {
		ops.push({ op: "addEdge", edge });
	}

	return ops;
}

export async function createWorkflowOperationStreamFromSpec(input: {
	prompt: string;
	actionListPrompt: string;
}): Promise<ReadableStream<Uint8Array>> {
	const encoder = new TextEncoder();

	return new ReadableStream({
		async start(controller) {
			try {
				const { spec } = await generateWorkflowSpecWithRepairs({
					prompt: input.prompt,
					actionListPrompt: input.actionListPrompt,
					maxAttempts: 3,
				});

				const operations = specToOperations(spec);
				for (const op of operations) {
					controller.enqueue(
						encodeMessage(encoder, {
							type: "operation",
							operation: op,
						}),
					);
				}
				controller.enqueue(encodeMessage(encoder, { type: "complete" }));
			} catch (error) {
				controller.enqueue(
					encodeMessage(encoder, {
						type: "error",
						error:
							error instanceof Error
								? error.message
								: "Failed to generate workflow spec",
					}),
				);
			} finally {
				controller.close();
			}
		},
	});
}
