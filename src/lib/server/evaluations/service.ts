import { createHash } from "node:crypto";
import { error } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	evaluationArtifacts,
	evaluationDatasetRows,
	evaluationDatasets,
	evaluationGraders,
	evaluationRunItems,
	evaluationRuns,
	evaluations,
	sessions,
	workflowExecutions,
	workflows,
	type EvaluationArtifactKind,
	type EvaluationGraderType,
	type EvaluationRunItemStatus,
	type EvaluationRunStatus,
	type EvaluationSubjectType,
} from "$lib/server/db/schema";
import {
	AgentRefResolutionError,
	resolveSpecAgentRefs,
} from "$lib/server/agents/resolver";
import { daprFetch, getOrchestratorUrl } from "$lib/server/dapr-client";
import { getRemovedSw10AgentCallsError } from "$lib/server/workflows/sw10-agent-validation";
import { getMissingRequiredTriggerFields } from "$lib/server/workflows/trigger-validation";
import { expandGreenfieldPromptInput } from "$lib/server/workflows/greenfield-prompt";
import { validateTriggerModel } from "$lib/server/workflows/model-validation";
import { applyWorkflowInputDefaults } from "$lib/utils/workflow-input-config";
import {
	buildPredictionsJsonl,
	buildSwebenchPrediction,
	normalizeInstanceIds,
	normalizeSwebenchInstance,
	normalizeSwebenchSuiteSlug,
	repoFromInstanceId,
	SWEBENCH_ALLOWED_AGENT_TOOLS,
	SWEBENCH_SUITES,
	type SwebenchSuiteSlug,
} from "$lib/server/benchmarks/swebench";
import {
	resolveSwebenchInferenceEnvironment,
	swebenchInferenceEnvironmentPromptNotes,
	type ResolvedSwebenchInferenceEnvironment,
} from "$lib/server/benchmarks/inference-environments";
import { buildStableWorkspaceRef } from "$lib/server/benchmarks/workspace-ref";
import {
	aggregateGraderResults,
	runGrader,
	runGraderAsync,
	validateGraderDefinition,
	type GraderDefinition,
	type GraderResult,
} from "./graders";

const HIDDEN_EVALUATION_WORKFLOW_NAME = "Evaluation item runner";
const DEFAULT_SWEBENCH_COMMAND_TIMEOUT_MS = 900_000;
const SWEBENCH_EVALUATION_WORKSPACE_ROOT = "/sandbox";
const SWEBENCH_EVALUATION_REPO_PATH = "/sandbox/repo";
const CODE_EVAL_PROTOCOL_MODE = "internal-agent-visible-tests";
const CODE_EVAL_BENCHMARK_COMPARABLE = false;
const CODE_EVAL_PYTEST_COMMAND =
	"/sandbox/.venv/bin/python -m pytest -q --tb=short --noconftest test_solution.py";
const RUN_TERMINAL_STATUSES = new Set<EvaluationRunStatus>([
	"completed",
	"failed",
	"cancelled",
]);

const ACTIVE_ITEM_STATUSES: EvaluationRunItemStatus[] = [
	"queued",
	"running",
	"grading",
];
const ITEM_TERMINAL_STATUSES = new Set<EvaluationRunItemStatus>([
	"passed",
	"failed",
	"error",
	"cancelled",
	"skipped",
]);

function requireDb() {
	if (!db) throw error(503, "Database not configured");
	return db;
}

export type DatasetRowInput = {
	externalId?: string | null;
	input?: Record<string, unknown>;
	expectedOutput?: unknown;
	generatedOutput?: unknown;
	annotations?: Record<string, unknown>;
	rating?: number | null;
	feedback?: string | null;
	metadata?: Record<string, unknown>;
	// Phase H — bidirectional origin pointers. Set when the row was authored
	// via "Add to dataset" from a benchmark run (originRunInstanceId) or a
	// session (originSessionId). NULL for hand-crafted/imported rows.
	originRunInstanceId?: string | null;
	originSessionId?: string | null;
};

export type CreateEvaluationDatasetInput = {
	projectId: string;
	userId: string;
	name: string;
	description?: string | null;
	sourceType?: string | null;
	sourceUrl?: string | null;
	schema?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	rows?: unknown[];
};

export type CreateEvaluationInput = {
	projectId: string;
	userId: string;
	name: string;
	description?: string | null;
	datasetId?: string | null;
	taskConfig?: Record<string, unknown>;
	dataSourceConfig?: Record<string, unknown>;
	testingCriteria?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	graders?: unknown[];
};

export type CreateEvaluationRunInput = {
	projectId: string;
	userId: string;
	evaluationId: string;
	datasetId?: string | null;
	rowIds?: string[];
	subjectType?: EvaluationSubjectType;
	subjectId?: string | null;
	subjectVersion?: string | null;
	executionConfig?: Record<string, unknown>;
	importedOutputs?: unknown;
	autoGrade?: boolean;
};

export type CreateSwebenchEvaluationTemplateInput = {
	projectId: string;
	userId: string;
	suiteSlug: string;
	name?: string | null;
	description?: string | null;
	instanceIds?: unknown;
	rows?: unknown[];
};

export type CodeEvalSuiteSlug = "humaneval-plus" | "mbpp-plus" | "bigcodebench";

export type CreateCodeEvalTemplateInput = {
	projectId: string;
	userId: string;
	suiteSlug: CodeEvalSuiteSlug;
	name?: string | null;
	description?: string | null;
	rows?: unknown[];
	graderAgentSlug?: string | null;
};

const CODE_EVAL_WORKFLOW_ID = "code-eval-item";
const CODE_EVAL_EVALPLUS_SANDBOX_TEMPLATE = "code-eval-evalplus";
const CODE_EVAL_BIGCODEBENCH_SANDBOX_TEMPLATE = "code-eval-bigcodebench";

const CODE_EVAL_SUITES: Record<
	CodeEvalSuiteSlug,
	{
		name: string;
		description: string;
		datasetName: string;
		datasetSplit: string;
		datasetRevision?: string;
		sourceUrl: string;
	}
> = {
	"humaneval-plus": {
		name: "HumanEval+",
		description:
			"164 short Python function-completion tasks from EvalPlus (HumanEval with extra correctness tests).",
		datasetName: "evalplus/humanevalplus",
		datasetSplit: "test",
		sourceUrl: "https://github.com/evalplus/evalplus",
	},
	"mbpp-plus": {
		name: "MBPP+",
		description:
			"~378 entry-level Python tasks (sanitized MBPP) with EvalPlus's expanded correctness tests.",
		datasetName: "evalplus/mbppplus",
		datasetSplit: "test",
		sourceUrl: "https://github.com/evalplus/evalplus",
	},
	bigcodebench: {
		name: "BigCodeBench",
		description:
			"1140 practical Python tasks calling 139 libraries; tests run with pytest.",
		datasetName: "bigcode/bigcodebench",
		datasetSplit: "test",
		datasetRevision: "v0.1.4",
		sourceUrl: "https://github.com/bigcode-project/bigcodebench",
	},
};

export function normalizeCodeEvalSuiteSlug(value: string): CodeEvalSuiteSlug {
	const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
	if (normalized === "humaneval-plus" || normalized === "humanevalplus" || normalized === "humaneval+")
		return "humaneval-plus";
	if (normalized === "mbpp-plus" || normalized === "mbppplus" || normalized === "mbpp+") return "mbpp-plus";
	if (normalized === "bigcodebench" || normalized === "big-code-bench") return "bigcodebench";
	throw new Error(`Unsupported code-eval suite: ${value}`);
}

export async function listEvaluationDatasets(projectId: string) {
	const database = requireDb();
	const datasets = await database
		.select()
		.from(evaluationDatasets)
		.where(eq(evaluationDatasets.projectId, projectId))
		.orderBy(desc(evaluationDatasets.createdAt));
	const counts = await rowCountsByDataset(datasets.map((dataset) => dataset.id));
	return datasets.map((dataset) => serializeDataset(dataset, counts.get(dataset.id) ?? 0));
}

export async function getEvaluationDataset(
	projectId: string,
	datasetId: string,
	limit = 500,
) {
	const database = requireDb();
	const dataset = await requireDataset(database, projectId, datasetId);
	const rows = await database
		.select()
		.from(evaluationDatasetRows)
		.where(eq(evaluationDatasetRows.datasetId, datasetId))
		.orderBy(asc(evaluationDatasetRows.createdAt))
		.limit(Math.min(Math.max(limit, 1), 1000));
	return {
		...serializeDataset(dataset, rows.length),
		rows: rows.map(serializeDatasetRow),
	};
}

export async function createEvaluationDataset(input: CreateEvaluationDatasetInput) {
	const database = requireDb();
	const name = input.name.trim();
	if (!name) throw error(400, "Dataset name is required");
	const rows = (input.rows ?? []).map((row) => normalizeDatasetRow(row));
	const created = await database.transaction(async (tx) => {
		const [dataset] = await tx
			.insert(evaluationDatasets)
			.values({
				projectId: input.projectId,
				createdBy: input.userId,
				name,
				description: input.description?.trim() || null,
				sourceType: input.sourceType?.trim() || "manual",
				sourceUrl: input.sourceUrl?.trim() || null,
				schema: input.schema ?? {},
				metadata: input.metadata ?? {},
			})
			.returning();
		if (rows.length > 0) {
			await tx.insert(evaluationDatasetRows).values(
				rows.map((row) => ({
					datasetId: dataset.id,
					externalId: row.externalId ?? null,
					input: row.input ?? {},
					expectedOutput: row.expectedOutput,
					generatedOutput: row.generatedOutput,
					annotations: row.annotations ?? {},
					rating: row.rating ?? null,
					feedback: row.feedback ?? null,
					metadata: row.metadata ?? {},
				})),
			);
		}
		return dataset;
	});
	return getEvaluationDataset(input.projectId, created.id);
}

export async function updateEvaluationDataset(
	projectId: string,
	datasetId: string,
	patch: Record<string, unknown>,
) {
	const database = requireDb();
	await requireDataset(database, projectId, datasetId);
	const update: Partial<typeof evaluationDatasets.$inferInsert> = {
		updatedAt: new Date(),
	};
	if (typeof patch.name === "string" && patch.name.trim()) {
		update.name = patch.name.trim();
	}
	if (typeof patch.description === "string" || patch.description === null) {
		update.description = typeof patch.description === "string" ? patch.description : null;
	}
	if (isRecord(patch.schema)) update.schema = patch.schema;
	if (isRecord(patch.metadata)) update.metadata = patch.metadata;
	const [dataset] = await database
		.update(evaluationDatasets)
		.set(update)
		.where(eq(evaluationDatasets.id, datasetId))
		.returning();
	return serializeDataset(dataset, await countDatasetRows(datasetId));
}

export async function createEvaluationDatasetRows(
	projectId: string,
	datasetId: string,
	rows: unknown[],
) {
	const database = requireDb();
	await requireDataset(database, projectId, datasetId);
	const normalized = rows.map((row) => normalizeDatasetRow(row));
	if (normalized.length === 0) throw error(400, "At least one row is required");
	const inserted = await database
		.insert(evaluationDatasetRows)
		.values(
			normalized.map((row) => ({
				datasetId,
				externalId: row.externalId ?? null,
				input: row.input ?? {},
				expectedOutput: row.expectedOutput,
				generatedOutput: row.generatedOutput,
				annotations: row.annotations ?? {},
				rating: row.rating ?? null,
				feedback: row.feedback ?? null,
				metadata: row.metadata ?? {},
				originRunInstanceId: row.originRunInstanceId ?? null,
				originSessionId: row.originSessionId ?? null,
			})),
		)
		.returning();
	return inserted.map(serializeDatasetRow);
}

export async function importEvaluationDatasetRows(params: {
	projectId: string;
	datasetId: string;
	format: "jsonl" | "json" | "csv";
	content: string;
}) {
	const rows = parseDatasetImport(params.content, params.format);
	return createEvaluationDatasetRows(params.projectId, params.datasetId, rows);
}

export async function updateEvaluationDatasetRow(params: {
	projectId: string;
	datasetId: string;
	rowId: string;
	patch: Record<string, unknown>;
}) {
	const database = requireDb();
	await requireDataset(database, params.projectId, params.datasetId);
	const update: Partial<typeof evaluationDatasetRows.$inferInsert> = {
		updatedAt: new Date(),
	};
	if (params.patch.externalId === null || typeof params.patch.externalId === "string") {
		update.externalId =
			typeof params.patch.externalId === "string" && params.patch.externalId.trim()
				? params.patch.externalId.trim()
				: null;
	}
	if (isRecord(params.patch.input)) update.input = params.patch.input;
	if ("expectedOutput" in params.patch) update.expectedOutput = params.patch.expectedOutput;
	if ("generatedOutput" in params.patch) update.generatedOutput = params.patch.generatedOutput;
	if (isRecord(params.patch.annotations)) update.annotations = params.patch.annotations;
	if (typeof params.patch.rating === "number" || params.patch.rating === null) {
		update.rating =
			typeof params.patch.rating === "number" ? Math.trunc(params.patch.rating) : null;
	}
	if (typeof params.patch.feedback === "string" || params.patch.feedback === null) {
		update.feedback =
			typeof params.patch.feedback === "string" ? params.patch.feedback : null;
	}
	if (isRecord(params.patch.metadata)) update.metadata = params.patch.metadata;
	const [row] = await database
		.update(evaluationDatasetRows)
		.set(update)
		.where(
			and(
				eq(evaluationDatasetRows.datasetId, params.datasetId),
				eq(evaluationDatasetRows.id, params.rowId),
			),
		)
		.returning();
	if (!row) throw error(404, "Dataset row not found");
	return serializeDatasetRow(row);
}

export async function deleteEvaluationDatasetRow(params: {
	projectId: string;
	datasetId: string;
	rowId: string;
}) {
	const database = requireDb();
	await requireDataset(database, params.projectId, params.datasetId);
	await database
		.delete(evaluationDatasetRows)
		.where(
			and(
				eq(evaluationDatasetRows.datasetId, params.datasetId),
				eq(evaluationDatasetRows.id, params.rowId),
			),
		);
	return { success: true };
}

export async function listEvaluations(projectId: string) {
	const database = requireDb();
	const rows = await database
		.select({
			evaluation: evaluations,
			datasetName: evaluationDatasets.name,
		})
		.from(evaluations)
		.leftJoin(evaluationDatasets, eq(evaluationDatasets.id, evaluations.datasetId))
		.where(eq(evaluations.projectId, projectId))
		.orderBy(desc(evaluations.createdAt));
	const latestRuns = await latestRunsByEvaluation(rows.map((row) => row.evaluation.id));
	return rows.map((row) =>
		serializeEvaluation(row.evaluation, {
			datasetName: row.datasetName,
			latestRun: latestRuns.get(row.evaluation.id) ?? null,
		}),
	);
}

export async function getEvaluationDefinition(
	projectId: string,
	evaluationId: string,
) {
	const database = requireDb();
	const [row] = await database
		.select({
			evaluation: evaluations,
			datasetName: evaluationDatasets.name,
		})
		.from(evaluations)
		.leftJoin(evaluationDatasets, eq(evaluationDatasets.id, evaluations.datasetId))
		.where(
			and(
				eq(evaluations.projectId, projectId),
				eq(evaluations.id, evaluationId),
			),
		)
		.limit(1);
	if (!row) return null;
	const [graders, runs] = await Promise.all([
		database
			.select()
			.from(evaluationGraders)
			.where(eq(evaluationGraders.evaluationId, evaluationId))
			.orderBy(asc(evaluationGraders.orderIndex), asc(evaluationGraders.createdAt)),
		database
			.select()
			.from(evaluationRuns)
			.where(eq(evaluationRuns.evaluationId, evaluationId))
			.orderBy(desc(evaluationRuns.createdAt))
			.limit(10),
	]);
	return {
		...serializeEvaluation(row.evaluation, { datasetName: row.datasetName }),
		graders: graders.map(serializeGrader),
		runs: runs.map((run) => serializeRun(run)),
	};
}

export async function createEvaluationDefinition(input: CreateEvaluationInput) {
	const database = requireDb();
	const name = input.name.trim();
	if (!name) throw error(400, "Evaluation name is required");
	if (input.datasetId) {
		await requireDataset(database, input.projectId, input.datasetId);
	}
	const graders = normalizeGraders(input.graders);
	const created = await database.transaction(async (tx) => {
		const [evaluation] = await tx
			.insert(evaluations)
			.values({
				projectId: input.projectId,
				createdBy: input.userId,
				datasetId: input.datasetId || null,
				name,
				description: input.description?.trim() || null,
				taskConfig: input.taskConfig ?? {},
				dataSourceConfig: input.dataSourceConfig ?? {},
				testingCriteria: input.testingCriteria ?? {},
				metadata: input.metadata ?? {},
			})
			.returning();
		await tx.insert(evaluationGraders).values(
			graders.map((grader, index) => ({
				evaluationId: evaluation.id,
				name: grader.name,
				type: grader.type,
				config: grader.config,
				weight: Math.trunc(grader.weight ?? 1),
				passThreshold: grader.passThreshold ?? 1,
				orderIndex: index,
				enabled: grader.enabled !== false,
			})),
		);
		return evaluation;
	});
	return getEvaluationDefinition(input.projectId, created.id);
}

export async function createSwebenchEvaluationTemplate(
	input: CreateSwebenchEvaluationTemplateInput,
) {
	const suiteSlug = normalizeSwebenchSuiteSlug(input.suiteSlug);
	const suite = SWEBENCH_SUITES.find((candidate) => candidate.slug === suiteSlug);
	if (!suite) throw error(400, `Unsupported SWE-bench suite: ${suiteSlug}`);
	const rows = normalizeSwebenchRowsForEvaluation({
		suiteSlug,
		rows: input.rows,
		instanceIds: input.instanceIds,
	});
	if (rows.length === 0) {
		throw error(400, "At least one SWE-bench row or instance id is required");
	}
	if (rows.length > suite.defaultInstanceLimit) {
		throw error(
			400,
			`${suite.name} template may include at most ${suite.defaultInstanceLimit} rows`,
		);
	}
	const baseName = input.name?.trim() || suite.name;
	const dataset = await createEvaluationDataset({
		projectId: input.projectId,
		userId: input.userId,
		name: `${baseName} Patch Smoke Dataset`,
		description:
			input.description?.trim() ||
			`${suite.name} rows imported for the legacy patch-capture smoke path.`,
		sourceType: "swebench",
		sourceUrl: suite.sourceUrl,
		schema: {
			input: {
				instanceId: "string",
				repo: "string",
				baseCommit: "string",
				problemStatement: "string",
				hintsText: "string|null",
			},
			generatedOutput: {
				modelPatch: "string",
				evaluation: "object|null",
			},
		},
		metadata: {
			family: "swebench",
			suiteSlug,
			datasetName: suite.datasetName,
			datasetSplit: suite.datasetSplit,
		},
		rows,
	});
	const evaluation = await createEvaluationDefinition({
		projectId: input.projectId,
		userId: input.userId,
		name: `${baseName} Patch Smoke`,
		description:
			input.description?.trim() ||
			`${suite.name} generic evaluation template. This captures a model patch and checks patch presence; official SWE-bench grading runs from Benchmarks.`,
		datasetId: dataset.id,
		taskConfig: {
			adapter: "swebench",
			suiteSlug,
			datasetName: suite.datasetName,
			promptTemplate: "swebench",
		},
		dataSourceConfig: {
			type: "dataset",
			datasetId: dataset.id,
			sourceType: "swebench",
		},
		testingCriteria: {
			adapter: "external_harness",
			harness: "swebench",
			predictionPath: "generatedOutput.modelPatch",
			mode: "patch_smoke",
		},
		metadata: {
			family: "swebench",
			official: false,
			mode: "patch_smoke",
			suiteSlug,
			datasetName: suite.datasetName,
		},
		graders: [
			{
				name: "Patch produced",
				type: "string_check",
				config: {
					operation: "contains",
					targetPath: "generatedOutput.workflowOutput.modelPatch",
					value: "diff --git",
				},
				passThreshold: 1,
				weight: 1,
			},
			{
				name: "Official harness placeholder (disabled)",
				type: "external_harness",
				config: {
					harness: "swebench",
					resultPath: "generatedOutput.workflowOutput.evaluation",
					passPath: "resolved",
					scorePath: "score",
				},
				enabled: false,
				weight: 1,
			},
		],
	});
	return { dataset, evaluation };
}

export async function createCodeEvalTemplate(input: CreateCodeEvalTemplateInput) {
	const suiteSlug = normalizeCodeEvalSuiteSlug(input.suiteSlug);
	const suite = CODE_EVAL_SUITES[suiteSlug];
	if (!suite) throw error(400, `Unsupported code-eval suite: ${suiteSlug}`);

	const incomingRows = Array.isArray(input.rows) ? input.rows : [];
	if (incomingRows.length === 0) {
		throw error(
			400,
			`At least one ${suite.name} row is required (caller must fetch from datasets-server.huggingface.co/rows for ${suite.datasetName})`,
		);
	}
	const normalizedRows = incomingRows.map((row, index) =>
		normalizeCodeEvalRowForEvaluation({ suiteSlug, row, index }),
	);

	const baseName = input.name?.trim() || suite.name;
	const dataset = await createEvaluationDataset({
		projectId: input.projectId,
		userId: input.userId,
		name: `${baseName} Dataset`,
		description:
			input.description?.trim() ||
			`${suite.name} rows imported as a generic evaluation dataset.`,
		sourceType: "code-eval",
		sourceUrl: suite.sourceUrl,
		schema: {
			input: {
				taskId: "string",
				prompt: "string",
				entryPoint: "string",
				suite: "string",
				solvePrompt: "string",
				runtimeProbeCommand: "string",
				sandboxTemplate: "string",
			},
			expectedOutput: {
				testFileContent: "string",
				testFileSha256: "string",
				canonicalSolution: "string",
			},
		},
		metadata: {
			family: "code-eval",
			suiteSlug,
			datasetName: suite.datasetName,
			datasetSplit: suite.datasetSplit,
			datasetRevision: suite.datasetRevision ?? null,
			protocolMode: CODE_EVAL_PROTOCOL_MODE,
			benchmarkComparable: CODE_EVAL_BENCHMARK_COMPARABLE,
		},
		rows: normalizedRows,
	});

	const evaluation = await createEvaluationDefinition({
		projectId: input.projectId,
		userId: input.userId,
		name: baseName,
		description:
			input.description?.trim() ||
			`${suite.name} evaluation. The agent reads each task's prompt + tests, writes /sandbox/solution.py, and we run deterministic pytest to score it.`,
		datasetId: dataset.id,
		taskConfig: {
			adapter: "code-eval",
			suiteSlug,
			datasetName: suite.datasetName,
			datasetSplit: suite.datasetSplit,
			datasetRevision: suite.datasetRevision ?? null,
			protocolMode: CODE_EVAL_PROTOCOL_MODE,
			benchmarkComparable: CODE_EVAL_BENCHMARK_COMPARABLE,
			workflowId: CODE_EVAL_WORKFLOW_ID,
			sandboxTemplate: codeEvalSandboxTemplateForSuite(suiteSlug),
		},
		dataSourceConfig: {
			type: "dataset",
			datasetId: dataset.id,
			sourceType: "code-eval",
		},
		testingCriteria: {
			adapter: "pytest",
			protocolMode: CODE_EVAL_PROTOCOL_MODE,
			benchmarkComparable: CODE_EVAL_BENCHMARK_COMPARABLE,
			predictionPath: "generatedOutput.workflowOutput.solutionContent",
		},
		metadata: {
			family: "code-eval",
			suiteSlug,
			datasetName: suite.datasetName,
			datasetSplit: suite.datasetSplit,
			datasetRevision: suite.datasetRevision ?? null,
			sandboxTemplate: codeEvalSandboxTemplateForSuite(suiteSlug),
			protocolMode: CODE_EVAL_PROTOCOL_MODE,
			benchmarkComparable: CODE_EVAL_BENCHMARK_COMPARABLE,
		},
		graders: buildCodeEvalDefaultGraders(),
	});
	return { dataset, evaluation };
}

export function buildCodeEvalDefaultGraders(): GraderDefinition[] {
	return [
		{
			name: "Tests pass",
			type: "string_check",
			config: {
				operation: "equals",
				targetPath: "generatedOutput.workflowOutput.exitCode",
				value: "0",
			},
			passThreshold: 1,
			weight: 1,
			enabled: true,
		},
	];
}

export function normalizeCodeEvalRowForEvaluation(params: {
	suiteSlug: CodeEvalSuiteSlug;
	row: unknown;
	index: number;
}): DatasetRowInput {
	const outerRecord = isRecord(params.row) ? params.row : {};
	const record = isRecord(outerRecord.row) ? outerRecord.row : outerRecord;
	const suite = CODE_EVAL_SUITES[params.suiteSlug];
	const taskId =
		readCodeEvalScalar(record.task_id) ??
		readCodeEvalScalar(record.taskId) ??
		`${params.suiteSlug}-${params.index + 1}`;
	const promptInfo = selectCodeEvalPrompt(params.suiteSlug, record);
	const prompt = promptInfo.prompt;
	if (!prompt) {
		throw error(400, `Code-eval row ${taskId} is missing prompt`);
	}
	const test = readString(record.test) ?? readString(record.test_code) ?? "";
	if (!test) {
		throw error(400, `Code-eval row ${taskId} is missing test code`);
	}
	const entryPoint =
		readString(record.entry_point) ??
		readString(record.entryPoint) ??
		inferPythonEntryPoint(readString(record.code) ?? readString(record.code_prompt) ?? "") ??
		"solution";
	const canonicalSolution =
		readString(record.canonical_solution) ??
		readString(record.canonicalSolution) ??
		readString(record.code) ??
		"";
	const libs = normalizeCodeEvalLibs(record.libs ?? record.required_libs);
	const sandboxTemplate = codeEvalSandboxTemplateForSuite(params.suiteSlug);
	const testFileContent = normalizeCodeEvalTestFile({
		suiteSlug: params.suiteSlug,
		test,
		entryPoint,
	});
	const solvePrompt = buildCodeEvalSolvePrompt({
		taskId,
		prompt,
		entryPoint,
	});
	const runtimeProbeCommand = buildCodeEvalRuntimeProbeCommand(libs);
	const testFileSha256 = sha256(testFileContent);
	const metadata = buildCodeEvalRowMetadata({
		suiteSlug: params.suiteSlug,
		taskId,
		record,
		outerRecord,
		promptSource: promptInfo.source,
		libs,
		sandboxTemplate,
		testFileSha256,
		datasetRevision: suite?.datasetRevision ?? null,
	});
	return {
		externalId: taskId,
		input: {
			taskId,
			prompt,
			entryPoint,
			suite: params.suiteSlug,
			solvePrompt,
			runtimeProbeCommand,
			libs,
			sandboxTemplate,
		},
		expectedOutput: {
			testFileContent,
			testFileSha256,
			canonicalSolution,
		},
		annotations: {},
		metadata,
	};
}

function selectCodeEvalPrompt(
	suiteSlug: CodeEvalSuiteSlug,
	record: Record<string, unknown>,
): { prompt: string; source: string } {
	const candidates: Array<[string, string | null]> =
		suiteSlug === "bigcodebench"
			? [
					["instruct_prompt", readString(record.instruct_prompt)],
					["prompt", readString(record.prompt)],
					["complete_prompt", readString(record.complete_prompt)],
					["code_prompt", readString(record.code_prompt)],
				]
			: [
					["prompt", readString(record.prompt)],
					["instruct_prompt", readString(record.instruct_prompt)],
					["complete_prompt", readString(record.complete_prompt)],
					["code_prompt", readString(record.code_prompt)],
				];
	for (const [source, prompt] of candidates) {
		if (prompt) return { prompt, source };
	}
	return { prompt: "", source: "missing" };
}

function buildCodeEvalRowMetadata(params: {
	suiteSlug: CodeEvalSuiteSlug;
	taskId: string;
	record: Record<string, unknown>;
	outerRecord: Record<string, unknown>;
	promptSource: string;
	libs: string[];
	sandboxTemplate: string;
	testFileSha256: string;
	datasetRevision: string | null;
}): Record<string, unknown> {
	const metadata: Record<string, unknown> = {
		family: "code-eval",
		suiteSlug: params.suiteSlug,
		taskId: params.taskId,
		promptSource: params.promptSource,
		protocolMode: CODE_EVAL_PROTOCOL_MODE,
		benchmarkComparable: CODE_EVAL_BENCHMARK_COMPARABLE,
		sandboxTemplate: params.sandboxTemplate,
		testFileSha256: params.testFileSha256,
	};
	const rowIndex =
		typeof params.outerRecord.row_idx === "number"
			? params.outerRecord.row_idx
			: typeof params.outerRecord.rowIndex === "number"
				? params.outerRecord.rowIndex
				: null;
	if (rowIndex != null) metadata.sourceRowIndex = rowIndex;

	if (params.suiteSlug === "mbpp-plus") {
		metadata.evalplus = {
			taskId: params.taskId,
			testList: cloneJsonValue(params.record.test_list),
			testImports: cloneJsonValue(params.record.test_imports),
			code: readString(params.record.code) ?? null,
		};
	}

	if (params.suiteSlug === "humaneval-plus") {
		metadata.evalplus = {
			taskId: params.taskId,
			entryPoint: readString(params.record.entry_point) ?? null,
		};
	}

	if (params.suiteSlug === "bigcodebench") {
		metadata.testHarness = "bigcodebench-shared-module-globals";
		metadata.testHarnessVersion = 2;
		metadata.bigcodebench = {
			taskId: params.taskId,
			split: normalizeBigCodeBenchSplit(readString(params.record.split)),
			subset: normalizeBigCodeBenchSubset(readString(params.record.subset)),
			datasetRevision: readString(params.record.dataset_revision) ?? params.datasetRevision,
			completePrompt: readString(params.record.complete_prompt) ?? null,
			instructPrompt: readString(params.record.instruct_prompt) ?? null,
			codePrompt: readString(params.record.code_prompt) ?? null,
			libs: params.libs,
			canonicalSolution: readString(params.record.canonical_solution) ?? null,
			entryPoint: readString(params.record.entry_point) ?? null,
		};
	}

	return metadata;
}

function cloneJsonValue(value: unknown): unknown {
	if (value === undefined) return undefined;
	try {
		return JSON.parse(JSON.stringify(value)) as unknown;
	} catch {
		return null;
	}
}

function normalizeBigCodeBenchSplit(value: string | null): "complete" | "instruct" {
	return value === "complete" ? "complete" : "instruct";
}

function normalizeBigCodeBenchSubset(value: string | null): "full" | "hard" {
	return value === "hard" ? "hard" : "full";
}

function normalizeCodeEvalLibs(value: unknown): string[] {
	const source = Array.isArray(value)
		? value
		: typeof value === "string"
			? parseCodeEvalLibString(value)
			: [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of source) {
		if (typeof item !== "string") continue;
		const lib = item.trim().replace(/^[\s'"\[\(]+|[\s'"\]\)]+$/g, "");
		if (!lib || seen.has(lib)) continue;
		seen.add(lib);
		out.push(lib);
	}
	return out;
}

function codeEvalSandboxTemplateForSuite(suiteSlug: CodeEvalSuiteSlug): string {
	return suiteSlug === "bigcodebench"
		? CODE_EVAL_BIGCODEBENCH_SANDBOX_TEMPLATE
		: CODE_EVAL_EVALPLUS_SANDBOX_TEMPLATE;
}

function parseCodeEvalLibString(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) return [];
	const quoted = Array.from(trimmed.matchAll(/['"]([^'"]+)['"]/g), (match) => match[1]);
	if (quoted.length > 0) return quoted;
	return trimmed.split(/[,;\s]+/g);
}

function buildCodeEvalRuntimeProbeCommand(libs: string[]): string {
	return [
		"set -eu",
		"/sandbox/.venv/bin/python - <<'PY'",
		"import importlib, json, sys",
		`libs = ${JSON.stringify(libs)}`,
		"aliases = {",
		'    "beautifulsoup4": "bs4",',
		'    "bs4": "bs4",',
		'    "Django": "django",',
		'    "django": "django",',
		'    "Faker": "faker",',
		'    "Flask-Mail": "flask_mail",',
		'    "Levenshtein": "Levenshtein",',
		'    "opencv-python": "cv2",',
		'    "opencv-python-headless": "cv2",',
		'    "Pillow": "PIL",',
		'    "pillow": "PIL",',
		'    "pycryptodome": "Crypto",',
		'    "pyyaml": "yaml",',
		'    "PyYAML": "yaml",',
		'    "python-dateutil": "dateutil",',
		'    "python-docx": "docx",',
		'    "python-Levenshtein": "Levenshtein",',
		'    "Requests": "requests",',
		'    "scikit-image": "skimage",',
		'    "scikit-learn": "sklearn",',
		'    "sklearn": "sklearn",',
		'    "Werkzeug": "werkzeug",',
		"}",
		"missing = []",
		"importlib.import_module('pytest')",
		"for lib in libs:",
		"    module = aliases.get(lib) or aliases.get(lib.lower()) or lib.replace('-', '_')",
		"    try:",
		"        importlib.import_module(module)",
		"    except Exception as exc:",
		"        missing.append({'lib': lib, 'module': module, 'error': str(exc)})",
		"payload = {",
		"    'ok': not missing,",
		"    'python': sys.version.split()[0],",
		"    'pytest': importlib.import_module('pytest').__version__,",
		"    'libs': libs,",
		"    'missing': missing,",
		"}",
		"print(json.dumps(payload, sort_keys=True))",
		"raise SystemExit(1 if missing else 0)",
		"PY",
	].join("\n");
}

function normalizeCodeEvalTestFile(params: {
	suiteSlug: CodeEvalSuiteSlug;
	test: string;
	entryPoint: string;
}): string {
	const test = params.test.trimEnd();
	const header =
		params.suiteSlug === "bigcodebench"
			? buildBigCodeBenchTestHeader(params.entryPoint)
			: buildEvalPlusCodeEvalTestHeader(params.entryPoint);
	const body = test.trimStart();
	const parts = [header, body];

	if (params.suiteSlug === "bigcodebench") {
		return `${parts.join("\n\n")}\n`;
	}

	if (hasEvalPlusCheckFunction(test)) {
		parts.push(
			[
				"",
				"",
				"def test_evalplus_check():",
				"    check(candidate)",
			].join("\n"),
		);
	} else if (!hasPytestDiscoverableTest(test)) {
		parts.push(
			[
				"",
				"",
				"def test_code_eval_script_executed():",
				"    assert True",
			].join("\n"),
		);
	}

	return `${parts.join("\n\n")}\n`;
}

function buildEvalPlusCodeEvalTestHeader(entryPoint: string): string {
	return [
		"# Generated by workflow-builder. Candidate solution is always /sandbox/solution.py.",
		"import importlib.util as _wb_importlib_util",
		"import os as _wb_os",
		"import sys as _wb_sys",
		"from pathlib import Path as _wb_Path",
		"",
		'_wb_solution_path = _wb_Path(_wb_os.environ.get("CODE_EVAL_SOLUTION_PATH") or "/sandbox/solution.py")',
		"_wb_sandbox_path = str(_wb_solution_path.parent)",
		"if _wb_sandbox_path not in _wb_sys.path:",
		"    _wb_sys.path.insert(0, _wb_sandbox_path)",
		'_wb_spec = _wb_importlib_util.spec_from_file_location("solution", _wb_solution_path)',
		"assert _wb_spec is not None and _wb_spec.loader is not None",
		"_wb_solution = _wb_importlib_util.module_from_spec(_wb_spec)",
		"_wb_sys.modules[_wb_spec.name] = _wb_solution",
		"_wb_spec.loader.exec_module(_wb_solution)",
		`_wb_entry_point = ${JSON.stringify(entryPoint)}`,
		"candidate = getattr(_wb_solution, _wb_entry_point)",
		"globals()[_wb_entry_point] = candidate",
	].join("\n");
}

function buildBigCodeBenchTestHeader(entryPoint: string): string {
	return [
		"# Generated by workflow-builder. Candidate solution is always /sandbox/solution.py.",
		"import importlib.util as _wb_importlib_util",
		"import os as _wb_os",
		"import sys as _wb_sys",
		"from pathlib import Path as _wb_Path",
		"",
		'_wb_solution_path = _wb_Path(_wb_os.environ.get("CODE_EVAL_SOLUTION_PATH") or "/sandbox/solution.py")',
		"_wb_sandbox_path = str(_wb_solution_path.parent)",
		"if _wb_sandbox_path not in _wb_sys.path:",
		"    _wb_sys.path.insert(0, _wb_sandbox_path)",
		'_wb_spec = _wb_importlib_util.spec_from_file_location("solution", _wb_solution_path)',
		"assert _wb_spec is not None and _wb_spec.loader is not None",
		"_wb_solution = _wb_importlib_util.module_from_spec(_wb_spec)",
		"_wb_sys.modules[_wb_spec.name] = _wb_solution",
		"_wb_spec.loader.exec_module(_wb_solution)",
		`_wb_entry_point = ${JSON.stringify(entryPoint)}`,
		"_wb_target_globals = globals()",
		"_wb_candidate = getattr(_wb_solution, _wb_entry_point)",
		"_wb_target_globals[_wb_entry_point] = _wb_candidate",
		'if _wb_entry_point != "task_func":',
		'    _wb_target_globals.setdefault("task_func", _wb_candidate)',
		"for _wb_name, _wb_value in vars(_wb_solution).items():",
		'    if not (_wb_name.startswith("__") and _wb_name.endswith("__")):',
		"        _wb_target_globals[_wb_name] = _wb_value",
	].join("\n");
}

function hasEvalPlusCheckFunction(test: string): boolean {
	return /(^|\n)\s*def\s+check\s*\(\s*candidate\s*\)\s*:/.test(test);
}

function hasPytestDiscoverableTest(test: string): boolean {
	return (
		/(^|\n)\s*def\s+test_[A-Za-z0-9_]*\s*\(/.test(test) ||
		/(^|\n)\s*class\s+Test[A-Za-z0-9_]*\s*(\(|:)/.test(test)
	);
}

function inferPythonEntryPoint(source: string): string | null {
	const match = /(^|\n)\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(source);
	return match?.[2] ?? null;
}

function readCodeEvalScalar(value: unknown): string | null {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return readString(value);
}

function buildCodeEvalSolvePrompt(params: {
	taskId: string;
	prompt: string;
	entryPoint: string;
}): string {
	return [
		`You are solving coding-eval task ${params.taskId}.`,
		"",
		"Task prompt:",
		params.prompt,
		"",
		`Write your complete solution to /sandbox/solution.py. Define ${params.entryPoint} (and any helpers it needs) so that the existing /sandbox/test_solution.py passes.`,
		"",
		"Constraints:",
		"- Write only /sandbox/solution.py. Do not modify /sandbox/test_solution.py or create alternate solution files.",
		"- Do not hardcode the test inputs/outputs. Implement the algorithm correctly.",
		"- Dependencies needed by the benchmark row are preinstalled in /sandbox/.venv. Benchmark mode forbids runtime package installation: Do not run pip install, uv pip install, python -m pip, apt-get, npm install, or any package manager.",
		`- Run \`${CODE_EVAL_PYTEST_COMMAND}\` from /sandbox to check your work. Iterate until it passes, but do not invent new tests.`,
		"- Stop once the test file passes or you've exhausted your turn budget.",
	].join("\n");
}

export async function updateEvaluationDefinition(params: {
	projectId: string;
	evaluationId: string;
	patch: Record<string, unknown>;
}) {
	const database = requireDb();
	const existing = await getEvaluationDefinition(params.projectId, params.evaluationId);
	if (!existing) throw error(404, "Evaluation not found");
	const update: Partial<typeof evaluations.$inferInsert> = {
		updatedAt: new Date(),
	};
	if (typeof params.patch.name === "string" && params.patch.name.trim()) {
		update.name = params.patch.name.trim();
	}
	if (typeof params.patch.description === "string" || params.patch.description === null) {
		update.description =
			typeof params.patch.description === "string" ? params.patch.description : null;
	}
	if (typeof params.patch.datasetId === "string" || params.patch.datasetId === null) {
		if (typeof params.patch.datasetId === "string") {
			await requireDataset(database, params.projectId, params.patch.datasetId);
		}
		update.datasetId = params.patch.datasetId;
	}
	if (isRecord(params.patch.taskConfig)) update.taskConfig = params.patch.taskConfig;
	if (isRecord(params.patch.dataSourceConfig)) {
		update.dataSourceConfig = params.patch.dataSourceConfig;
	}
	if (isRecord(params.patch.testingCriteria)) {
		update.testingCriteria = params.patch.testingCriteria;
	}
	if (isRecord(params.patch.metadata)) update.metadata = params.patch.metadata;
	await database.transaction(async (tx) => {
		await tx
			.update(evaluations)
			.set(update)
			.where(eq(evaluations.id, params.evaluationId));
		if (Array.isArray(params.patch.graders)) {
			const graders = normalizeGraders(params.patch.graders);
			await tx
				.delete(evaluationGraders)
				.where(eq(evaluationGraders.evaluationId, params.evaluationId));
			await tx.insert(evaluationGraders).values(
				graders.map((grader, index) => ({
					evaluationId: params.evaluationId,
					name: grader.name,
					type: grader.type,
					config: grader.config,
					weight: Math.trunc(grader.weight ?? 1),
					passThreshold: grader.passThreshold ?? 1,
					orderIndex: index,
					enabled: grader.enabled !== false,
				})),
			);
		}
	});
	return getEvaluationDefinition(params.projectId, params.evaluationId);
}

export async function listEvaluationRuns(projectId: string, limit = 50) {
	const database = requireDb();
	const rows = await database
		.select({
			run: evaluationRuns,
			evaluationName: evaluations.name,
			datasetName: evaluationDatasets.name,
		})
		.from(evaluationRuns)
		.innerJoin(evaluations, eq(evaluations.id, evaluationRuns.evaluationId))
		.leftJoin(evaluationDatasets, eq(evaluationDatasets.id, evaluationRuns.datasetId))
		.where(eq(evaluationRuns.projectId, projectId))
		.orderBy(desc(evaluationRuns.createdAt))
		.limit(Math.min(Math.max(limit, 1), 100));
	return rows.map((row) =>
		serializeRun(row.run, {
			evaluationName: row.evaluationName,
			datasetName: row.datasetName,
		}),
	);
}

type EvaluationRunItemMode = "full" | "summary";

export async function getEvaluationRun(
	projectId: string,
	runId: string,
	options: { itemMode?: EvaluationRunItemMode } = {},
) {
	const database = requireDb();
	const [row] = await database
		.select({
			run: evaluationRuns,
			evaluationName: evaluations.name,
			datasetName: evaluationDatasets.name,
		})
		.from(evaluationRuns)
		.innerJoin(evaluations, eq(evaluations.id, evaluationRuns.evaluationId))
		.leftJoin(evaluationDatasets, eq(evaluationDatasets.id, evaluationRuns.datasetId))
		.where(and(eq(evaluationRuns.projectId, projectId), eq(evaluationRuns.id, runId)))
		.limit(1);
	if (!row) return null;
	const [items, artifacts] = await Promise.all([
		database
			.select()
			.from(evaluationRunItems)
			.where(eq(evaluationRunItems.runId, runId))
			.orderBy(asc(evaluationRunItems.rowIndex), asc(evaluationRunItems.createdAt)),
		database
			.select()
			.from(evaluationArtifacts)
			.where(eq(evaluationArtifacts.runId, runId))
			.orderBy(desc(evaluationArtifacts.createdAt)),
	]);
	return {
		...serializeRun(row.run, {
			evaluationName: row.evaluationName,
			datasetName: row.datasetName,
		}),
		items: items.map((item) =>
			options.itemMode === "summary"
				? serializeRunItemSummary(item)
				: serializeRunItem(item),
		),
		artifacts: artifacts.map(serializeArtifact),
	};
}

export async function getEvaluationRunItem(
	projectId: string,
	runId: string,
	itemId: string,
) {
	const database = requireDb();
	const [row] = await database
		.select({ item: evaluationRunItems })
		.from(evaluationRunItems)
		.innerJoin(evaluationRuns, eq(evaluationRuns.id, evaluationRunItems.runId))
		.where(
			and(
				eq(evaluationRuns.projectId, projectId),
				eq(evaluationRunItems.runId, runId),
				eq(evaluationRunItems.id, itemId),
			),
		)
		.limit(1);
	return row ? serializeRunItem(row.item) : null;
}

export async function createEvaluationRun(input: CreateEvaluationRunInput) {
	const database = requireDb();
	const [evaluation] = await database
		.select()
		.from(evaluations)
		.where(
			and(
				eq(evaluations.projectId, input.projectId),
				eq(evaluations.id, input.evaluationId),
			),
		)
		.limit(1);
	if (!evaluation) throw error(404, "Evaluation not found");

	const datasetId = input.datasetId ?? evaluation.datasetId;
	if (!datasetId) throw error(400, "Evaluation run requires a dataset");
	await requireDataset(database, input.projectId, datasetId);

	const rowFilters = input.rowIds?.filter(Boolean) ?? [];
	const rows = await database
		.select()
		.from(evaluationDatasetRows)
		.where(
			rowFilters.length > 0
				? and(
						eq(evaluationDatasetRows.datasetId, datasetId),
						inArray(evaluationDatasetRows.id, rowFilters),
					)
				: eq(evaluationDatasetRows.datasetId, datasetId),
		)
		.orderBy(asc(evaluationDatasetRows.createdAt));
	if (rows.length === 0) throw error(400, "Evaluation dataset has no rows");

	const importedOutputs = normalizeImportedOutputs(input.importedOutputs);
	const subjectType = input.subjectType ?? "imported_outputs";
	if (subjectType === "model") {
		throw error(
			400,
			"Direct model evaluation subjects are not implemented yet. Use imported outputs, an agent, or a workflow.",
		);
	}
	if (subjectType !== "imported_outputs" && !input.subjectId?.trim()) {
		throw error(400, "Evaluation run subjectId is required");
	}
	const executionConfig = buildEvaluationRunExecutionConfig(
		evaluation,
		input.executionConfig,
	);
	const now = new Date();
	const [run] = await database.transaction(async (tx) => {
		const [createdRun] = await tx
			.insert(evaluationRuns)
			.values({
				projectId: input.projectId,
				userId: input.userId,
				evaluationId: evaluation.id,
				datasetId,
				status: subjectType === "imported_outputs" ? "grading" : "queued",
				subjectType,
				subjectId: input.subjectId?.trim() || null,
				subjectVersion: input.subjectVersion?.trim() || null,
				executionConfig,
				startedAt: subjectType === "imported_outputs" ? now : null,
				summary: { total: rows.length },
			})
			.returning();
		await tx.insert(evaluationRunItems).values(
			rows.map((row, index) => {
				const generatedOutput =
					importedOutputs.get(row.id) ??
					(row.externalId ? importedOutputs.get(row.externalId) : undefined) ??
					row.generatedOutput;
				return {
					runId: createdRun.id,
					datasetRowId: row.id,
					rowIndex: index,
					status:
						subjectType === "imported_outputs"
							? ("grading" as const)
							: ("queued" as const),
					input: row.input,
					expectedOutput: row.expectedOutput,
					generatedOutput,
					startedAt: subjectType === "imported_outputs" ? now : null,
				};
			}),
		);
		return [createdRun];
	});

	if (input.autoGrade !== false && subjectType === "imported_outputs") {
		await gradeEvaluationRunById(run.id);
	}
	return getEvaluationRun(input.projectId, run.id);
}

function buildEvaluationRunExecutionConfig(
	evaluation: typeof evaluations.$inferSelect,
	inputConfig: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const config = { ...(inputConfig ?? {}) };
	const isCodeEval =
		evaluation.taskConfig?.adapter === "code-eval" ||
		evaluation.metadata?.family === "code-eval";
	if (!isCodeEval) return config;
	const existingSandboxPolicy = isRecord(config.sandboxPolicy)
		? config.sandboxPolicy
		: {};
	return {
		...config,
		sandboxPolicy: {
			...existingSandboxPolicy,
			mode: "per-run",
		},
		protocolMode: CODE_EVAL_PROTOCOL_MODE,
		benchmarkComparable: CODE_EVAL_BENCHMARK_COMPARABLE,
	};
}

export async function gradeEvaluationRun(projectId: string, runId: string) {
	const run = await requireRunForProject(projectId, runId);
	await gradeEvaluationRunById(run.id);
	return getEvaluationRun(projectId, run.id);
}

export async function buildEvaluationPredictionsJsonl(
	projectId: string,
	runId: string,
): Promise<string> {
	const database = requireDb();
	const [run] = await database
		.select()
		.from(evaluationRuns)
		.where(and(eq(evaluationRuns.projectId, projectId), eq(evaluationRuns.id, runId)))
		.limit(1);
	if (!run) throw error(404, "Evaluation run not found");
	const items = await database
		.select()
		.from(evaluationRunItems)
		.where(eq(evaluationRunItems.runId, runId))
		.orderBy(asc(evaluationRunItems.rowIndex), asc(evaluationRunItems.createdAt));
	const modelNameOrPath =
		readString(run.subjectVersion) && readString(run.subjectId)
			? `${run.subjectId}@${run.subjectVersion}`
			: readString(run.subjectId) ?? "evaluation-subject";
	return buildPredictionsJsonl(
		items.map((item) =>
			buildSwebenchPrediction({
				instanceId:
					readString(item.input.instanceId) ??
					readString(item.input.instance_id) ??
					item.datasetRowId ??
					item.id,
				modelNameOrPath,
				modelPatch: extractSwebenchModelPatch(item.generatedOutput),
			}),
		),
	);
}

export function getEvaluationCoordinatorUrl(): string {
	return (
		env.EVALUATION_COORDINATOR_URL ||
		"http://evaluation-coordinator.workflow-builder.svc.cluster.local:8080"
	);
}

export async function startEvaluationCoordinator(runId: string) {
	const internalToken = env.INTERNAL_API_TOKEN;
	if (!internalToken) {
		throw new Error("INTERNAL_API_TOKEN is required to start evaluation coordinator");
	}
	const res = await daprFetch(`${getEvaluationCoordinatorUrl()}/api/v1/evaluation-runs`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Internal-Token": internalToken,
		},
		body: JSON.stringify({ runId }),
		maxRetries: 0,
	});
	const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) {
		throw new Error(
			typeof body.error === "string"
				? body.error
				: typeof body.detail === "string"
					? body.detail
					: `Evaluation coordinator returned ${res.status}`,
		);
	}
	return body;
}

export async function cancelEvaluationRun(projectId: string, runId: string) {
	const database = requireDb();
	const run = await requireRunForProject(projectId, runId);
	if (run.status === "cancelled") return getEvaluationRun(projectId, runId);
	if (run.status === "completed" || run.status === "failed") {
		throw error(409, `Cannot cancel a ${run.status} evaluation run`);
	}
	const now = new Date();
	await database.transaction(async (tx) => {
		await tx
			.update(evaluationRuns)
			.set({
				status: "cancelled",
				cancelRequestedAt: now,
				completedAt: now,
				updatedAt: now,
			})
			.where(eq(evaluationRuns.id, runId));
		await tx
			.update(evaluationRunItems)
			.set({ status: "cancelled", completedAt: now, updatedAt: now })
			.where(
				and(
					eq(evaluationRunItems.runId, runId),
					inArray(evaluationRunItems.status, ACTIVE_ITEM_STATUSES),
				),
			);
	});
	await recomputeEvaluationRunSummary(runId);
	return getEvaluationRun(projectId, runId);
}

export async function markEvaluationRunStatus(
	runId: string,
	status: EvaluationRunStatus,
	extra: Record<string, unknown> = {},
) {
	const database = requireDb();
	const [run] = await database
		.select()
		.from(evaluationRuns)
		.where(eq(evaluationRuns.id, runId))
		.limit(1);
	if (!run) return null;
	if (RUN_TERMINAL_STATUSES.has(run.status) && run.status !== status) {
		throw new Error(`Cannot transition terminal evaluation run ${run.status} -> ${status}`);
	}
	const now = new Date();
	const patch: Partial<typeof evaluationRuns.$inferInsert> = {
		status,
		updatedAt: now,
	};
	if (typeof extra.error === "string" || extra.error === null) {
		patch.error = extra.error as string | null;
	}
	if (typeof extra.coordinatorExecutionId === "string") {
		patch.coordinatorExecutionId = extra.coordinatorExecutionId;
	}
	if (isRecord(extra.summary)) patch.summary = extra.summary;
	if (isRecord(extra.usage)) patch.usage = extra.usage;
	if ((status === "running" || status === "grading") && !run.startedAt) {
		patch.startedAt = now;
	}
	if (RUN_TERMINAL_STATUSES.has(status)) patch.completedAt = now;
	const [updated] = await database
		.update(evaluationRuns)
		.set(patch)
		.where(eq(evaluationRuns.id, runId))
		.returning();
	return updated ?? null;
}

export async function updateEvaluationRunItemOutput(params: {
	runId: string;
	itemId: string;
	generatedOutput: unknown;
	usage?: Record<string, unknown>;
	traceIds?: string[];
	autoGrade?: boolean;
}) {
	const database = requireDb();
	const [item] = await database
		.update(evaluationRunItems)
		.set({
			generatedOutput: params.generatedOutput,
			usage: params.usage ?? {},
			traceIds: params.traceIds ?? [],
			status: "grading",
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(evaluationRunItems.runId, params.runId),
				eq(evaluationRunItems.id, params.itemId),
			),
		)
		.returning();
	if (!item) return null;
	if (params.autoGrade !== false) {
		const graded = await gradeEvaluationRunItemById(item.id);
		await completeEvaluationRunIfReady(params.runId);
		return graded ?? item;
	}
	await recomputeEvaluationRunSummary(params.runId);
	return item;
}

export async function syncEvaluationRunItemFromExecution(params: {
	runId: string;
	itemId: string;
}) {
	const database = requireDb();
	const [row] = await database
		.select({
			run: evaluationRuns,
			item: evaluationRunItems,
			execution: workflowExecutions,
		})
		.from(evaluationRunItems)
		.innerJoin(evaluationRuns, eq(evaluationRuns.id, evaluationRunItems.runId))
		.leftJoin(
			workflowExecutions,
			eq(workflowExecutions.id, evaluationRunItems.workflowExecutionId),
		)
		.where(
			and(
				eq(evaluationRunItems.runId, params.runId),
				eq(evaluationRunItems.id, params.itemId),
			),
		)
		.limit(1);
	if (!row) return null;
	if (!row.execution) return row.item;

	let runtimeStatus: string | null = null;
	let runtimeOutput: unknown = row.execution.output;
	let runtimeTraceId: string | null = null;
	if (row.execution.daprInstanceId) {
		const res = await daprFetch(
			`${getOrchestratorUrl()}/api/v2/workflows/${row.execution.daprInstanceId}/status`,
			{ maxRetries: 1 },
		).catch(() => null);
		if (res?.ok) {
			const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
			runtimeStatus =
				typeof body.runtimeStatus === "string" ? body.runtimeStatus : null;
			runtimeTraceId =
				readString(body.traceId) ??
				readString(body.trace_id) ??
				runtimeTraceId;
			runtimeOutput = body.output ?? body.outputs ?? runtimeOutput;
		}
	}
	const primaryTraceId = runtimeTraceId ?? row.execution.primaryTraceId ?? null;
	if (runtimeTraceId && runtimeTraceId !== row.execution.primaryTraceId) {
		await database
			.update(workflowExecutions)
			.set({
				primaryTraceId: runtimeTraceId,
			})
			.where(eq(workflowExecutions.id, row.execution.id));
	}

	const executionFailed = isFailedWorkflowExecution(row.execution);
	const status = executionFailed
		? "error"
		: mapExecutionStatus(row.execution.status, runtimeStatus);
	if (status === "running" || status === "pending") return row.item;

	const now = new Date();
	const generatedOutput = extractEvaluationGeneratedOutput(
		runtimeOutput ?? row.execution.output,
	);
	const traceIds = collectEvaluationTraceIds(
		{ traceId: primaryTraceId },
		runtimeOutput,
		row.execution.output,
	);
	const sessionRow = row.item.workflowExecutionId
		? await database
				.select({ id: sessions.id })
				.from(sessions)
				.where(eq(sessions.workflowExecutionId, row.item.workflowExecutionId))
				.limit(1)
		: [];
	if (status === "success") {
		const [updated] = await database
			.update(evaluationRunItems)
			.set({
				status: "grading",
				generatedOutput,
				traceIds,
				sessionId: sessionRow[0]?.id ?? row.item.sessionId,
				completedAt: null,
				error: null,
				updatedAt: now,
			})
			.where(eq(evaluationRunItems.id, row.item.id))
			.returning();
		const graded = await gradeEvaluationRunItemById(row.item.id);
		await completeEvaluationRunIfReady(params.runId);
		return graded ?? updated ?? row.item;
	}
	const itemStatus: EvaluationRunItemStatus =
		status === "cancelled" ? "cancelled" : "error";
	const [updated] = await database
		.update(evaluationRunItems)
		.set({
			status: itemStatus,
			error: workflowExecutionError(row.execution, runtimeOutput),
			traceIds,
			sessionId: sessionRow[0]?.id ?? row.item.sessionId,
			completedAt: now,
			updatedAt: now,
		})
		.where(eq(evaluationRunItems.id, row.item.id))
		.returning();
	await recomputeEvaluationRunSummary(params.runId);
	await completeEvaluationRunIfReady(params.runId);
	return updated ?? row.item;
}

export async function markEvaluationRunItemStatus(params: {
	runId: string;
	itemId: string;
	status: EvaluationRunItemStatus;
	error?: string | null;
}) {
	const database = requireDb();
	const now = new Date();
	const patch: Partial<typeof evaluationRunItems.$inferInsert> = {
		status: params.status,
		updatedAt: now,
	};
	if (typeof params.error === "string" || params.error === null) {
		patch.error = params.error;
	}
	if (ITEM_TERMINAL_STATUSES.has(params.status)) {
		patch.completedAt = now;
	}
	if (params.status === "running") {
		patch.startedAt = now;
	}
	const [item] = await database
		.update(evaluationRunItems)
		.set(patch)
		.where(
			and(
				eq(evaluationRunItems.runId, params.runId),
				eq(evaluationRunItems.id, params.itemId),
			),
		)
		.returning();
	if (!item) return null;
	await recomputeEvaluationRunSummary(params.runId);
	await completeEvaluationRunIfReady(params.runId);
	return item;
}

export async function recordEvaluationRunItemGraderResults(params: {
	runId: string;
	itemId: string;
	graderResults: Record<string, unknown>;
	scores?: Record<string, unknown>;
	status?: EvaluationRunItemStatus;
	error?: string | null;
}) {
	const database = requireDb();
	const scores = params.scores ?? {};
	const passed = scores.passed;
	const status =
		params.status ??
		(params.error
			? "error"
			: passed === true
				? "passed"
				: passed === false
					? "failed"
					: "grading");
	const [item] = await database
		.update(evaluationRunItems)
		.set({
			status,
			graderResults: params.graderResults,
			scores,
			error: params.error ?? null,
			completedAt: ITEM_TERMINAL_STATUSES.has(status) ? new Date() : null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(evaluationRunItems.runId, params.runId),
				eq(evaluationRunItems.id, params.itemId),
			),
		)
		.returning();
	if (!item) return null;
	await recomputeEvaluationRunSummary(params.runId);
	await completeEvaluationRunIfReady(params.runId);
	return item;
}

export async function startEvaluationRunItemWorkflow(params: {
	runId: string;
	itemId: string;
}) {
	const database = requireDb();
	const [row] = await database
		.select({
			run: evaluationRuns,
			evaluation: evaluations,
			item: evaluationRunItems,
		})
		.from(evaluationRunItems)
		.innerJoin(evaluationRuns, eq(evaluationRuns.id, evaluationRunItems.runId))
		.innerJoin(evaluations, eq(evaluations.id, evaluationRuns.evaluationId))
		.where(
			and(
				eq(evaluationRunItems.runId, params.runId),
				eq(evaluationRunItems.id, params.itemId),
			),
		)
		.limit(1);
	if (!row) throw error(404, "Evaluation run item not found");
	if (row.run.status === "cancelled" || row.item.status === "cancelled") {
		throw error(409, "Evaluation run is cancelled");
	}
	if (row.item.workflowExecutionId) {
		return {
			executionId: row.item.workflowExecutionId,
			daprInstanceId: row.item.daprInstanceId,
		};
	}
	if (ITEM_TERMINAL_STATUSES.has(row.item.status)) {
		return {
			executionId: row.item.workflowExecutionId,
			daprInstanceId: row.item.daprInstanceId,
		};
	}
	if (!row.run.subjectId) throw error(400, "Evaluation run is missing subjectId");

	let workflow: typeof workflows.$inferSelect;
	let spec: Record<string, unknown>;
	let triggerData: Record<string, unknown>;

	if (row.run.subjectType === "agent") {
		const taskConfigWorkflowId =
			typeof row.evaluation.taskConfig.workflowId === "string"
				? row.evaluation.taskConfig.workflowId.trim()
				: "";
		if (taskConfigWorkflowId) {
			// Workflow-as-DB path. The eval template stores a workflowId
			// pointing at a row in the workflows table (e.g. "code-eval-item"
			// for HumanEval/MBPP/BigCodeBench). We stamp the agent's id+version
			// into every durable/run task's body.agentRef BEFORE calling
			// prepareEvaluationSubjectWorkflowSpec — resolveSpecAgentRefs runs
			// at workflow-load time, BEFORE jq expressions evaluate, so a
			// `${ .trigger.agentRef }` placeholder would fail the resolver's
			// AgentRef shape check.
			workflow = await loadEvaluationSubjectWorkflow({
				projectId: row.run.projectId,
				workflowId: taskConfigWorkflowId,
			});
			const agentRef: Record<string, unknown> = { id: row.run.subjectId };
			const agentVersion = parseOptionalInteger(row.run.subjectVersion);
			if (agentVersion != null) agentRef.version = agentVersion;
			const stampedSpec = stampAgentRefIntoDurableRunSteps(
				workflow.spec as Record<string, unknown>,
				agentRef,
			);
			spec = await prepareEvaluationSubjectWorkflowSpec(stampedSpec);
			triggerData = await prepareEvaluationWorkflowTriggerData({
				spec,
				runId: row.run.id,
				itemId: row.item.id,
				datasetRowId: row.item.datasetRowId,
				input: { ...row.item.input, agentRef },
				expectedOutput: row.item.expectedOutput,
			});
		} else {
			workflow = await ensureHiddenEvaluationWorkflow({
				projectId: row.run.projectId,
				userId: row.run.userId,
			});
			const rawSpec =
				row.evaluation.taskConfig.adapter === "swebench"
					? buildSwebenchEvaluationWorkflowSpec({
							evaluationName: row.evaluation.name,
							runId: row.run.id,
							itemId: row.item.id,
							agentId: row.run.subjectId,
							agentVersion: parseOptionalInteger(row.run.subjectVersion),
							input: row.item.input,
							taskConfig: row.evaluation.taskConfig,
							executionConfig: row.run.executionConfig,
						})
					: buildAgentEvaluationWorkflowSpec({
							evaluationName: row.evaluation.name,
							agentId: row.run.subjectId,
							agentVersion: parseOptionalInteger(row.run.subjectVersion),
							input: row.item.input,
							taskConfig: row.evaluation.taskConfig,
						});
			spec = await resolveEvaluationSpecAgentRefs(rawSpec);
			triggerData = {
				runId: row.run.id,
				itemId: row.item.id,
				input: row.item.input,
			};
		}
	} else if (row.run.subjectType === "workflow") {
		workflow = await loadEvaluationSubjectWorkflow({
			projectId: row.run.projectId,
			workflowId: row.run.subjectId,
		});
		spec = await prepareEvaluationSubjectWorkflowSpec(workflow.spec);
		triggerData = await prepareEvaluationWorkflowTriggerData({
			spec,
			runId: row.run.id,
			itemId: row.item.id,
			datasetRowId: row.item.datasetRowId,
			input: row.item.input,
			expectedOutput: row.item.expectedOutput,
		});
	} else {
		throw error(
			400,
			`Evaluation run subject type ${row.run.subjectType} is not executable by the evaluation coordinator`,
		);
	}

	const [execution] = await database
		.insert(workflowExecutions)
		.values({
			workflowId: workflow.id,
			userId: row.run.userId,
			projectId: row.run.projectId,
			status: "running",
			phase: "running",
			progress: 0,
			input: triggerData,
			executionIrVersion: "sw-1.0",
			executionIr: {
				spec,
				triggerData,
				evaluationRunId: row.run.id,
				evaluationRunItemId: row.item.id,
			},
		})
		.returning({ id: workflowExecutions.id });

	const res = await daprFetch(`${getOrchestratorUrl()}/api/v2/sw-workflows`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			workflow: spec,
			workflowId: workflow.id,
			triggerData,
			dbExecutionId: execution.id,
		}),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		await database
			.update(workflowExecutions)
			.set({
				status: "error",
				phase: "failed",
				error: detail.slice(0, 1000),
				completedAt: new Date(),
			})
			.where(eq(workflowExecutions.id, execution.id));
		throw error(res.status, detail || "Failed to start evaluation item workflow");
	}
	const result = (await res.json()) as { instanceId?: string };
	const daprInstanceId = result.instanceId ?? null;
	await database
		.update(workflowExecutions)
		.set({
			daprInstanceId,
			workflowSessionId: execution.id,
		})
		.where(eq(workflowExecutions.id, execution.id));
	await database
		.update(evaluationRunItems)
		.set({
			status: "running",
			workflowExecutionId: execution.id,
			daprInstanceId,
			startedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(evaluationRunItems.id, row.item.id));
	await markEvaluationRunStatus(row.run.id, "running");
	return { executionId: execution.id, daprInstanceId };
}

export async function recordEvaluationArtifact(params: {
	runId: string;
	runItemId?: string | null;
	kind: EvaluationArtifactKind;
	path?: string | null;
	content?: unknown;
	contentType?: string | null;
	metadata?: Record<string, unknown>;
}) {
	const database = requireDb();
	const body =
		typeof params.content === "string"
			? params.content
			: params.content === undefined
				? ""
				: JSON.stringify(params.content);
	const [artifact] = await database
		.insert(evaluationArtifacts)
		.values({
			runId: params.runId,
			runItemId: params.runItemId ?? null,
			kind: params.kind,
			path: params.path ?? null,
			content: params.content,
			contentType: params.contentType ?? null,
			sizeBytes: body ? Buffer.byteLength(body, "utf8") : null,
			sha256: body ? sha256(body) : null,
			metadata: params.metadata ?? {},
		})
		.returning();
	return serializeArtifact(artifact);
}

export async function recomputeEvaluationRunSummary(runId: string) {
	const database = requireDb();
	const items = await database
		.select()
		.from(evaluationRunItems)
		.where(eq(evaluationRunItems.runId, runId));
	const summary = summarizeRunItems(items);
	await database
		.update(evaluationRuns)
		.set({ summary, updatedAt: new Date() })
		.where(eq(evaluationRuns.id, runId));
	return summary;
}

export async function completeEvaluationRunIfReady(runId: string) {
	const database = requireDb();
	const [run] = await database
		.select()
		.from(evaluationRuns)
		.where(eq(evaluationRuns.id, runId))
		.limit(1);
	if (!run || RUN_TERMINAL_STATUSES.has(run.status)) return run ?? null;
	const activeRows = await database
		.select({ id: evaluationRunItems.id })
		.from(evaluationRunItems)
		.where(
			and(
				eq(evaluationRunItems.runId, runId),
				inArray(evaluationRunItems.status, ACTIVE_ITEM_STATUSES),
			),
		);
	if (activeRows.length > 0) return run;
	const items = await database
		.select({ status: evaluationRunItems.status })
		.from(evaluationRunItems)
		.where(eq(evaluationRunItems.runId, runId));
	if (
		items.length === 0 ||
		items.some((item) => !ITEM_TERMINAL_STATUSES.has(item.status))
	) {
		return run;
	}
	const summary = await recomputeEvaluationRunSummary(runId);
	return markEvaluationRunStatus(runId, "completed", { summary, error: null });
}

async function gradeEvaluationRunById(runId: string) {
	const database = requireDb();
	const [run] = await database
		.select()
		.from(evaluationRuns)
		.where(eq(evaluationRuns.id, runId))
		.limit(1);
	if (!run) throw error(404, "Evaluation run not found");
	if (run.status === "cancelled") return;

	const activeGraders = await loadActiveGraders(run.evaluationId);
	if (activeGraders.length === 0) {
		await markEvaluationRunStatus(runId, "failed", {
			error: "Evaluation has no enabled graders",
		});
		return;
	}

	await markEvaluationRunStatus(runId, "grading");
	const items = await database
		.select()
		.from(evaluationRunItems)
		.where(eq(evaluationRunItems.runId, runId))
		.orderBy(asc(evaluationRunItems.rowIndex), asc(evaluationRunItems.createdAt));
	for (const item of items) {
		if (item.status === "cancelled") continue;
		if (item.generatedOutput === undefined || item.generatedOutput === null) {
			await database
				.update(evaluationRunItems)
				.set({
					status: "error",
					error: "No generated output available for grading",
					completedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(evaluationRunItems.id, item.id));
			continue;
		}
		await gradeLoadedEvaluationRunItem(item, activeGraders);
	}
	const summary = await recomputeEvaluationRunSummary(runId);
	await markEvaluationRunStatus(runId, "completed", { summary, error: null });
}

async function gradeEvaluationRunItemById(itemId: string) {
	const database = requireDb();
	const [row] = await database
		.select({
			run: evaluationRuns,
			item: evaluationRunItems,
		})
		.from(evaluationRunItems)
		.innerJoin(evaluationRuns, eq(evaluationRuns.id, evaluationRunItems.runId))
		.where(eq(evaluationRunItems.id, itemId))
		.limit(1);
	if (!row) return null;
	if (row.run.status === "cancelled" || row.item.status === "cancelled") {
		return row.item;
	}
	const activeGraders = await loadActiveGraders(row.run.evaluationId);
	if (activeGraders.length === 0) {
		await markEvaluationRunStatus(row.run.id, "failed", {
			error: "Evaluation has no enabled graders",
		});
		return row.item;
	}
	if (row.item.generatedOutput === undefined || row.item.generatedOutput === null) {
		const [updated] = await database
			.update(evaluationRunItems)
			.set({
				status: "error",
				error: "No generated output available for grading",
				completedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(evaluationRunItems.id, row.item.id))
			.returning();
		await recomputeEvaluationRunSummary(row.run.id);
		return updated ?? row.item;
	}
	const updated = await gradeLoadedEvaluationRunItem(row.item, activeGraders);
	await recomputeEvaluationRunSummary(row.run.id);
	return updated;
}

async function loadActiveGraders(evaluationId: string) {
	const database = requireDb();
	const graders = await database
		.select()
		.from(evaluationGraders)
		.where(eq(evaluationGraders.evaluationId, evaluationId))
		.orderBy(asc(evaluationGraders.orderIndex), asc(evaluationGraders.createdAt));
	return graders.filter((grader) => grader.enabled);
}

async function gradeLoadedEvaluationRunItem(
	item: typeof evaluationRunItems.$inferSelect,
	activeGraders: Array<typeof evaluationGraders.$inferSelect>,
) {
	const database = requireDb();
	const infrastructureError = detectCodeEvalInfrastructureFailure(
		item.input,
		item.generatedOutput,
	);
	if (infrastructureError) {
		const [updated] = await database
			.update(evaluationRunItems)
			.set({
				status: "error",
				graderResults: {},
				scores: {},
				error: infrastructureError,
				completedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(evaluationRunItems.id, item.id))
			.returning();
		return updated ?? item;
	}
	const weights = new Map(activeGraders.map((grader) => [grader.id, grader.weight]));
	const results = await Promise.all(
		activeGraders.map((grader) =>
			runGraderAsync(
				{
					id: grader.id,
					name: grader.name,
					type: grader.type,
					config: grader.config,
					weight: grader.weight,
					passThreshold: grader.passThreshold,
					enabled: grader.enabled,
				},
				{
					input: item.input,
					expectedOutput: item.expectedOutput,
					generatedOutput: item.generatedOutput,
				},
			),
		),
	);
	const aggregate = aggregateGraderResults(results, weights);
	const status: EvaluationRunItemStatus =
		aggregate.error != null ? "error" : aggregate.passed ? "passed" : "failed";
	const [updated] = await database
		.update(evaluationRunItems)
		.set({
			status,
			graderResults: resultsToRecord(results),
			scores: {
				score: aggregate.score,
				passed: aggregate.passed,
			},
			error: aggregate.error,
			completedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(evaluationRunItems.id, item.id))
		.returning();
	return updated ?? item;
}

export function detectCodeEvalInfrastructureFailure(
	input: unknown,
	generatedOutput: unknown,
): string | null {
	const inputRecord = isRecord(input) ? input : {};
	const generated = isRecord(generatedOutput) ? generatedOutput : {};
	const workflowOutput = isRecord(generated.workflowOutput)
		? generated.workflowOutput
		: isRecord(generated.output)
			? generated.output
			: generated;
	const protocol = isRecord(workflowOutput.protocol) ? workflowOutput.protocol : {};
	const isCodeEval =
		typeof inputRecord.suite === "string" ||
		protocol.mode === CODE_EVAL_PROTOCOL_MODE ||
		workflowOutput.benchmarkComparable === CODE_EVAL_BENCHMARK_COMPARABLE;
	if (!isCodeEval) return null;
	const runtimeProbe = isRecord(workflowOutput.runtimeProbe)
		? workflowOutput.runtimeProbe
		: null;
	if (!runtimeProbe) return null;
	const rawExitCode = runtimeProbe.exitCode;
	const exitCode =
		typeof rawExitCode === "number"
			? rawExitCode
			: typeof rawExitCode === "string"
				? Number.parseInt(rawExitCode, 10)
				: 0;
	if (exitCode === 0 || !Number.isFinite(exitCode)) return null;
	const stderr =
		typeof runtimeProbe.stderr === "string" ? runtimeProbe.stderr.trim() : "";
	const stdout =
		typeof runtimeProbe.stdout === "string" ? runtimeProbe.stdout.trim() : "";
	const detail = (stderr || stdout || "runtime probe failed").slice(0, 600);
	return `Code-eval runtime validation failed before grading (exit ${exitCode}): ${detail}`;
}

function normalizeGraders(graders: unknown[] | undefined): GraderDefinition[] {
	const source =
		Array.isArray(graders) && graders.length > 0
			? graders
			: [
					{
						name: "Expected output match",
						type: "string_check" satisfies EvaluationGraderType,
						config: { operation: "equals" },
					},
				];
	return source.map((grader, index) => validateGraderDefinition(grader, index));
}

function normalizeDatasetRow(value: unknown): DatasetRowInput {
	const raw = isRecord(value) ? value : { input: { value } };
	const input = isRecord(raw.input) ? raw.input : stripKnownDatasetFields(raw);
	const externalId =
		readString(raw.externalId) ??
		readString(raw.external_id) ??
		readString(raw.id) ??
		readString(raw.instance_id);
	return {
		externalId,
		input,
		expectedOutput:
			raw.expectedOutput ??
			raw.expected_output ??
			raw.referenceOutput ??
			raw.reference_output ??
			raw.expected ??
			raw.answer ??
			raw.output,
		generatedOutput: raw.generatedOutput ?? raw.generated_output ?? raw.prediction,
		annotations: isRecord(raw.annotations) ? raw.annotations : {},
		rating: typeof raw.rating === "number" ? Math.trunc(raw.rating) : null,
		feedback: readString(raw.feedback),
		metadata: isRecord(raw.metadata) ? raw.metadata : {},
		originRunInstanceId:
			readString(raw.originRunInstanceId) ?? readString(raw.origin_run_instance_id),
		originSessionId: readString(raw.originSessionId) ?? readString(raw.origin_session_id),
	};
}

export function parseDatasetImport(
	content: string,
	format: "jsonl" | "json" | "csv",
): unknown[] {
	if (format === "jsonl") {
		return content
			.split(/\r?\n/g)
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line, index) => parseJson(line, `JSONL line ${index + 1}`));
	}
	if (format === "json") {
		const parsed = parseJson(content, "JSON");
		return Array.isArray(parsed) ? parsed : [parsed];
	}
	return parseCsv(content);
}

function parseCsv(content: string): Array<Record<string, unknown>> {
	const rows = parseCsvRows(content);
	if (rows.length === 0) return [];
	const headers = rows[0].map((header) => header.trim()).filter(Boolean);
	return rows.slice(1).map((row) => {
		const out: Record<string, unknown> = {};
		for (let i = 0; i < headers.length; i += 1) out[headers[i]] = row[i] ?? "";
		return out;
	});
}

function parseCsvRows(content: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < content.length; i += 1) {
		const char = content[i];
		const next = content[i + 1];
		if (quoted) {
			if (char === '"' && next === '"') {
				field += '"';
				i += 1;
			} else if (char === '"') {
				quoted = false;
			} else {
				field += char;
			}
			continue;
		}
		if (char === '"') quoted = true;
		else if (char === ",") {
			row.push(field);
			field = "";
		} else if (char === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else if (char !== "\r") {
			field += char;
		}
	}
	if (field || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((items) => items.some((item) => item.trim()));
}

function normalizeImportedOutputs(value: unknown): Map<string, unknown> {
	const out = new Map<string, unknown>();
	if (!value) return out;
	if (Array.isArray(value)) {
		for (const item of value) {
			if (!isRecord(item)) continue;
			const key =
				readString(item.rowId) ??
				readString(item.datasetRowId) ??
				readString(item.externalId) ??
				readString(item.external_id) ??
				readString(item.id);
			if (!key) continue;
			out.set(key, item.generatedOutput ?? item.generated_output ?? item.output);
		}
		return out;
	}
	if (isRecord(value)) {
		for (const [key, output] of Object.entries(value)) out.set(key, output);
	}
	return out;
}

export function extractEvaluationGeneratedOutput(value: unknown): unknown {
	if (!isRecord(value)) return value;
	for (const key of [
		"generatedOutput",
		"generated_output",
		"output",
		"text",
		"content",
		"result",
	]) {
		if (value[key] !== undefined && value[key] !== null) {
			const child = value[key];
			if ((key === "output" || key === "result") && isRecord(child)) {
				const nested = extractEvaluationGeneratedOutput(child);
				if (nested !== undefined && nested !== null) return nested;
			}
			return child;
		}
	}
	return value;
}

export function extractSwebenchModelPatch(value: unknown): string {
	if (typeof value === "string") return value.includes("diff --git") ? value : "";
	const candidates = collectStringsByKey(value, [
		"modelPatch",
		"model_patch",
		"patch",
		"stdout",
		"output",
	]);
	return candidates.find((candidate) => candidate.includes("diff --git")) ?? "";
}

function mapExecutionStatus(
	dbStatus: string,
	runtimeStatus: string | null,
): "pending" | "running" | "success" | "error" | "cancelled" {
	switch ((runtimeStatus ?? "").toUpperCase()) {
		case "COMPLETED":
			return "success";
		case "FAILED":
			return "error";
		case "TERMINATED":
		case "CANCELED":
			return "cancelled";
		case "PENDING":
			return "pending";
		case "RUNNING":
		case "SUSPENDED":
			return "running";
	}
	if (
		dbStatus === "pending" ||
		dbStatus === "running" ||
		dbStatus === "success" ||
		dbStatus === "error" ||
		dbStatus === "cancelled"
	) {
		return dbStatus;
	}
	return "running";
}

function isFailedWorkflowExecution(execution: {
	status: string;
	phase: string | null;
	error: string | null;
	output: unknown;
}): boolean {
	if (execution.status === "error" || execution.phase === "failed") return true;
	if (typeof execution.error === "string" && execution.error.trim()) return true;
	const output = execution.output;
	if (isRecord(output) && output.success === false) return true;
	return false;
}

function workflowExecutionError(
	execution: { error: string | null; output: unknown },
	runtimeOutput: unknown,
): string | null {
	if (typeof execution.error === "string" && execution.error.trim()) {
		return execution.error;
	}
	const candidates = collectStringsByKey(runtimeOutput ?? execution.output, [
		"error",
		"stderr",
		"message",
	]);
	return candidates.find((candidate) => candidate.trim())?.slice(0, 2000) ?? null;
}

export function collectEvaluationTraceIds(...values: unknown[]): string[] {
	const traceIds = new Set<string>();
	const visit = (node: unknown) => {
		if (!node) return;
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		if (!isRecord(node)) return;
		for (const [key, child] of Object.entries(node)) {
			if (
				(key === "traceId" || key === "trace_id" || key === "primaryTraceId") &&
				typeof child === "string" &&
				child.trim()
			) {
				traceIds.add(child.trim());
				continue;
			}
			if ((key === "traceIds" || key === "trace_ids") && Array.isArray(child)) {
				for (const traceId of child) {
					if (typeof traceId === "string" && traceId.trim()) traceIds.add(traceId.trim());
				}
				continue;
			}
			if (typeof child === "object" && child !== null) visit(child);
		}
	};
	for (const value of values) visit(value);
	return Array.from(traceIds);
}

function collectStringsByKey(value: unknown, keys: string[]): string[] {
	const wanted = new Set(keys);
	const out: string[] = [];
	const visit = (node: unknown) => {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		for (const [key, child] of Object.entries(node)) {
			if (typeof child === "string" && wanted.has(key)) out.push(child);
			else visit(child);
		}
	};
	visit(value);
	return out;
}

function summarizeRunItems(
	items: Array<typeof evaluationRunItems.$inferSelect>,
): Record<string, unknown> {
	const statusCounts: Record<string, number> = {};
	const perGrader = new Map<
		string,
		{ total: number; passed: number; failed: number; scoreTotal: number; scored: number }
	>();
	let scoreTotal = 0;
	let scored = 0;
	for (const item of items) {
		statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1;
		const score = isRecord(item.scores) ? item.scores.score : null;
		if (typeof score === "number") {
			scoreTotal += score;
			scored += 1;
		}
		if (isRecord(item.graderResults)) {
			for (const [graderId, result] of Object.entries(item.graderResults)) {
				if (!isRecord(result)) continue;
				const current =
					perGrader.get(graderId) ?? {
						total: 0,
						passed: 0,
						failed: 0,
						scoreTotal: 0,
						scored: 0,
					};
				current.total += 1;
				if (result.passed === true) current.passed += 1;
				else current.failed += 1;
				if (typeof result.score === "number") {
					current.scoreTotal += result.score;
					current.scored += 1;
				}
				perGrader.set(graderId, current);
			}
		}
	}
	const total = items.length;
	const passed = statusCounts.passed ?? 0;
	const failed = statusCounts.failed ?? 0;
	const errors = statusCounts.error ?? 0;
	return {
		total,
		...statusCounts,
		passed,
		failed,
		errors,
		passRate: total > 0 ? passed / total : 0,
		scoreMean: scored > 0 ? scoreTotal / scored : null,
		perGrader: Object.fromEntries(
			Array.from(perGrader.entries()).map(([graderId, stats]) => [
				graderId,
				{
					total: stats.total,
					passed: stats.passed,
					failed: stats.failed,
					passRate: stats.total > 0 ? stats.passed / stats.total : 0,
					scoreMean: stats.scored > 0 ? stats.scoreTotal / stats.scored : null,
				},
			]),
		),
	};
}

function resultsToRecord(results: GraderResult[]): Record<string, unknown> {
	return Object.fromEntries(
		results.map((result, index) => [
			result.id ?? `${result.type}_${index}`,
			{
				name: result.name,
				type: result.type,
				score: result.score,
				passed: result.passed,
				skipped: result.skipped === true,
				error: result.error ?? null,
				details: result.details ?? {},
				children: result.children ?? undefined,
			},
		]),
	);
}

async function ensureHiddenEvaluationWorkflow(params: {
	projectId: string;
	userId: string;
}) {
	const database = requireDb();
	const [existing] = await database
		.select()
		.from(workflows)
		.where(
			and(
				eq(workflows.projectId, params.projectId),
				eq(workflows.name, HIDDEN_EVALUATION_WORKFLOW_NAME),
			),
		)
		.limit(1);
	if (existing) return existing;
	const [created] = await database
		.insert(workflows)
		.values({
			name: HIDDEN_EVALUATION_WORKFLOW_NAME,
			description: "Internal generated workflow used by evaluation runs.",
			userId: params.userId,
			projectId: params.projectId,
			nodes: [],
			edges: [],
			spec: null,
			visibility: "private",
			engineType: "dapr",
		})
		.returning();
	return created;
}

export function buildAgentEvaluationWorkflowSpec(params: {
	evaluationName: string;
	agentId: string;
	agentVersion: number | null;
	input: Record<string, unknown>;
	taskConfig: Record<string, unknown>;
}): Record<string, unknown> {
	const prompt = renderPromptTemplate(params.taskConfig, params.input);
	const agentRef: Record<string, unknown> = { id: params.agentId };
	if (params.agentVersion != null) agentRef.version = params.agentVersion;
	return {
		document: {
			dsl: "1.0.0",
			namespace: "workflow-builder.evaluations",
			name: "evaluation-item",
			version: "1.0.0",
			title: params.evaluationName,
			summary: "Run one evaluation row through a published agent.",
		},
		do: [
			{
				evaluate: {
					call: "durable/run",
					with: {
						body: {
							agentRef,
							prompt,
						},
						mode: "execute_direct",
					},
					output: {
						as: {
							generatedOutput:
								"${ .output.output // .output.result // .output.text // .output.content // .output }",
							raw: "${ .output }",
						},
					},
				},
			},
		],
		output: {
			as: {
				generatedOutput: "${ .evaluate.generatedOutput }",
				raw: "${ .evaluate.raw }",
			},
		},
	};
}

export function buildSwebenchEvaluationWorkflowSpec(params: {
	evaluationName: string;
	runId?: string;
	itemId?: string;
	agentId: string;
	agentVersion: number | null;
	input: Record<string, unknown>;
	taskConfig: Record<string, unknown>;
	executionConfig?: Record<string, unknown>;
	inferenceEnvironment?: ResolvedSwebenchInferenceEnvironment | null;
}): Record<string, unknown> {
	const instance = readSwebenchInput(params.input, params.taskConfig);
	const inferenceEnvironment =
		params.inferenceEnvironment ??
		resolveSwebenchInferenceEnvironment({
			suiteSlug: instance.suiteSlug,
			repo: instance.repo,
			baseCommit: instance.baseCommit,
			testMetadata: instance.testMetadata,
		});
	const agentInferenceEnvironment =
		sanitizeSwebenchInferenceEnvironmentForAgent(inferenceEnvironment);
	const timeoutSeconds = clampInteger(
		params.executionConfig?.timeoutSeconds,
		60,
		24 * 60 * 60,
		7200,
	);
	const maxTurns =
		typeof params.executionConfig?.maxTurns === "number"
			? clampInteger(params.executionConfig.maxTurns, 1, 1000, params.executionConfig.maxTurns)
			: null;
	const repoPath = SWEBENCH_EVALUATION_REPO_PATH;
	const workspaceRoot = SWEBENCH_EVALUATION_WORKSPACE_ROOT;
	const timeoutMinutes = Math.max(1, Math.ceil(timeoutSeconds / 60));
	const ttlSeconds = Math.max(timeoutSeconds + 3600, 7200);
	const sandboxTemplate = inferenceEnvironment.sandboxTemplate || "dapr-agent";
	const workspaceRef = buildStableWorkspaceRef("eval-swebench", [
		params.runId ?? params.evaluationName,
		params.itemId,
		instance.instanceId,
	]);
	const workspaceProfileWith: Record<string, unknown> = {
		rootPath: workspaceRoot,
		workspaceRef,
		sandboxTemplate,
		ttlSeconds,
		keepAfterRun: true,
		managedBy: "workflow-builder:evaluations:swebench",
		name: `eval-swebench-${instance.instanceId}`,
		enabledTools: [
			"execute_command",
			"read_file",
			"write_file",
			"edit_file",
			"list_files",
			"mkdir",
			"file_stat",
		],
		sandboxPolicy: {
			keepAfterRun: true,
			mode: "per-run",
			template: sandboxTemplate,
			ttlSeconds,
		},
		commandTimeoutMs: DEFAULT_SWEBENCH_COMMAND_TIMEOUT_MS,
		timeoutMs: DEFAULT_SWEBENCH_COMMAND_TIMEOUT_MS + 300_000,
	};
	if (
		inferenceEnvironment.environmentStatus === "validated" &&
		inferenceEnvironment.sandboxImage
	) {
		workspaceProfileWith.sandboxImage = inferenceEnvironment.sandboxImage;
		workspaceProfileWith.environmentConfig = {
			swebenchInferenceEnvironment: agentInferenceEnvironment,
		};
	}
	const agentRef: Record<string, unknown> = { id: params.agentId };
	if (params.agentVersion != null) agentRef.version = params.agentVersion;
	const cloneCommand = [
		"set -eu",
		"cd /sandbox",
		"rm -rf repo",
		`git clone ${quoteShell(`https://github.com/${instance.repo}.git`)} repo`,
		"cd repo",
		`git checkout ${quoteShell(instance.baseCommit)}`,
		"git status --short",
	].join("\n");
	const extractPatchCommand = [
		"set -eu",
		`cd ${quoteShell(repoPath)}`,
		"rm -rf /sandbox/.cache .cache",
		`git diff --binary ${quoteShell(instance.baseCommit)} --`,
	].join("\n");
	return {
		document: {
			dsl: "1.0.0",
			namespace: "workflow-builder.evaluations",
			name: "swebench-evaluation-item",
			version: "1.0.0",
			title: params.evaluationName,
			summary: "Run one SWE-bench patch-smoke row through a published agent.",
		},
		do: [
			{
				workspace_profile: {
					call: "workspace/profile",
					with: workspaceProfileWith,
				},
			},
			{
				checkout_repo: {
					call: "workspace/command",
					with: {
						workspaceRef: "${ .workspace_profile.workspaceRef }",
						command: cloneCommand,
						timeoutMs: DEFAULT_SWEBENCH_COMMAND_TIMEOUT_MS,
					},
				},
			},
			{
				solve: {
					call: "durable/run",
					with: {
						body: {
							agentRef,
							...(inferenceEnvironment
								? {
										environmentConfig: {
											swebenchInferenceEnvironment: agentInferenceEnvironment,
										},
									}
								: {}),
							overrides: {
								cwd: repoPath,
								maxTurns: maxTurns ?? undefined,
								timeoutMinutes,
								tools: SWEBENCH_ALLOWED_AGENT_TOOLS,
							},
							prompt: buildSwebenchEvaluationPrompt({
								...instance,
								inferenceEnvironment: agentInferenceEnvironment,
							}),
						},
						mode: "execute_direct",
						cwd: repoPath,
						sandboxName: "${ .workspace_profile.sandboxName }",
						workspaceRef: "${ .workspace_profile.workspaceRef }",
						sandboxPolicy: {
							keepAfterRun: true,
							mode: "per-run",
							template: sandboxTemplate,
							ttlSeconds,
						},
					},
				},
			},
			{
				extract_patch: {
					call: "workspace/command",
					with: {
						workspaceRef: "${ .workspace_profile.workspaceRef }",
						command: extractPatchCommand,
						timeoutMs: 120_000,
					},
					output: {
						as: {
							modelPatch:
								"${ .output.result.stdout // .output.stdout // .output.result.output // .output.output // \"\" }",
							raw: "${ .output }",
						},
					},
				},
			},
		],
		output: {
			as: {
				instanceId: instance.instanceId,
				modelPatch: "${ .extract_patch.modelPatch }",
				raw: {
					solve: "${ .solve }",
					extractPatch: "${ .extract_patch.raw }",
				},
				workspaceRef: "${ .workspace_profile.workspaceRef }",
				sandboxName: "${ .workspace_profile.sandboxName }",
				inferenceEnvironment: agentInferenceEnvironment,
			},
		},
	};
}

function sanitizeSwebenchInferenceEnvironmentForAgent(
	environment: ResolvedSwebenchInferenceEnvironment,
): ResolvedSwebenchInferenceEnvironment {
	const environmentNotes = [
		...(environment.environmentNotes ?? []).filter(
			(note) =>
				!/\/testbed/i.test(note) &&
				!/test_patch|FAIL_TO_PASS|PASS_TO_PASS|goldPatch/i.test(note),
		),
	];
	if (environment.buildStrategy === "swebench-harness") {
		for (const note of [
			"The validated image provides the SWE-bench Python environment; the repository is cloned into /sandbox/repo for OpenShell runtime access.",
			"Use python or /sandbox/.venv/bin/python for local checks; avoid conda activation inside the solve phase.",
		]) {
			if (!environmentNotes.includes(note)) environmentNotes.push(note);
		}
	}
	return {
		...environment,
		workspaceRoot: SWEBENCH_EVALUATION_REPO_PATH,
		environmentNotes: environmentNotes.length ? environmentNotes : undefined,
		validationCommand: undefined,
		swebenchSpec: undefined,
	};
}

async function loadEvaluationSubjectWorkflow(params: {
	projectId: string;
	workflowId: string;
}) {
	const database = requireDb();
	// Accept the workflow if it belongs to the caller's project OR has
	// `visibility=public`. Public workflows are intentionally cross-project
	// reusable (the canonical "code-eval-item" workflow seeded for the
	// HumanEval/MBPP/BigCodeBench eval templates is one — every workspace
	// pointing taskConfig.workflowId at it should resolve regardless of
	// which project owns the row in the DB).
	const [workflow] = await database
		.select()
		.from(workflows)
		.where(
			and(
				eq(workflows.id, params.workflowId),
				or(
					eq(workflows.projectId, params.projectId),
					eq(workflows.visibility, "public"),
				),
			),
		)
		.limit(1);
	if (!workflow) throw error(404, "Workflow subject not found");
	return workflow;
}

/**
 * Walk an SW 1.0 spec and replace every `durable/run` task's
 * `with.body.agentRef` with the supplied static `{id, version}` object.
 *
 * Used by the workflow-as-DB code-eval path. The canonical workflow JSON
 * authors `agentRef` as a jq placeholder string so the canvas displays it
 * generically, but `resolveSpecAgentRefs` runs BEFORE jq evaluation and
 * needs a real ref object.
 *
 * Skips tasks that already have a structured agentRef so any future
 * pre-stamped workflow is left alone. Returns a deep-copied spec (does
 * not mutate input).
 */
function stampAgentRefIntoDurableRunSteps(
	spec: Record<string, unknown>,
	agentRef: Record<string, unknown>,
): Record<string, unknown> {
	const cloned = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
	const doList = Array.isArray(cloned.do) ? cloned.do : [];
	for (const step of doList) {
		if (!isRecord(step)) continue;
		for (const taskName of Object.keys(step)) {
			const task = step[taskName];
			if (!isRecord(task)) continue;
			if (task.call !== "durable/run") continue;
			const withBlock = isRecord(task.with) ? (task.with as Record<string, unknown>) : null;
			if (!withBlock) continue;
			const body = isRecord(withBlock.body) ? (withBlock.body as Record<string, unknown>) : null;
			if (!body) continue;
			const existing = body.agentRef;
			if (isRecord(existing) && (typeof existing.id === "string" || typeof existing.slug === "string")) {
				continue;
			}
			body.agentRef = { ...agentRef };
		}
	}
	return cloned;
}

async function prepareEvaluationSubjectWorkflowSpec(
	storedSpec: unknown,
): Promise<Record<string, unknown>> {
	if (!isSWWorkflow(storedSpec)) {
		throw error(
			400,
			"Workflow subject does not have a valid SW 1.0 spec. Save the workflow before evaluating it.",
		);
	}
	const removedAgentCallsError = getRemovedSw10AgentCallsError(storedSpec);
	if (removedAgentCallsError) throw error(400, removedAgentCallsError);
	return resolveEvaluationSpecAgentRefs(storedSpec);
}

async function resolveEvaluationSpecAgentRefs(
	spec: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	try {
		return await resolveSpecAgentRefs(spec);
	} catch (err) {
		if (err instanceof AgentRefResolutionError) {
			throw error(400, err.message);
		}
		throw err;
	}
}

export async function prepareEvaluationWorkflowTriggerData(params: {
	spec: Record<string, unknown>;
	runId: string;
	itemId: string;
	datasetRowId: string | null;
	input: Record<string, unknown>;
	expectedOutput: unknown;
}): Promise<Record<string, unknown>> {
	let triggerData: Record<string, unknown> = {
		...params.input,
		evaluation: {
			runId: params.runId,
			itemId: params.itemId,
			datasetRowId: params.datasetRowId,
			input: params.input,
			expectedOutput: params.expectedOutput,
		},
	};
	triggerData = applyWorkflowInputDefaults(params.spec, triggerData);
	triggerData = await expandGreenfieldPromptInput(params.spec, triggerData);
	const missingTriggerFields = getMissingRequiredTriggerFields(params.spec, triggerData);
	if (missingTriggerFields.length > 0) {
		throw error(
			400,
			`Missing required workflow input fields: ${missingTriggerFields.join(", ")}`,
		);
	}
	const modelError = await validateTriggerModel(params.spec, triggerData);
	if (modelError) throw error(400, modelError);
	return triggerData;
}

function isSWWorkflow(spec: unknown): spec is Record<string, unknown> {
	if (!isRecord(spec)) return false;
	const document = isRecord(spec.document) ? spec.document : null;
	return (
		document?.dsl === "1.0.0" &&
		typeof document.namespace === "string" &&
		typeof document.name === "string"
	);
}

function normalizeSwebenchRowsForEvaluation(params: {
	suiteSlug: SwebenchSuiteSlug;
	rows?: unknown[];
	instanceIds?: unknown;
}): DatasetRowInput[] {
	const suite = SWEBENCH_SUITES.find((candidate) => candidate.slug === params.suiteSlug);
	const rawRows =
		Array.isArray(params.rows) && params.rows.length > 0
			? params.rows
			: normalizeInstanceIds(params.instanceIds).map((instanceId) => ({ instance_id: instanceId }));
	return rawRows.map((row) => {
		const record = isRecord(row) ? row : { instance_id: String(row) };
		const normalized = normalizeSwebenchInstance({
			...record,
			instance_id:
				record.instance_id ??
				record.instanceId ??
				record.externalId ??
				record.id,
			base_commit: record.base_commit ?? record.baseCommit,
			problem_statement: record.problem_statement ?? record.problemStatement,
			hints_text: record.hints_text ?? record.hintsText,
		});
		const input = {
			instanceId: normalized.instanceId,
			suiteSlug: params.suiteSlug,
			datasetName: suite?.datasetName ?? params.suiteSlug,
			repo: normalized.repo ?? repoFromInstanceId(normalized.instanceId),
			baseCommit: normalized.baseCommit,
			problemStatement: normalized.problemStatement,
			hintsText: normalized.hintsText,
			testMetadata: normalized.testMetadata,
		};
		return {
			externalId: normalized.instanceId,
			input,
			expectedOutput: {
				goldPatch: normalized.goldPatch,
				testMetadata: normalized.testMetadata,
			},
			annotations: {},
			metadata: {
				...normalized.metadata,
				family: "swebench",
				suiteSlug: params.suiteSlug,
			},
		};
	});
}

function readSwebenchInput(
	input: Record<string, unknown>,
	taskConfig: Record<string, unknown>,
) {
	const instanceId =
		readString(input.instanceId) ??
		readString(input.instance_id) ??
		readString(input.id);
	if (!instanceId) throw error(400, "SWE-bench row is missing instanceId");
	const repo =
		readString(input.repo) ??
		repoFromInstanceId(instanceId);
	if (!repo) throw error(400, `SWE-bench row ${instanceId} is missing repo`);
	const baseCommit =
		readString(input.baseCommit) ??
		readString(input.base_commit);
	if (!baseCommit) {
		throw error(400, `SWE-bench row ${instanceId} is missing baseCommit`);
	}
	const problemStatement =
		readString(input.problemStatement) ??
		readString(input.problem_statement);
	if (!problemStatement) {
		throw error(400, `SWE-bench row ${instanceId} is missing problemStatement`);
	}
	const testMetadata = {
		...(isRecord(input.testMetadata) ? input.testMetadata : {}),
		...(isRecord(input.test_metadata) ? input.test_metadata : {}),
	};
	for (const key of ["version", "environmentSetupCommit", "environment_setup_commit"]) {
		const value = readString(input[key]);
		if (value) testMetadata[key] = value;
	}
	return {
		instanceId,
		repo,
		baseCommit,
		problemStatement,
		hintsText:
			readString(input.hintsText) ??
			readString(input.hints_text) ??
			readString(input.hints),
		suiteSlug:
			readString(input.suiteSlug) ??
			readString(taskConfig.suiteSlug) ??
			"SWE-bench_Lite",
		datasetName:
			readString(input.datasetName) ??
			readString(taskConfig.datasetName) ??
			"princeton-nlp/SWE-bench_Lite",
		testMetadata,
	};
}

function buildSwebenchEvaluationPrompt(params: {
	instanceId: string;
	repo: string;
	baseCommit: string;
	problemStatement: string;
	hintsText: string | null;
	suiteSlug: string;
	datasetName: string;
	inferenceEnvironment?: ResolvedSwebenchInferenceEnvironment | null;
}): string {
	const environmentNotes = swebenchInferenceEnvironmentPromptNotes(
		params.inferenceEnvironment,
	);
	const workspaceRoot = SWEBENCH_EVALUATION_REPO_PATH;
	return [
		`You are solving SWE-bench instance ${params.instanceId}.`,
		`Dataset: ${params.datasetName}`,
		`Repository: ${params.repo}`,
		`Base commit: ${params.baseCommit}`,
		"",
		"Problem statement:",
		params.problemStatement,
		params.hintsText ? `\nHints:\n${params.hintsText}` : "",
		"",
		"Sandbox notes:",
		`- Work only in ${workspaceRoot}.`,
		"- Do not create commits; leave source changes in the working tree.",
		"- Produce the repository fix as source changes only. Do not edit benchmark metadata or generated artifact files.",
		"- Do not reinstall project dependencies unless the issue explicitly requires it.",
		"- Running local tests is optional and best-effort. This generic eval path only captures the patch; official SWE-bench grading runs from Benchmarks.",
		"- Do not use web search, web fetch, external issue pages, PR pages, or solution commits. Use only the repository contents, the problem statement, and local sandbox commands.",
		...environmentNotes,
		"",
		"Make the smallest source changes needed to resolve the issue. When finished, leave the final patch applied.",
	].join("\n");
}

function quoteShell(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function renderPromptTemplate(
	taskConfig: Record<string, unknown>,
	input: Record<string, unknown>,
): string {
	const template =
		typeof taskConfig.promptTemplate === "string" && taskConfig.promptTemplate.trim()
			? taskConfig.promptTemplate
			: typeof input.prompt === "string" && input.prompt.trim()
				? input.prompt
				: JSON.stringify(input, null, 2);
	return template
		.replaceAll("{{input}}", JSON.stringify(input, null, 2))
		.replace(/\{\{input\.([a-zA-Z0-9_.-]+)\}\}/g, (_match, path: string) =>
			stringifyForPrompt(readPath(input, path)),
		);
}

function readPath(value: Record<string, unknown>, path: string): unknown {
	let current: unknown = value;
	for (const part of path.split(".").filter(Boolean)) {
		if (!isRecord(current)) return undefined;
		current = current[part];
	}
	return current;
}

function stringifyForPrompt(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	return JSON.stringify(value);
}

async function latestRunsByEvaluation(evaluationIds: string[]) {
	const database = requireDb();
	const result = new Map<string, ReturnType<typeof serializeRun>>();
	if (evaluationIds.length === 0) return result;
	const rows = await database
		.select()
		.from(evaluationRuns)
		.where(inArray(evaluationRuns.evaluationId, evaluationIds))
		.orderBy(desc(evaluationRuns.createdAt));
	for (const run of rows) {
		if (!result.has(run.evaluationId)) result.set(run.evaluationId, serializeRun(run));
	}
	return result;
}

async function rowCountsByDataset(datasetIds: string[]) {
	const database = requireDb();
	const result = new Map<string, number>();
	if (datasetIds.length === 0) return result;
	const rows = await database
		.select({
			id: evaluationDatasetRows.datasetId,
		})
		.from(evaluationDatasetRows)
		.where(inArray(evaluationDatasetRows.datasetId, datasetIds));
	for (const row of rows) result.set(row.id, (result.get(row.id) ?? 0) + 1);
	return result;
}

async function countDatasetRows(datasetId: string): Promise<number> {
	const counts = await rowCountsByDataset([datasetId]);
	return counts.get(datasetId) ?? 0;
}

async function requireDataset(
	database: ReturnType<typeof requireDb>,
	projectId: string,
	datasetId: string,
) {
	const [dataset] = await database
		.select()
		.from(evaluationDatasets)
		.where(
			and(
				eq(evaluationDatasets.projectId, projectId),
				eq(evaluationDatasets.id, datasetId),
			),
		)
		.limit(1);
	if (!dataset) throw error(404, "Evaluation dataset not found");
	return dataset;
}

async function requireRunForProject(projectId: string, runId: string) {
	const database = requireDb();
	const [run] = await database
		.select()
		.from(evaluationRuns)
		.where(and(eq(evaluationRuns.projectId, projectId), eq(evaluationRuns.id, runId)))
		.limit(1);
	if (!run) throw error(404, "Evaluation run not found");
	return run;
}

function serializeDataset(
	dataset: typeof evaluationDatasets.$inferSelect,
	rowCount: number,
) {
	return {
		id: dataset.id,
		name: dataset.name,
		description: dataset.description,
		sourceType: dataset.sourceType,
		sourceUrl: dataset.sourceUrl,
		schema: dataset.schema,
		metadata: dataset.metadata,
		rowCount,
		createdAt: dataset.createdAt.toISOString(),
		updatedAt: dataset.updatedAt.toISOString(),
	};
}

function serializeDatasetRow(row: typeof evaluationDatasetRows.$inferSelect) {
	return {
		id: row.id,
		datasetId: row.datasetId,
		externalId: row.externalId,
		input: row.input,
		expectedOutput: row.expectedOutput,
		generatedOutput: row.generatedOutput,
		annotations: row.annotations,
		rating: row.rating,
		feedback: row.feedback,
		metadata: row.metadata,
		originRunInstanceId: row.originRunInstanceId,
		originSessionId: row.originSessionId,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function serializeEvaluation(
	evaluation: typeof evaluations.$inferSelect,
	extra: { datasetName?: string | null; latestRun?: ReturnType<typeof serializeRun> | null } = {},
) {
	return {
		id: evaluation.id,
		name: evaluation.name,
		description: evaluation.description,
		datasetId: evaluation.datasetId,
		datasetName: extra.datasetName ?? null,
		taskConfig: evaluation.taskConfig,
		dataSourceConfig: evaluation.dataSourceConfig,
		testingCriteria: evaluation.testingCriteria,
		metadata: evaluation.metadata,
		latestRun: extra.latestRun ?? null,
		createdAt: evaluation.createdAt.toISOString(),
		updatedAt: evaluation.updatedAt.toISOString(),
	};
}

function serializeGrader(grader: typeof evaluationGraders.$inferSelect) {
	return {
		id: grader.id,
		evaluationId: grader.evaluationId,
		name: grader.name,
		type: grader.type,
		config: grader.config,
		weight: grader.weight,
		passThreshold: grader.passThreshold,
		orderIndex: grader.orderIndex,
		enabled: grader.enabled,
		createdAt: grader.createdAt.toISOString(),
		updatedAt: grader.updatedAt.toISOString(),
	};
}

function serializeRun(
	run: typeof evaluationRuns.$inferSelect,
	extra: { evaluationName?: string | null; datasetName?: string | null } = {},
) {
	return {
		id: run.id,
		evaluationId: run.evaluationId,
		evaluationName: extra.evaluationName ?? null,
		datasetId: run.datasetId,
		datasetName: extra.datasetName ?? null,
		status: run.status,
		subjectType: run.subjectType,
		subjectId: run.subjectId,
		subjectVersion: run.subjectVersion,
		executionConfig: run.executionConfig,
		coordinatorExecutionId: run.coordinatorExecutionId,
		summary: run.summary,
		usage: run.usage,
		error: run.error,
		cancelRequestedAt: run.cancelRequestedAt?.toISOString() ?? null,
		startedAt: run.startedAt?.toISOString() ?? null,
		completedAt: run.completedAt?.toISOString() ?? null,
		createdAt: run.createdAt.toISOString(),
		updatedAt: run.updatedAt.toISOString(),
	};
}

function serializeRunItem(item: typeof evaluationRunItems.$inferSelect) {
	return {
		id: item.id,
		runId: item.runId,
		datasetRowId: item.datasetRowId,
		rowIndex: item.rowIndex,
		status: item.status,
		input: item.input,
		expectedOutput: item.expectedOutput,
		generatedOutput: item.generatedOutput,
		graderResults: item.graderResults,
		scores: item.scores,
		usage: item.usage,
		traceIds: item.traceIds,
		sessionId: item.sessionId,
		workflowExecutionId: item.workflowExecutionId,
		daprInstanceId: item.daprInstanceId,
		error: item.error,
		startedAt: item.startedAt?.toISOString() ?? null,
		completedAt: item.completedAt?.toISOString() ?? null,
		createdAt: item.createdAt.toISOString(),
		updatedAt: item.updatedAt.toISOString(),
	};
}

function serializeRunItemSummary(item: typeof evaluationRunItems.$inferSelect) {
	return {
		...serializeRunItem(item),
		input: compactRunItemInput(item.input),
		expectedOutput: compactRunItemExpectedOutput(item.expectedOutput),
		generatedOutput: compactRunItemGeneratedOutput(item.generatedOutput),
		compact: true,
	};
}

function compactRunItemInput(value: unknown) {
	if (!isRecord(value)) return compactPrimitive(value);
	const prompt = readString(value.prompt);
	const solvePrompt = readString(value.solvePrompt);
	const runtimeProbeCommand = readString(value.runtimeProbeCommand);
	return dropUndefined({
		taskId: readString(value.taskId) ?? readString(value.instanceId) ?? readString(value.id),
		suite: readString(value.suite),
		entryPoint: readString(value.entryPoint),
		libs: Array.isArray(value.libs) ? value.libs : undefined,
		prompt: prompt ? compactString(prompt, 220) : undefined,
		omitted: dropUndefined({
			promptBytes: prompt ? byteLength(prompt) : undefined,
			solvePromptBytes: solvePrompt ? byteLength(solvePrompt) : undefined,
			runtimeProbeCommandBytes: runtimeProbeCommand
				? byteLength(runtimeProbeCommand)
				: undefined,
		}),
	});
}

function compactRunItemExpectedOutput(value: unknown) {
	if (!isRecord(value)) return compactPrimitive(value);
	const testFileContent = readString(value.testFileContent);
	const canonicalSolution = readString(value.canonicalSolution);
	return dropUndefined({
		testHarness: readString(value.testHarness),
		testHarnessVersion:
			typeof value.testHarnessVersion === "number" ? value.testHarnessVersion : undefined,
		testFileSha256: readString(value.testFileSha256),
		canonicalSolution: canonicalSolution
			? compactString(canonicalSolution, 220)
			: undefined,
		omitted: dropUndefined({
			testFileContentBytes: testFileContent ? byteLength(testFileContent) : undefined,
			canonicalSolutionBytes: canonicalSolution
				? byteLength(canonicalSolution)
				: undefined,
		}),
	});
}

function compactRunItemGeneratedOutput(value: unknown) {
	if (!isRecord(value)) return compactPrimitive(value);
	const workflowOutput = isRecord(value.workflowOutput) ? value.workflowOutput : {};
	const pytestOutput = readString(workflowOutput.pytestOutput);
	const stdout = readString(workflowOutput.stdout);
	const stderr = readString(workflowOutput.stderr);
	const solutionContent = readString(workflowOutput.solutionContent);
	return dropUndefined({
		success: typeof value.success === "boolean" ? value.success : undefined,
		phase: readString(value.phase),
		durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined,
		error: readString(value.error),
		workflowOutput: dropUndefined({
			taskId: readString(workflowOutput.taskId),
			passed: typeof workflowOutput.passed === "boolean" ? workflowOutput.passed : undefined,
			exitCode:
				typeof workflowOutput.exitCode === "number" ||
				typeof workflowOutput.exitCode === "string"
					? workflowOutput.exitCode
					: undefined,
			protocol: isRecord(workflowOutput.protocol) ? workflowOutput.protocol : undefined,
			sandboxName: readString(workflowOutput.sandboxName),
			solutionPath: readString(workflowOutput.solutionPath),
			solutionSha256: readString(workflowOutput.solutionSha256),
			testFileSha256: readString(workflowOutput.testFileSha256),
			runtimeProbe: isRecord(workflowOutput.runtimeProbe)
				? compactCommandOutput(workflowOutput.runtimeProbe)
				: undefined,
			pytestOutput: pytestOutput ? tailString(pytestOutput, 1800) : undefined,
			stdout: stdout && stdout !== pytestOutput ? tailString(stdout, 1200) : undefined,
			stderr: stderr ? tailString(stderr, 1200) : undefined,
			solutionContent: solutionContent
				? compactString(solutionContent, 800)
				: undefined,
			omitted: dropUndefined({
				raw: isRecord(workflowOutput.raw) ? "workflow step outputs" : undefined,
				pytestOutputBytes: pytestOutput ? byteLength(pytestOutput) : undefined,
				stdoutBytes: stdout ? byteLength(stdout) : undefined,
				stderrBytes: stderr ? byteLength(stderr) : undefined,
				solutionContentBytes: solutionContent
					? byteLength(solutionContent)
					: undefined,
			}),
		}),
	});
}

function compactCommandOutput(value: Record<string, unknown>) {
	return dropUndefined({
		exitCode:
			typeof value.exitCode === "number" || typeof value.exitCode === "string"
				? value.exitCode
				: undefined,
		stdout: readString(value.stdout) ? tailString(readString(value.stdout) ?? "", 1000) : undefined,
		stderr: readString(value.stderr) ? tailString(readString(value.stderr) ?? "", 1000) : undefined,
	});
}

function compactPrimitive(value: unknown) {
	return typeof value === "string" ? compactString(value, 500) : value;
}

function compactString(value: string, max: number) {
	return value.length > max
		? {
				preview: value.slice(0, max),
				bytes: byteLength(value),
				truncated: true,
			}
		: value;
}

function tailString(value: string, max: number) {
	return value.length > max ? `...${value.slice(-max)}` : value;
}

function byteLength(value: string) {
	return Buffer.byteLength(value, "utf8");
}

function dropUndefined<T extends Record<string, unknown>>(value: T) {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	) as Partial<T>;
}

function serializeArtifact(artifact: typeof evaluationArtifacts.$inferSelect) {
	return {
		id: artifact.id,
		runId: artifact.runId,
		runItemId: artifact.runItemId,
		kind: artifact.kind,
		path: artifact.path,
		content: artifact.content,
		contentType: artifact.contentType,
		sizeBytes: artifact.sizeBytes,
		sha256: artifact.sha256,
		metadata: artifact.metadata,
		createdAt: artifact.createdAt.toISOString(),
	};
}

function stripKnownDatasetFields(raw: Record<string, unknown>): Record<string, unknown> {
	const out = { ...raw };
	for (const key of [
		"id",
		"externalId",
		"external_id",
		"expectedOutput",
		"expected_output",
		"referenceOutput",
		"reference_output",
		"expected",
		"answer",
		"output",
		"generatedOutput",
		"generated_output",
		"prediction",
		"annotations",
		"rating",
		"feedback",
		"metadata",
	]) {
		delete out[key];
	}
	return out;
}

function parseJson(content: string, label: string): unknown {
	try {
		return JSON.parse(content);
	} catch (err) {
		throw error(400, `${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseOptionalInteger(value: string | null): number | null {
	if (!value) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

function clampInteger(
	value: unknown,
	min: number,
	max: number,
	fallback: number,
): number {
	const parsed =
		typeof value === "number" ? value : Number.parseInt(String(value), 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
