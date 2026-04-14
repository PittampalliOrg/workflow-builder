import { z } from 'zod';

import {
	createEmptySpec,
	getTask,
	getTaskNames,
	insertTaskAfter,
	removeTask,
	renameTask,
	reorderTasks,
	updateDocument,
	updateTask,
	type Spec,
	type TaskDef,
} from '$lib/helpers/spec-mutations';
import { validateSpec } from '$lib/utils/spec-validator';

const jsonRecord = z.record(z.string(), z.unknown());

const baseOperationSchema = z.object({
	reason: z.string().optional(),
});

export const workflowSpecOperationSchema = z.discriminatedUnion('op', [
	baseOperationSchema.extend({
		op: z.literal('create_workflow'),
		spec: jsonRecord,
	}),
	baseOperationSchema.extend({
		op: z.literal('add_task'),
		taskName: z.string().min(1),
		task: jsonRecord,
		afterTaskName: z.string().nullable().optional(),
	}),
	baseOperationSchema.extend({
		op: z.literal('update_task'),
		taskName: z.string().min(1),
		task: jsonRecord.optional(),
		patch: jsonRecord.optional(),
	}),
	baseOperationSchema.extend({
		op: z.literal('remove_task'),
		taskName: z.string().min(1),
	}),
	baseOperationSchema.extend({
		op: z.literal('rename_task'),
		taskName: z.string().min(1),
		newTaskName: z.string().min(1),
	}),
	baseOperationSchema.extend({
		op: z.literal('move_task'),
		taskName: z.string().min(1),
		afterTaskName: z.string().nullable().optional(),
	}),
	baseOperationSchema.extend({
		op: z.literal('update_document'),
		fields: jsonRecord,
	}),
	baseOperationSchema.extend({
		op: z.literal('clarify'),
		question: z.string().min(1),
	}),
]);

export const workflowSpecOperationPlanSchema = z.object({
	message: z.string().min(1),
	operations: z.array(workflowSpecOperationSchema).default([]),
});

export type WorkflowSpecOperation = z.infer<typeof workflowSpecOperationSchema>;
export type WorkflowSpecOperationPlan = z.infer<typeof workflowSpecOperationPlanSchema>;

export interface WorkflowSpecOperationResult {
	message: string;
	operations: WorkflowSpecOperation[];
	proposedSpec: Spec | null;
	validation: { valid: boolean; errors: string[] };
	changedTaskNames: string[];
	applied: boolean;
	needsClarification: boolean;
}

function normalizeSpec(spec: Spec): Spec {
	const cloned = JSON.parse(JSON.stringify(spec)) as Spec;
	const doc = cloned.document as Record<string, unknown> | undefined;
	if (doc && Array.isArray(doc.do) && !Array.isArray(cloned.do)) {
		cloned.do = doc.do;
		cloned.document = { ...doc };
		delete (cloned.document as Record<string, unknown>).do;
	}
	return cloned;
}

function cloneSpec(spec: Spec): Spec {
	return normalizeSpec(spec);
}

function deepMergeRecord(base: TaskDef, patch: TaskDef): TaskDef {
	const next: TaskDef = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		const current = next[key];
		if (
			value &&
			typeof value === 'object' &&
			!Array.isArray(value) &&
			current &&
			typeof current === 'object' &&
			!Array.isArray(current)
		) {
			next[key] = deepMergeRecord(current as TaskDef, value as TaskDef);
		} else {
			next[key] = value;
		}
	}
	return next;
}

function ensureSpec(spec: Spec | null, workflowName: string): Spec {
	if (spec) return cloneSpec(spec);
	const name = workflowName
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '') || 'untitled';
	return createEmptySpec(name, workflowName);
}

function specsEqual(a: Spec | null, b: Spec | null): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function moveTask(spec: Spec, taskName: string, afterTaskName?: string | null): Spec {
	const names = getTaskNames(spec);
	if (!names.includes(taskName)) {
		throw new Error(`Task "${taskName}" does not exist`);
	}
	if (afterTaskName && !names.includes(afterTaskName)) {
		throw new Error(`Task "${afterTaskName}" does not exist`);
	}
	const withoutMoved = names.filter((name) => name !== taskName);
	const insertIndex = afterTaskName == null ? 0 : withoutMoved.indexOf(afterTaskName) + 1;
	const nextNames = [...withoutMoved];
	nextNames.splice(insertIndex, 0, taskName);
	return reorderTasks(spec, nextNames);
}

function blockedResult(params: {
	message: string;
	spec: Spec | null;
	operations: WorkflowSpecOperation[];
	changedTaskNames: Iterable<string>;
}): WorkflowSpecOperationResult {
	return {
		message: params.message,
		operations: params.operations,
		proposedSpec: params.spec ? cloneSpec(params.spec) : null,
		validation: { valid: false, errors: [params.message] },
		changedTaskNames: Array.from(params.changedTaskNames),
		applied: false,
		needsClarification: false,
	};
}

export function applyWorkflowSpecOperations(params: {
	workflowName: string;
	spec: Spec | null;
	operations: WorkflowSpecOperation[];
}): WorkflowSpecOperationResult {
	const changedTaskNames = new Set<string>();
	const clarification = params.operations.find((operation) => operation.op === 'clarify');
	const originalTaskNames = params.spec ? getTaskNames(params.spec) : [];
	const createWorkflow = params.operations.some((operation) => operation.op === 'create_workflow');

	if (clarification?.op === 'clarify') {
		return {
			message: clarification.question,
			operations: params.operations,
			proposedSpec: params.spec ? cloneSpec(params.spec) : null,
			validation: { valid: false, errors: ['Assistant needs clarification before changing the workflow.'] },
			changedTaskNames: [],
			applied: false,
			needsClarification: true,
		};
	}

	let nextSpec = ensureSpec(params.spec, params.workflowName);

	try {
		for (const operation of params.operations) {
			switch (operation.op) {
				case 'create_workflow':
					if (originalTaskNames.length > 0) {
						throw new Error('Refusing to replace a non-empty workflow from chat. Use focused task operations instead.');
					}
					nextSpec = cloneSpec(operation.spec);
					for (const name of getTaskNames(nextSpec)) changedTaskNames.add(name);
					break;
				case 'add_task': {
					if (getTask(nextSpec, operation.taskName)) {
						throw new Error(`Task "${operation.taskName}" already exists`);
					}
					nextSpec = insertTaskAfter(nextSpec, operation.taskName, operation.task, operation.afterTaskName);
					changedTaskNames.add(operation.taskName);
					break;
				}
				case 'update_task': {
					const current = getTask(nextSpec, operation.taskName);
					if (!current) {
						throw new Error(`Task "${operation.taskName}" does not exist`);
					}
					const task = operation.task ?? deepMergeRecord(current, operation.patch ?? {});
					nextSpec = updateTask(nextSpec, operation.taskName, task);
					changedTaskNames.add(operation.taskName);
					break;
				}
				case 'remove_task':
					if (!getTask(nextSpec, operation.taskName)) {
						throw new Error(`Task "${operation.taskName}" does not exist`);
					}
					nextSpec = removeTask(nextSpec, operation.taskName);
					changedTaskNames.add(operation.taskName);
					break;
				case 'rename_task':
					if (!getTask(nextSpec, operation.taskName)) {
						throw new Error(`Task "${operation.taskName}" does not exist`);
					}
					if (getTask(nextSpec, operation.newTaskName)) {
						throw new Error(`Task "${operation.newTaskName}" already exists`);
					}
					nextSpec = renameTask(nextSpec, operation.taskName, operation.newTaskName);
					changedTaskNames.add(operation.taskName);
					changedTaskNames.add(operation.newTaskName);
					break;
				case 'move_task':
					nextSpec = moveTask(nextSpec, operation.taskName, operation.afterTaskName);
					changedTaskNames.add(operation.taskName);
					break;
				case 'update_document':
					nextSpec = updateDocument(nextSpec, operation.fields);
					break;
				case 'clarify':
					break;
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return blockedResult({ message, operations: params.operations, spec: params.spec, changedTaskNames });
	}

	const nextTaskNames = getTaskNames(nextSpec);
	const explicitlyRemoved = new Set(
		params.operations
			.filter((operation) => operation.op === 'remove_task')
			.map((operation) => operation.taskName),
	);
	const renamedFrom = new Set(
		params.operations
			.filter((operation) => operation.op === 'rename_task')
			.map((operation) => operation.taskName),
	);
	const unexpectedlyDropped = originalTaskNames.filter((name) =>
		!nextTaskNames.includes(name) && !explicitlyRemoved.has(name) && !renamedFrom.has(name),
	);

	if (nextTaskNames.length === 0 && params.operations.length > 0) {
		return blockedResult({
			message: 'Refusing to apply AI changes because the proposed workflow has no tasks.',
			operations: params.operations,
			spec: params.spec,
			changedTaskNames,
		});
	}

	if (unexpectedlyDropped.length > 0 || (originalTaskNames.length > 0 && nextTaskNames.length === 0 && !createWorkflow)) {
		return blockedResult({
			message: `Refusing to apply AI changes because they would remove existing task(s): ${unexpectedlyDropped.join(', ') || originalTaskNames.join(', ')}.`,
			operations: params.operations,
			spec: params.spec,
			changedTaskNames,
		});
	}

	const validation = validateSpec(nextSpec);
	if (validation.valid && params.operations.length > 0 && specsEqual(params.spec ? cloneSpec(params.spec) : null, nextSpec)) {
		return blockedResult({
			message: 'The assistant produced valid operations, but they did not change the workflow spec.',
			operations: params.operations,
			spec: params.spec,
			changedTaskNames,
		});
	}

	return {
		message: validation.valid ? 'Workflow updated.' : 'I could not safely apply that change.',
		operations: params.operations,
		proposedSpec: validation.valid ? nextSpec : params.spec ? cloneSpec(params.spec) : null,
		validation,
		changedTaskNames: Array.from(changedTaskNames),
		applied: validation.valid && params.operations.length > 0,
		needsClarification: false,
	};
}

export function parseWorkflowSpecOperationPlan(value: unknown): WorkflowSpecOperationPlan {
	return workflowSpecOperationPlanSchema.parse(value);
}
