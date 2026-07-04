import {
	createCodeEvalTemplate,
	createEvaluationDataset,
	createEvaluationDatasetRows,
	createEvaluationDefinition,
	createSwebenchEvaluationTemplate,
	deleteEvaluationDatasetRow,
	buildEvaluationPredictionsJsonl,
	gradeEvaluationRun,
	getEvaluationDataset,
	getEvaluationDefinition,
	getInternalEvaluationRun,
	getEvaluationRun,
	getEvaluationRunItem,
	listEvaluations,
	listEvaluationDatasets,
	markEvaluationRunItemStatus,
	markEvaluationRunStatus,
	parseDatasetImport,
	recordEvaluationArtifact,
	recordEvaluationRunItemGraderResults,
	recomputeEvaluationRunSummary,
	startEvaluationRunItemWorkflow,
	syncEvaluationRunItemFromExecution,
	updateEvaluationRunItemOutput,
	updateEvaluationDefinition,
	updateEvaluationDataset,
	updateEvaluationDatasetRow,
} from "$lib/server/evaluations/service";
import { SWEBENCH_SUITES } from "$lib/server/benchmarks/swebench";
import type {
	EvaluationDatasetCreateInput,
	EvaluationDatasetRepository,
} from "$lib/server/application/evaluation-datasets";
import type {
	EvaluationDefinitionCreateInput,
	EvaluationDefinitionRepository,
} from "$lib/server/application/evaluation-definitions";
import type {
	EvaluationArtifactKindInput,
	EvaluationRunRepository,
	EvaluationRunStatusInput,
} from "$lib/server/application/evaluation-runs";
import type {
	EvaluationRunItemOutputInput,
	EvaluationRunItemRepository,
	EvaluationRunItemStatusInput,
} from "$lib/server/application/evaluation-run-items";
import type {
	CodeEvaluationSuiteSlug,
	EvaluationDatasetImportFormat,
	EvaluationDatasetImportParser,
	EvaluationTemplateRepository,
	SwebenchSuiteCatalog,
} from "$lib/server/application/evaluation-templates";

export class LegacyEvaluationDatasetRepository
	implements EvaluationDatasetRepository
{
	list(projectId: string): Promise<unknown[]> {
		return listEvaluationDatasets(projectId);
	}

	get(projectId: string, datasetId: string, limit?: number): Promise<unknown> {
		return getEvaluationDataset(projectId, datasetId, limit);
	}

	create(input: EvaluationDatasetCreateInput): Promise<unknown> {
		return createEvaluationDataset(input);
	}

	update(
		projectId: string,
		datasetId: string,
		patch: Record<string, unknown>,
	): Promise<unknown> {
		return updateEvaluationDataset(projectId, datasetId, patch);
	}

	createRows(
		projectId: string,
		datasetId: string,
		rows: unknown[],
	): Promise<unknown[]> {
		return createEvaluationDatasetRows(projectId, datasetId, rows);
	}

	updateRow(input: {
		projectId: string;
		datasetId: string;
		rowId: string;
		patch: Record<string, unknown>;
	}): Promise<unknown> {
		return updateEvaluationDatasetRow(input);
	}

	deleteRow(input: {
		projectId: string;
		datasetId: string;
		rowId: string;
	}): Promise<unknown> {
		return deleteEvaluationDatasetRow(input);
	}
}

export class LegacyEvaluationDefinitionRepository
	implements EvaluationDefinitionRepository
{
	list(projectId: string): Promise<unknown[]> {
		return listEvaluations(projectId);
	}

	get(projectId: string, evaluationId: string): Promise<unknown | null> {
		return getEvaluationDefinition(projectId, evaluationId);
	}

	create(input: EvaluationDefinitionCreateInput): Promise<unknown> {
		return createEvaluationDefinition(input);
	}

	update(input: {
		projectId: string;
		evaluationId: string;
		patch: Record<string, unknown>;
	}): Promise<unknown> {
		return updateEvaluationDefinition(input);
	}
}

export class LegacyEvaluationRunItemRepository
	implements EvaluationRunItemRepository
{
	getRun(projectId: string, runId: string): Promise<unknown | null> {
		return getEvaluationRun(projectId, runId);
	}

	getItem(
		projectId: string,
		runId: string,
		itemId: string,
	): Promise<unknown | null> {
		return getEvaluationRunItem(projectId, runId, itemId);
	}

	updateOutput(input: EvaluationRunItemOutputInput): Promise<unknown | null> {
		return updateEvaluationRunItemOutput(input);
	}

	markStatus(input: {
		runId: string;
		itemId: string;
		status: EvaluationRunItemStatusInput;
		error?: string | null;
	}): Promise<unknown | null> {
		return markEvaluationRunItemStatus(input);
	}

	syncFromExecution(input: {
		runId: string;
		itemId: string;
	}): Promise<unknown | null> {
		return syncEvaluationRunItemFromExecution(input);
	}

	recordGraderResults(input: {
		runId: string;
		itemId: string;
		graderResults: Record<string, unknown>;
		scores?: Record<string, unknown>;
		status?: EvaluationRunItemStatusInput;
		error?: string | null;
	}): Promise<unknown | null> {
		return recordEvaluationRunItemGraderResults(input);
	}

	startWorkflow(input: {
		runId: string;
		itemId: string;
	}): Promise<Record<string, unknown>> {
		return startEvaluationRunItemWorkflow(input);
	}
}

export class LegacyEvaluationRunRepository
	implements EvaluationRunRepository
{
	getInternalRun(
		runId: string,
		options?: { itemMode?: "summary" | "full" },
	): Promise<unknown | null> {
		return getInternalEvaluationRun(runId, options);
	}

	markStatus(
		runId: string,
		status: EvaluationRunStatusInput,
		extra: Record<string, unknown>,
	): Promise<unknown | null> {
		return markEvaluationRunStatus(runId, status, extra);
	}

	recomputeSummary(runId: string): Promise<unknown> {
		return recomputeEvaluationRunSummary(runId);
	}

	recordArtifact(input: {
		runId: string;
		runItemId: string | null;
		kind: EvaluationArtifactKindInput;
		path: string | null;
		content: unknown;
		contentType: string | null;
		metadata?: Record<string, unknown>;
	}): Promise<unknown> {
		return recordEvaluationArtifact(input);
	}

	gradeRun(projectId: string, runId: string): Promise<unknown> {
		return gradeEvaluationRun(projectId, runId);
	}

	buildPredictionsJsonl(projectId: string, runId: string): Promise<string> {
		return buildEvaluationPredictionsJsonl(projectId, runId);
	}
}

export class LegacyEvaluationTemplateRepository
	implements EvaluationTemplateRepository
{
	createSwebench(input: {
		projectId: string;
		userId: string;
		suiteSlug: string;
		name: string | null;
		description: string | null;
		instanceIds: unknown;
		rows?: unknown[];
	}): Promise<unknown> {
		return createSwebenchEvaluationTemplate(input);
	}

	createCodeEval(input: {
		projectId: string;
		userId: string;
		suiteSlug: CodeEvaluationSuiteSlug;
		name: string | null;
		description: string | null;
		graderAgentSlug: string | null;
		rows?: unknown[];
	}): Promise<unknown> {
		return createCodeEvalTemplate(input);
	}
}

export class LegacyEvaluationDatasetImportParser
	implements EvaluationDatasetImportParser
{
	parse(content: string, format: EvaluationDatasetImportFormat): unknown[] {
		return parseDatasetImport(content, format);
	}
}

export class StaticSwebenchSuiteCatalog implements SwebenchSuiteCatalog {
	listSuites(): unknown[] {
		return SWEBENCH_SUITES;
	}
}
