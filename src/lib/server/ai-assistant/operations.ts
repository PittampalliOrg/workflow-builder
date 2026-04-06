/**
 * AI assistant operation types and utilities.
 * These types define the structured operations the LLM can produce
 * to modify workflows on the canvas.
 */

export type AiOperation =
	| AiAddNodeOp
	| AiUpdateNodeOp
	| AiRemoveNodeOp
	| AiAddEdgeOp
	| AiRemoveEdgeOp
	| AiSetWorkflowNameOp;

export interface AiAddNodeOp {
	op: 'add_node';
	type: string;
	label: string;
	after?: string;
	position?: { x: number; y: number };
	taskConfig?: Record<string, unknown>;
}

export interface AiUpdateNodeOp {
	op: 'update_node';
	nodeId: string;
	label?: string;
	taskConfig?: Record<string, unknown>;
	description?: string;
}

export interface AiRemoveNodeOp {
	op: 'remove_node';
	nodeId: string;
}

export interface AiAddEdgeOp {
	op: 'add_edge';
	source: string;
	target: string;
	sourceHandle?: string;
}

export interface AiRemoveEdgeOp {
	op: 'remove_edge';
	edgeId?: string;
	source?: string;
	target?: string;
}

export interface AiSetWorkflowNameOp {
	op: 'set_workflow_name';
	name: string;
}

const VALID_OPS = new Set(['add_node', 'update_node', 'remove_node', 'add_edge', 'remove_edge', 'set_workflow_name']);

/**
 * Validate that an object looks like a valid operation.
 */
export function isValidOperation(obj: unknown): obj is AiOperation {
	if (typeof obj !== 'object' || obj === null) return false;
	const o = obj as Record<string, unknown>;
	if (typeof o.op !== 'string' || !VALID_OPS.has(o.op)) return false;

	switch (o.op) {
		case 'add_node':
			return typeof o.type === 'string' && typeof o.label === 'string';
		case 'update_node':
			return typeof o.nodeId === 'string';
		case 'remove_node':
			return typeof o.nodeId === 'string';
		case 'add_edge':
			return typeof o.source === 'string' && typeof o.target === 'string';
		case 'remove_edge':
			return typeof o.edgeId === 'string' || (typeof o.source === 'string' && typeof o.target === 'string');
		case 'set_workflow_name':
			return typeof o.name === 'string';
		default:
			return false;
	}
}

/**
 * Extract operations from LLM response text.
 * Looks for ```operations ... ``` fenced blocks.
 */
export function extractOperations(text: string): AiOperation[] {
	const pattern = /```operations\s*\n?([\s\S]*?)```/g;
	const operations: AiOperation[] = [];

	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		try {
			const parsed = JSON.parse(match[1].trim());
			const arr = Array.isArray(parsed) ? parsed : [parsed];
			for (const item of arr) {
				if (isValidOperation(item)) {
					operations.push(item);
				}
			}
		} catch {
			// Skip malformed JSON blocks
		}
	}

	return operations;
}

/**
 * Strip operations blocks from text to get just the conversational content.
 */
export function stripOperationsBlocks(text: string): string {
	return text.replace(/```operations\s*\n?[\s\S]*?```/g, '').trim();
}
