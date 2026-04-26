import type {
	BenchmarkRunInstanceStatus,
	BenchmarkRunStatus,
} from "$lib/server/db/schema";

export type SwebenchSuiteSlug = "SWE-bench_Verified" | "SWE-bench_Lite";

export type SwebenchSuiteDefinition = {
	id: string;
	slug: SwebenchSuiteSlug;
	name: string;
	description: string;
	datasetName: string;
	datasetSplit: "test";
	sourceUrl: string;
	defaultInstanceLimit: number;
	metadata: Record<string, unknown>;
};

export const SWEBENCH_SUITES: SwebenchSuiteDefinition[] = [
	{
		id: "bsuite_swebench_verified",
		slug: "SWE-bench_Verified",
		name: "SWE-bench Verified",
		description: "Human-validated SWE-bench subset for software issue resolution.",
		datasetName: "princeton-nlp/SWE-bench_Verified",
		datasetSplit: "test",
		sourceUrl: "https://www.swebench.com/",
		defaultInstanceLimit: 500,
		metadata: { family: "swebench", official: true },
	},
	{
		id: "bsuite_swebench_lite",
		slug: "SWE-bench_Lite",
		name: "SWE-bench Lite",
		description: "Smaller SWE-bench subset commonly used for faster evaluation.",
		datasetName: "princeton-nlp/SWE-bench_Lite",
		datasetSplit: "test",
		sourceUrl: "https://www.swebench.com/",
		defaultInstanceLimit: 300,
		metadata: { family: "swebench", official: true },
	},
];

export type NormalizedSwebenchInstance = {
	instanceId: string;
	repo: string | null;
	baseCommit: string | null;
	problemStatement: string | null;
	hintsText: string | null;
	testMetadata: Record<string, unknown>;
	goldPatch: string | null;
	metadata: Record<string, unknown>;
};

export function normalizeSwebenchSuiteSlug(value: string): SwebenchSuiteSlug {
	const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
	if (
		normalized === "swe_bench_verified" ||
		normalized === "swebench_verified" ||
		normalized === "verified"
	) {
		return "SWE-bench_Verified";
	}
	if (
		normalized === "swe_bench_lite" ||
		normalized === "swebench_lite" ||
		normalized === "lite"
	) {
		return "SWE-bench_Lite";
	}
	if (value === "SWE-bench_Verified" || value === "SWE-bench_Lite") return value;
	throw new Error(`Unsupported benchmark suite: ${value}`);
}

export function normalizeInstanceIds(value: unknown): string[] {
	const raw = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(/[\n,\s]+/g)
			: [];
	const ids = raw
		.map((item) => String(item).trim())
		.filter(Boolean)
		.map((item) => item.replace(/^["']|["']$/g, ""));
	return Array.from(new Set(ids));
}

export function normalizeSwebenchInstance(
	raw: Record<string, unknown>,
): NormalizedSwebenchInstance {
	const instanceId = readRequiredString(raw, "instance_id");
	const repo = readOptionalString(raw, "repo") ?? repoFromInstanceId(instanceId);
	const baseCommit = readOptionalString(raw, "base_commit");
	const problemStatement = readOptionalString(raw, "problem_statement");
	const hintsText =
		readOptionalString(raw, "hints_text") ?? readOptionalString(raw, "hints");
	const goldPatch = readOptionalString(raw, "patch");
	const testMetadata: Record<string, unknown> = {};
	for (const key of [
		"test_patch",
		"FAIL_TO_PASS",
		"PASS_TO_PASS",
		"fail_to_pass",
		"pass_to_pass",
		"version",
		"environment_setup_commit",
	]) {
		if (raw[key] !== undefined) testMetadata[key] = raw[key];
	}
	const metadata = { ...raw };
	for (const key of [
		"instance_id",
		"repo",
		"base_commit",
		"problem_statement",
		"hints_text",
		"hints",
		"patch",
	]) {
		delete metadata[key];
	}

	return {
		instanceId,
		repo,
		baseCommit,
		problemStatement,
		hintsText,
		testMetadata,
		goldPatch,
		metadata,
	};
}

export type SwebenchPrediction = {
	instance_id: string;
	model_name_or_path: string;
	model_patch: string;
};

export function buildSwebenchPrediction(params: {
	instanceId: string;
	modelNameOrPath: string;
	modelPatch: string | null | undefined;
}): SwebenchPrediction {
	return {
		instance_id: params.instanceId,
		model_name_or_path: params.modelNameOrPath,
		model_patch: params.modelPatch ?? "",
	};
}

export function buildPredictionsJsonl(
	predictions: SwebenchPrediction[],
): string {
	return predictions.map((p) => JSON.stringify(p)).join("\n") + "\n";
}

export const RUN_TERMINAL_STATUSES: ReadonlySet<BenchmarkRunStatus> = new Set([
	"completed",
	"failed",
	"cancelled",
]);

export const INSTANCE_TERMINAL_STATUSES: ReadonlySet<BenchmarkRunInstanceStatus> =
	new Set(["resolved", "failed", "error", "timeout", "cancelled"]);

const RUN_TRANSITIONS: Record<BenchmarkRunStatus, BenchmarkRunStatus[]> = {
	queued: ["inferencing", "failed", "cancelled"],
	inferencing: ["evaluating", "failed", "cancelled"],
	evaluating: ["completed", "failed", "cancelled"],
	completed: [],
	failed: [],
	cancelled: [],
};

export function canTransitionBenchmarkRun(
	from: BenchmarkRunStatus,
	to: BenchmarkRunStatus,
): boolean {
	return RUN_TRANSITIONS[from]?.includes(to) ?? false;
}

export function summarizeRunInstances(
	statuses: BenchmarkRunInstanceStatus[],
): Record<string, number> {
	const summary: Record<string, number> = {};
	for (const status of statuses) {
		summary[status] = (summary[status] ?? 0) + 1;
	}
	const resolved = summary.resolved ?? 0;
	const total = statuses.length;
	summary.total = total;
	summary.resolvedRate = total > 0 ? resolved / total : 0;
	return summary;
}

export function inferPatchShaInput(patch: string | null | undefined): string {
	return patch ?? "";
}

function readRequiredString(
	raw: Record<string, unknown>,
	key: string,
): string {
	const value = readOptionalString(raw, key);
	if (!value) throw new Error(`SWE-bench instance is missing ${key}`);
	return value;
}

function readOptionalString(
	raw: Record<string, unknown>,
	key: string,
): string | null {
	const value = raw[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function repoFromInstanceId(instanceId: string): string | null {
	const match = /^([^_]+)__([^-]+)-/.exec(instanceId);
	if (!match) return null;
	return `${match[1]}/${match[2]}`;
}
