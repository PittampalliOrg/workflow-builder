import type { EvaluationGraderType } from "$lib/server/db/schema";

export const EVALUATION_GRADER_TYPES = [
	"string_check",
	"text_similarity",
	"score_model",
	"python",
	"multi",
	"external_harness",
] as const satisfies readonly EvaluationGraderType[];

export type GraderDefinition = {
	id?: string;
	name: string;
	type: EvaluationGraderType;
	config: Record<string, unknown>;
	weight?: number;
	passThreshold?: number;
	enabled?: boolean;
};

export type GraderContext = {
	input: Record<string, unknown>;
	expectedOutput: unknown;
	generatedOutput: unknown;
};

export type GraderResult = {
	id?: string;
	name: string;
	type: EvaluationGraderType;
	score: number | null;
	passed: boolean;
	skipped?: boolean;
	error?: string;
	details?: Record<string, unknown>;
	children?: GraderResult[];
};

const STRING_OPERATIONS = new Set([
	"equals",
	"contains",
	"not_contains",
	"starts_with",
	"ends_with",
	"regex",
]);

export function isEvaluationGraderType(
	value: unknown,
): value is EvaluationGraderType {
	return (
		typeof value === "string" &&
		EVALUATION_GRADER_TYPES.includes(value as EvaluationGraderType)
	);
}

export function validateGraderDefinition(
	value: unknown,
	index = 0,
): GraderDefinition {
	const raw = asRecord(value, `grader ${index + 1}`);
	const type = raw.type;
	if (!isEvaluationGraderType(type)) {
		throw new Error(`Unsupported grader type: ${String(type)}`);
	}
	const name =
		typeof raw.name === "string" && raw.name.trim()
			? raw.name.trim()
			: defaultGraderName(type, index);
	const config = validateGraderConfig(type, raw.config);
	return {
		id: typeof raw.id === "string" ? raw.id : undefined,
		name,
		type,
		config,
		weight: clampNumber(raw.weight, 1, 100, 1),
		passThreshold: clampNumber(raw.passThreshold, 0, 1, 1),
		enabled: raw.enabled !== false,
	};
}

export function validateGraderConfig(
	type: EvaluationGraderType,
	value: unknown,
): Record<string, unknown> {
	const config = isRecord(value) ? { ...value } : {};
	switch (type) {
		case "string_check": {
			const operation =
				typeof config.operation === "string" && STRING_OPERATIONS.has(config.operation)
					? config.operation
					: "contains";
			return {
				...config,
				operation,
				targetPath: readString(config.targetPath, "generatedOutput"),
				referencePath: readString(config.referencePath, "expectedOutput"),
				caseSensitive: config.caseSensitive === true,
			};
		}
		case "text_similarity":
			return {
				...config,
				targetPath: readString(config.targetPath, "generatedOutput"),
				referencePath: readString(config.referencePath, "expectedOutput"),
				threshold: clampNumber(config.threshold, 0, 1, 0.8),
			};
		case "score_model":
			return {
				...config,
				targetPath: readString(config.targetPath, "generatedOutput"),
				rubric: readString(config.rubric, ""),
			};
		case "python":
			return {
				...config,
				code: readString(config.code, ""),
			};
		case "multi": {
			const graders = Array.isArray(config.graders)
				? config.graders.map((grader, index) =>
						validateGraderDefinition(grader, index),
					)
				: [];
			if (graders.length === 0) {
				throw new Error("multi grader requires at least one child grader");
			}
			return {
				...config,
				graders,
				aggregation:
					config.aggregation === "all" || config.aggregation === "any"
						? config.aggregation
						: "average",
			};
		}
		case "external_harness":
			return {
				...config,
				resultPath: readString(config.resultPath, "generatedOutput"),
				passPath: readString(config.passPath, "resolved"),
				scorePath: readString(config.scorePath, "score"),
			};
	}
}

export function runGrader(
	grader: GraderDefinition,
	context: GraderContext,
): GraderResult {
	try {
		switch (grader.type) {
			case "string_check":
				return runStringCheck(grader, context);
			case "text_similarity":
				return runTextSimilarity(grader, context);
			case "score_model":
				return runScoreModel(grader);
			case "python":
				return runPythonGrader(grader);
			case "multi":
				return runMultiGrader(grader, context);
			case "external_harness":
				return runExternalHarness(grader, context);
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
}

/**
 * Async variant of runGrader. Sync types fall through to runGrader; types that
 * need an external service (score_model, python, endpoint-shaped
 * external_harness) dispatch to the async runners in `./grader-runners.ts`.
 *
 * Service layer should use this instead of `runGrader` whenever possible.
 */
export async function runGraderAsync(
	grader: GraderDefinition,
	context: GraderContext,
): Promise<GraderResult> {
	const needsAsync =
		grader.type === "score_model" ||
		grader.type === "python" ||
		(grader.type === "external_harness" &&
			typeof grader.config.url === "string" &&
			(grader.config.url as string).trim().length > 0);
	if (!needsAsync) return runGrader(grader, context);
	const runners = await import("./grader-runners");
	const result = await runners.runGraderAsync(grader, context);
	if (result.skipped && result.error === "async runner declined; use sync runGrader") {
		return runGrader(grader, context);
	}
	return result;
}

export function aggregateGraderResults(
	results: GraderResult[],
	weightsById = new Map<string, number>(),
): { score: number | null; passed: boolean; error: string | null } {
	const active = results.filter((result) => !result.skipped);
	if (active.length === 0) {
		return { score: null, passed: false, error: "No graders produced a score" };
	}
	const errors = active
		.map((result) => result.error)
		.filter((value): value is string => Boolean(value));
	const scored = active.filter((result) => typeof result.score === "number");
	const totalWeight = scored.reduce(
		(total, result) => total + weightFor(result, weightsById),
		0,
	);
	const score =
		totalWeight > 0
			? scored.reduce(
					(total, result) =>
						total + (result.score ?? 0) * weightFor(result, weightsById),
					0,
				) / totalWeight
			: null;
	return {
		score,
		passed: errors.length === 0 && active.every((result) => result.passed),
		error: errors[0] ?? null,
	};
}

function runStringCheck(
	grader: GraderDefinition,
	context: GraderContext,
): GraderResult {
	const config = grader.config;
	const operation = readString(config.operation, "contains");
	const caseSensitive = config.caseSensitive === true;
	const rawTarget = resolveConfiguredValue(config, context, "targetPath");
	const rawReference =
		config.value !== undefined
			? config.value
			: resolveConfiguredValue(config, context, "referencePath");
	const target = normalizeComparable(rawTarget, caseSensitive);
	const reference = normalizeComparable(rawReference, caseSensitive);
	let passed = false;
	if (operation === "equals") passed = target === reference;
	else if (operation === "contains") passed = target.includes(reference);
	else if (operation === "not_contains") passed = !target.includes(reference);
	else if (operation === "starts_with") passed = target.startsWith(reference);
	else if (operation === "ends_with") passed = target.endsWith(reference);
	else if (operation === "regex") {
		const flags = caseSensitive ? "" : "i";
		passed = new RegExp(asString(rawReference), flags).test(asString(rawTarget));
	}
	return {
		id: grader.id,
		name: grader.name,
		type: grader.type,
		score: passed ? 1 : 0,
		passed,
		details: { operation, caseSensitive },
	};
}

function runTextSimilarity(
	grader: GraderDefinition,
	context: GraderContext,
): GraderResult {
	const target = asString(resolveConfiguredValue(grader.config, context, "targetPath"));
	const reference = asString(
		resolveConfiguredValue(grader.config, context, "referencePath"),
	);
	const score = jaccardSimilarity(target, reference);
	const threshold = clampNumber(grader.config.threshold, 0, 1, 0.8);
	return {
		id: grader.id,
		name: grader.name,
		type: grader.type,
		score,
		passed: score >= threshold,
		details: { threshold, metric: "token_jaccard" },
	};
}

function runScoreModel(grader: GraderDefinition): GraderResult {
	if (typeof grader.config.mockScore === "number") {
		const score = clampNumber(grader.config.mockScore, 0, 1, 0);
		return {
			id: grader.id,
			name: grader.name,
			type: grader.type,
			score,
			passed: score >= (grader.passThreshold ?? 1),
			details: { mode: "mock" },
		};
	}
	return {
		id: grader.id,
		name: grader.name,
		type: grader.type,
		score: null,
		passed: false,
		skipped: true,
		error: "score_model graders require an external model-grading worker",
	};
}

function runPythonGrader(grader: GraderDefinition): GraderResult {
	return {
		id: grader.id,
		name: grader.name,
		type: grader.type,
		score: null,
		passed: false,
		skipped: true,
		error: "python graders require a sandboxed grader worker",
	};
}

function runMultiGrader(
	grader: GraderDefinition,
	context: GraderContext,
): GraderResult {
	const children = (grader.config.graders as GraderDefinition[]).map((child) =>
		runGrader(child, context),
	);
	const aggregation = readString(grader.config.aggregation, "average");
	const scored = children.filter((child) => typeof child.score === "number");
	const score =
		scored.length > 0
			? scored.reduce((total, child) => total + (child.score ?? 0), 0) /
				scored.length
			: null;
	const passed =
		aggregation === "all"
			? children.every((child) => child.passed)
			: aggregation === "any"
				? children.some((child) => child.passed)
				: (score ?? 0) >= (grader.passThreshold ?? 1);
	return {
		id: grader.id,
		name: grader.name,
		type: grader.type,
		score,
		passed,
		children,
		details: { aggregation },
	};
}

function runExternalHarness(
	grader: GraderDefinition,
	context: GraderContext,
): GraderResult {
	const result = getByPath(context, readString(grader.config.resultPath, "generatedOutput"));
	if (result === undefined || result === null) {
		return {
			id: grader.id,
			name: grader.name,
			type: grader.type,
			score: null,
			passed: false,
			skipped: true,
			error: "external harness result is not available",
		};
	}
	const record = isRecord(result) ? result : { value: result };
	const passValue =
		getByPath(record, readString(grader.config.passPath, "resolved")) ??
		record.passed ??
		record.resolved;
	const status = typeof record.status === "string" ? record.status : "";
	const passed =
		passValue === true ||
		status === "passed" ||
		status === "resolved" ||
		status === "success";
	const rawScore =
		getByPath(record, readString(grader.config.scorePath, "score")) ??
		(passed ? 1 : 0);
	const score = typeof rawScore === "number" ? clampNumber(rawScore, 0, 1, 0) : passed ? 1 : 0;
	return {
		id: grader.id,
		name: grader.name,
		type: grader.type,
		score,
		passed,
		details: { status: status || null },
	};
}

function resolveConfiguredValue(
	config: Record<string, unknown>,
	context: GraderContext,
	pathKey: "targetPath" | "referencePath",
): unknown {
	return getByPath(context, readString(config[pathKey], pathKey === "targetPath" ? "generatedOutput" : "expectedOutput"));
}

function getByPath(value: unknown, path: string): unknown {
	const parts = path.split(".").filter(Boolean);
	let current: unknown = value;
	for (const part of parts) {
		if (!isRecord(current)) return undefined;
		current = current[part];
	}
	return current;
}

function normalizeComparable(value: unknown, caseSensitive: boolean): string {
	const text = asString(value);
	return caseSensitive ? text : text.toLowerCase();
}

function asString(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	return JSON.stringify(value);
}

function jaccardSimilarity(a: string, b: string): number {
	const left = new Set(tokenize(a));
	const right = new Set(tokenize(b));
	if (left.size === 0 && right.size === 0) return 1;
	if (left.size === 0 || right.size === 0) return 0;
	let intersection = 0;
	for (const token of left) {
		if (right.has(token)) intersection += 1;
	}
	const union = new Set([...left, ...right]).size;
	return union === 0 ? 0 : intersection / union;
}

function tokenize(value: string): string[] {
	return value.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

function weightFor(result: GraderResult, weightsById: Map<string, number>): number {
	return result.id ? (weightsById.get(result.id) ?? 1) : 1;
}

function defaultGraderName(type: EvaluationGraderType, index: number): string {
	return `${type.replace(/_/g, " ")} ${index + 1}`;
}

function readString(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function clampNumber(
	value: unknown,
	min: number,
	max: number,
	fallback: number,
): number {
	const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(parsed, min), max);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
