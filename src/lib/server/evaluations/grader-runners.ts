// Async grader runners for graders that need external services. Server-only.
//
// Wired into `gradeEvaluationRun` via `runGraderAsync` in `./graders.ts`.
// `score_model`, `python`, and `endpoint` graders all dispatch here; everything
// else still uses the sync `runGrader` for backward compatibility and to power
// the wizard's client-side preview pane.

import { env } from "$env/dynamic/private";
import {
	daprFetch,
	getCodeRuntimeUrl,
	getDaprSidecarUrl,
} from "$lib/server/dapr-client";
import { wakeAgentRuntime } from "$lib/server/kube/client";
import type { GraderContext, GraderDefinition, GraderResult } from "./graders";

/**
 * Execute a grader that needs an external service. Falls back to a "skipped"
 * GraderResult if the runner can't reach the configured backend.
 */
export async function runGraderAsync(
	grader: GraderDefinition,
	context: GraderContext,
): Promise<GraderResult> {
	try {
		switch (grader.type) {
			case "score_model":
				return await runScoreModelGrader(grader, context);
			case "python":
				return await runPythonGrader(grader, context);
			case "external_harness":
				// "external_harness" is the legacy SWE-bench path AND now backs the new
				// "endpoint" grader UI. Fall through to a true HTTP runner when a URL is
				// supplied; otherwise the sync runGrader (in graders.ts) reads the
				// already-present harness result from generatedOutput.
				if (typeof grader.config.url === "string" && grader.config.url.trim()) {
					return await runEndpointGrader(grader, context);
				}
				break;
			default:
				break;
		}
	} catch (err) {
		return {
			id: grader.id,
			name: grader.name,
			type: grader.type,
			score: 0,
			passed: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
	// Caller should have routed sync types through runGrader; signal "no-op" so
	// the caller can fall back to the sync path.
	return {
		id: grader.id,
		name: grader.name,
		type: grader.type,
		score: null,
		passed: false,
		skipped: true,
		error: "async runner declined; use sync runGrader",
	};
}

/* -------------------------------------------------------------------------- */
/* score_model — labeler + scorer                                             */
/* -------------------------------------------------------------------------- */

type ScoreModelMode = "labeler" | "scorer";

async function runScoreModelGrader(
	grader: GraderDefinition,
	context: GraderContext,
): Promise<GraderResult> {
	const mode: ScoreModelMode = grader.config.mode === "scorer" ? "scorer" : "labeler";
	const systemTemplate = stringOrEmpty(grader.config.systemTemplate);
	const userTemplate = stringOrEmpty(grader.config.userTemplate);
	const slug = stringOrEmpty(grader.config.model) || envEvaluatorSlug();

	if (!systemTemplate && !userTemplate) {
		return skipped(grader, "score_model grader has no prompt templates");
	}

	const sample = sampleFromContext(context);
	const item = itemFromContext(context);
	const range = readRange(grader.config.range);
	const variables = { item, sample, range };
	const systemPrompt = renderTemplate(systemTemplate, variables);
	const userPrompt = renderTemplate(userTemplate, variables);

	const responseSchema = isRecord(grader.config.responseSchema)
		? (grader.config.responseSchema as Record<string, unknown>)
		: undefined;
	const responseToolName =
		typeof grader.config.responseToolName === "string" && grader.config.responseToolName.trim()
			? grader.config.responseToolName.trim()
			: "emit_evaluation";

	let evaluatorReply: { output: string; toolUse?: { name: string; input: Record<string, unknown> } };
	try {
		evaluatorReply = await invokeEvaluatorAgent(slug, systemPrompt, userPrompt, {
			responseSchema,
			responseToolName,
		});
	} catch (err) {
		return skipped(
			grader,
			err instanceof Error ? err.message : String(err),
		);
	}

	const raw = evaluatorReply.output ?? "";
	let parsed: Record<string, unknown> | null = null;

	// Strict-tool path: when the runtime forced a single tool call, its
	// `input` already conforms to `responseSchema`. Skip JSON parsing of
	// free-text and use the structured object directly.
	if (evaluatorReply.toolUse && isRecord(evaluatorReply.toolUse.input)) {
		parsed = evaluatorReply.toolUse.input;
	}

	if (!parsed) parsed = parseJsonReply(raw);

	// Fallback: models sometimes ignore the "respond with JSON" instruction and
	// emit a bare label string ("Pass", "Fail", "Positive", ...). If we know
	// the labeler's allowed labels we can recover.
	if (!parsed && mode === "labeler") {
		const passingLabels = readPassingLabels(grader.config.passingLabels);
		const allLabels = readAllLabels(grader.config.labels);
		const known = new Set([...passingLabels, ...allLabels].map((s) => s.toLowerCase()));
		const trimmed = raw.trim();
		const firstToken = trimmed.split(/[\s.,;:!?]+/)[0] ?? "";
		if (firstToken && known.has(firstToken.toLowerCase())) {
			parsed = { label: firstToken, reasoning: trimmed };
		}
	}

	// Fallback for scorer: a bare numeric response is acceptable.
	if (!parsed && mode === "scorer") {
		const numeric = Number(raw.trim());
		if (Number.isFinite(numeric)) {
			parsed = { score: numeric, reasoning: raw.trim() };
		}
	}

	if (!parsed) {
		return {
			id: grader.id,
			name: grader.name,
			type: grader.type,
			score: 0,
			passed: false,
			error: `evaluator response was not valid JSON: ${raw.slice(0, 200)}`,
		};
	}

	if (mode === "labeler") {
		const label = stringOrEmpty(parsed.label);
		const passingLabels = readPassingLabels(grader.config.passingLabels);
		const passed = passingLabels.includes(label);
		return {
			id: grader.id,
			name: grader.name,
			type: grader.type,
			score: passed ? 1 : 0,
			passed,
			details: {
				mode: "labeler",
				label,
				reasoning: stringOrEmpty(parsed.reasoning) || undefined,
			},
		};
	}

	// scorer mode — normalize raw score onto [0, 1] for aggregate weighting,
	// but keep the original numeric scale in details for display.
	const rawScore = Number(parsed.score);
	if (!Number.isFinite(rawScore)) {
		return {
			id: grader.id,
			name: grader.name,
			type: grader.type,
			score: 0,
			passed: false,
			error: "evaluator response missing numeric `score`",
		};
	}
	const normalized = normalizeOnto01(rawScore, range);
	const passThreshold = readNumber(grader.config.passThreshold, 0.5);
	const passThresholdNormalized = normalizeOnto01(passThreshold, range);
	const passed = normalized >= passThresholdNormalized;
	return {
		id: grader.id,
		name: grader.name,
		type: grader.type,
		score: normalized,
		passed,
		details: {
			mode: "scorer",
			rawScore,
			range,
			reasoning: stringOrEmpty(parsed.reasoning) || undefined,
		},
	};
}

async function invokeEvaluatorAgent(
	slug: string,
	systemPrompt: string,
	userPrompt: string,
	options: {
		responseSchema?: Record<string, unknown>;
		responseToolName?: string;
	} = {},
): Promise<{ output: string; toolUse?: { name: string; input: Record<string, unknown> } }> {
	const requestBody: Record<string, unknown> = { systemPrompt, userPrompt };
	if (options.responseSchema) {
		requestBody.responseSchema = options.responseSchema;
		if (options.responseToolName) {
			requestBody.responseToolName = options.responseToolName;
		}
	}

	// Path 1: operator-supplied direct HTTPS endpoint. Same shape as the
	// dapr-agent-py endpoint below — kept for cases where the operator wants to
	// proxy grading through their own service (e.g., a Cloudflare Worker that
	// wraps OpenAI / a custom rubric pipeline). Operator endpoints may or
	// may not honor `responseSchema`; we forward it and read `toolUse` when
	// present, otherwise fall back to text.
	const direct = env.EVALUATIONS_GRADER_URL?.trim();
	if (direct) {
		const res = await daprFetch(direct, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...requestBody, agentSlug: slug }),
			maxRetries: 2,
		});
		if (!res.ok) {
			throw new Error(`grader endpoint ${direct} returned ${res.status}`);
		}
		const data = (await res.json()) as {
			output?: string;
			text?: string;
			toolUse?: { name?: string; input?: unknown };
		};
		const toolUse =
			data.toolUse && typeof data.toolUse.name === "string" && isRecord(data.toolUse.input)
				? { name: data.toolUse.name, input: data.toolUse.input }
				: undefined;
		return { output: data.output ?? data.text ?? "", toolUse };
	}

	// Path 2: Dapr service-invoke against the per-agent runtime pod's
	// /api/grader-evaluate endpoint (added in services/dapr-agent-py/src/main.py).
	// Wake the pod first; if it's already Active wakeAgentRuntime returns fast.
	try {
		await wakeAgentRuntime(slug, 30_000);
	} catch (err) {
		throw new Error(
			`failed to wake agent-runtime-${slug}: ${
				err instanceof Error ? err.message : String(err)
			}; ensure an AgentRuntime CR exists for this slug or set EVALUATIONS_GRADER_URL`,
		);
	}

	const sidecar = getDaprSidecarUrl();
	const url = `${sidecar}/v1.0/invoke/agent-runtime-${slug}/method/api/grader-evaluate`;
	const res = await daprFetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(requestBody),
		maxRetries: 1,
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(
			`agent-runtime-${slug} /api/grader-evaluate returned ${res.status}: ${text.slice(0, 300)}`,
		);
	}
	const data = (await res.json()) as {
		output?: string;
		toolUse?: { name?: string; input?: unknown };
	};
	const toolUse =
		data.toolUse && typeof data.toolUse.name === "string" && isRecord(data.toolUse.input)
			? { name: data.toolUse.name, input: data.toolUse.input }
			: undefined;
	const output = data.output ?? "";
	if (!output && !toolUse) throw new Error("evaluator returned empty output");
	return { output, toolUse };
}

function envEvaluatorSlug(): string {
	return env.EVALUATIONS_GRADER_AGENT_SLUG?.trim() || "evaluator-default";
}

/* -------------------------------------------------------------------------- */
/* python — code-runtime                                                      */
/* -------------------------------------------------------------------------- */

async function runPythonGrader(
	grader: GraderDefinition,
	context: GraderContext,
): Promise<GraderResult> {
	const userSource = stringOrEmpty(grader.config.source);
	if (!userSource.trim()) {
		return skipped(grader, "python grader has no source code");
	}

	const sample = sampleFromContext(context);
	const item = itemFromContext(context);

	// code-runtime contract (services/code-runtime/src/index.ts):
	//   POST /execute { language, source, entrypoint, args, ... }
	// The Python runner imports the source as a module, calls
	// `entrypoint(*args)`, and prints `{"result": <returned>}`. We just point
	// at the user-supplied `grade` function and pass [sample, item].
	const baseUrl = getCodeRuntimeUrl();
	let res: Response;
	try {
		res = await daprFetch(`${baseUrl}/execute`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				language: "python",
				source: userSource,
				entrypoint: "grade",
				args: [sample, item],
			}),
			maxRetries: 1,
		});
	} catch (err) {
		return skipped(
			grader,
			`code-runtime unreachable: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!res.ok) {
		return skipped(grader, `code-runtime returned ${res.status}`);
	}
	const envelope = (await res.json()) as {
		success?: boolean;
		data?: unknown;
		error?: string;
	};
	if (envelope.success === false) {
		return {
			id: grader.id,
			name: grader.name,
			type: grader.type,
			score: 0,
			passed: false,
			error: (envelope.error ?? "code-runtime reported failure").slice(0, 500),
		};
	}
	const score = Number(envelope.data);
	if (!Number.isFinite(score)) {
		return {
			id: grader.id,
			name: grader.name,
			type: grader.type,
			score: 0,
			passed: false,
			error: `python grader returned non-numeric value: ${JSON.stringify(envelope.data).slice(0, 200)}`,
		};
	}
	const passThreshold = readNumber(grader.config.passThreshold, 0.5);
	return {
		id: grader.id,
		name: grader.name,
		type: grader.type,
		score: clamp01(score),
		passed: score >= passThreshold,
		details: { rawScore: score, passThreshold },
	};
}

/* -------------------------------------------------------------------------- */
/* endpoint — direct HTTPS grader                                             */
/* -------------------------------------------------------------------------- */

async function runEndpointGrader(
	grader: GraderDefinition,
	context: GraderContext,
): Promise<GraderResult> {
	const url = stringOrEmpty(grader.config.url);
	if (!url.trim()) return skipped(grader, "endpoint grader has no URL");
	const headersConfig = (grader.config.headers as Record<string, string>) ?? {};
	const sample = sampleFromContext(context);
	const item = itemFromContext(context);
	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...headersConfig },
			body: JSON.stringify({ sample, item }),
		});
	} catch (err) {
		return skipped(
			grader,
			`endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!res.ok) {
		return skipped(grader, `endpoint returned ${res.status}`);
	}
	const body = (await res.json()) as Record<string, unknown>;
	const scorePath = stringOrEmpty(grader.config.scorePath) || "score";
	const rawScore = readPath(body, scorePath);
	const score = Number(rawScore);
	if (!Number.isFinite(score)) {
		return {
			id: grader.id,
			name: grader.name,
			type: grader.type,
			score: 0,
			passed: false,
			error: `endpoint response missing numeric value at \`${scorePath}\``,
		};
	}
	const passThreshold = readNumber(grader.config.passThreshold, 0.5);
	return {
		id: grader.id,
		name: grader.name,
		type: grader.type,
		score: clamp01(score),
		passed: score >= passThreshold,
		details: { rawScore: score },
	};
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function skipped(grader: GraderDefinition, error: string): GraderResult {
	return {
		id: grader.id,
		name: grader.name,
		type: grader.type,
		score: null,
		passed: false,
		skipped: true,
		error,
	};
}

function sampleFromContext(context: GraderContext): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const generated = context.generatedOutput;
	if (typeof generated === "string") out.output_text = generated;
	else if (generated !== undefined && generated !== null) {
		out.output = generated;
		// Try common fields for output_text
		if (isRecord(generated)) {
			const candidate =
				generated.output_text ?? generated.text ?? generated.content;
			if (typeof candidate === "string") out.output_text = candidate;
		}
	}
	return out;
}

function itemFromContext(context: GraderContext): Record<string, unknown> {
	const inputObj = isRecord(context.input) ? context.input : {};
	return {
		...inputObj,
		input: inputObj.input ?? context.input,
		ground_truth: context.expectedOutput,
		expectedOutput: context.expectedOutput,
	};
}

function renderTemplate(template: string, variables: Record<string, unknown>): string {
	return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
		const value = readPath(variables, key);
		if (value === undefined || value === null) return "";
		return typeof value === "string" ? value : JSON.stringify(value);
	});
}

function readPath(source: unknown, path: string): unknown {
	const parts = path.split(".").filter(Boolean);
	let cur: unknown = source;
	for (const p of parts) {
		if (!isRecord(cur)) return undefined;
		cur = cur[p];
	}
	return cur;
}

function parseJsonReply(raw: string): Record<string, unknown> | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	// Strip code fences if present
	const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
	const candidate = fenced ? fenced[1] : trimmed;
	try {
		const parsed = JSON.parse(candidate);
		if (isRecord(parsed)) return parsed;
	} catch {
		// fallthrough to scan-for-object
	}
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start >= 0 && end > start) {
		try {
			const parsed = JSON.parse(candidate.slice(start, end + 1));
			if (isRecord(parsed)) return parsed;
		} catch {
			// give up
		}
	}
	return null;
}

function stringOrEmpty(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function readNumber(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number.parseFloat(String(value));
	return Number.isFinite(n) ? n : fallback;
}

function readRange(value: unknown): { min: number; max: number } {
	if (isRecord(value)) {
		const min = readNumber(value.min, 0);
		const max = readNumber(value.max, 1);
		return min < max ? { min, max } : { min: 0, max: 1 };
	}
	return { min: 0, max: 1 };
}

function readPassingLabels(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((v): v is string => typeof v === "string");
	}
	return [];
}

function readAllLabels(value: unknown): string[] {
	// model_labeler config.labels is `Array<{ label: string, passing: boolean }>`
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const entry of value) {
		if (isRecord(entry) && typeof entry.label === "string" && entry.label) {
			out.push(entry.label);
		}
	}
	return out;
}

function normalizeOnto01(value: number, range: { min: number; max: number }): number {
	if (range.max === range.min) return clamp01(value);
	return clamp01((value - range.min) / (range.max - range.min));
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
