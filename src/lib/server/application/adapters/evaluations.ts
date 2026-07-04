import {
	createCodeEvalTemplate,
	createEvaluationDataset,
	createEvaluationDatasetRows,
	createEvaluationDefinition,
	createSwebenchEvaluationTemplate,
	deleteEvaluationDatasetRow,
	getEvaluationDataset,
	getEvaluationDefinition,
	getEvaluationRun,
	getEvaluationRunItem,
	listEvaluations,
	listEvaluationDatasets,
	parseDatasetImport,
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
	EvaluationRunItemOutputInput,
	EvaluationRunItemRepository,
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
