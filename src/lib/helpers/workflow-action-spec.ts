import type { ActionCatalogDetail, ActionCatalogItem } from '$lib/stores/action-catalog.svelte';
import {
	createEmptySpec,
	generateTaskName,
	getTaskNames,
	insertTaskAfter,
	updateTask,
	type TaskDef,
	type Spec,
} from '$lib/helpers/spec-mutations';

type CatalogDetailLike = Partial<ActionCatalogDetail> & {
	sw?: {
		taskConfig?: Record<string, unknown> | null;
		definition?: Record<string, unknown> | null;
	} | null;
	codeFunction?: Record<string, unknown> | null;
	sourceKind?: string | null;
	definition?: Record<string, unknown> | null;
	taskConfig?: Record<string, unknown> | null;
};

export interface ActionTaskProjection {
	taskName: string;
	taskDef: TaskDef;
	spec: Spec;
	metadata: Record<string, unknown>;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function ensureWorkflowSpec(current: Spec | null, workflowName: string): Spec {
	return current ?? createEmptySpec(
		workflowName
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '') || 'untitled',
		workflowName,
	);
}

export function getTaskNameFromNodeId(nodeId: string | null | undefined): string | null {
	if (!nodeId || nodeId === '__start__' || nodeId === '__end__') return null;
	if (nodeId.startsWith('/do/')) {
		const parts = nodeId.split('/');
		return parts[parts.length - 1] || null;
	}
	return nodeId;
}

export function getNodeIdForTaskName(
	nodes: Array<{ id: string; data?: Record<string, unknown> }>,
	taskName: string,
): string | null {
	const match = nodes.find((node) => {
		if (node.id === taskName || node.id.endsWith(`/${taskName}`)) return true;
		return node.data?.label === taskName;
	});
	return match?.id ?? null;
}

export function getInsertAfterTaskName(edgeSourceId: string | null | undefined): string | null | undefined {
	if (!edgeSourceId) return undefined;
	if (edgeSourceId === '__start__') return null;
	return getTaskNameFromNodeId(edgeSourceId) ?? undefined;
}

export function selectActionTaskConfig(
	detail: CatalogDetailLike,
): TaskDef | null {
	const sw = asRecord(detail.sw);
	const candidates = [
		asRecord(sw?.taskConfig),
		asRecord(detail.taskConfig),
		asRecord(sw?.definition),
		asRecord(detail.definition),
	];
	const taskConfig = candidates.find((candidate) => candidate !== null);
	return taskConfig ? cloneRecord(taskConfig) : null;
}

export function buildActionMetadata(
	action: ActionCatalogItem,
	detail: CatalogDetailLike,
): Record<string, unknown> {
	const actionDefinition = {
		id: action.id,
		name: action.name,
		displayName: action.displayName,
		service: action.service,
		kind: action.kind,
		visibility: action.visibility,
		sourceKind: action.sourceKind,
		version: action.version,
		language: action.language,
		entrypoint: action.entrypoint,
		insertable: action.visibility === 'public-callable',
	};
	const isCodeFunction = String(detail.sourceKind ?? '') === 'code' || action.pieceName === 'code-functions';
	const codeFunction = asRecord(detail.codeFunction) ?? {};

	return {
		label: action.displayName,
		actionDefinition,
		actionCatalogDetail: detail,
		...(isCodeFunction
			? {
					codeFunction: {
						id: (codeFunction.id as string | undefined) || '',
						name: (codeFunction.name as string | undefined) || action.displayName,
						slug: (codeFunction.slug as string | undefined) || action.name,
						language: (codeFunction.language as string | undefined) || action.language || 'typescript',
						entrypoint: (codeFunction.entrypoint as string | undefined) || action.actionName,
						version: (codeFunction.version as string | undefined) || action.version || '0.1.0',
						path: (codeFunction.path as string | undefined) || null,
					},
					codeFunctionDefinition: detail,
				}
			: {
					catalogFunction: action.service === 'activepieces'
						? {
								name: action.name,
								displayName: action.displayName,
								pieceName: action.providerId || action.pieceName,
								actionName: action.actionName,
							}
						: undefined,
				}),
	};
}

export function insertActionTask(
	spec: Spec | null,
	workflowName: string,
	action: ActionCatalogItem,
	detail: CatalogDetailLike,
	insertAfterTaskName?: string | null,
): ActionTaskProjection {
	const baseSpec = ensureWorkflowSpec(spec, workflowName);
	const taskDef = selectActionTaskConfig(detail);
	if (!taskDef) {
		throw new Error(`Action ${action.displayName} does not provide an executable SW task projection`);
	}

	const taskName = generateTaskName(action.displayName, getTaskNames(baseSpec));
	return {
		taskName,
		taskDef,
		spec: insertTaskAfter(baseSpec, taskName, taskDef, insertAfterTaskName),
		metadata: buildActionMetadata(action, detail),
	};
}

export function replaceActionTask(
	spec: Spec | null,
	workflowName: string,
	taskName: string,
	action: ActionCatalogItem,
	detail: CatalogDetailLike,
): ActionTaskProjection {
	const baseSpec = ensureWorkflowSpec(spec, workflowName);
	const taskDef = selectActionTaskConfig(detail);
	if (!taskDef) {
		throw new Error(`Action ${action.displayName} does not provide an executable SW task projection`);
	}

	return {
		taskName,
		taskDef,
		spec: updateTask(baseSpec, taskName, taskDef),
		metadata: buildActionMetadata(action, detail),
	};
}
