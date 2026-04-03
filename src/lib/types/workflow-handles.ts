import type { WorkflowNodeType } from '$lib/stores/workflow.svelte';

export type HandleDataType = 'control' | 'branch' | 'any';

export interface HandleRule {
	label?: string;
	dataType: HandleDataType;
	accepts?: HandleDataType[];
	maxConnections?: number;
}

export interface PortConfig {
	id: string;
	type: 'source' | 'target';
	position: 'top' | 'bottom' | 'left' | 'right';
	label?: string;
	rule: HandleRule;
}

// Default control-flow handle rule
const CONTROL_TARGET: HandleRule = { dataType: 'control', accepts: ['control', 'branch', 'any'] };
const CONTROL_SOURCE: HandleRule = { dataType: 'control', accepts: ['control', 'any'] };
const BRANCH_SOURCE = (label: string): HandleRule => ({
	label,
	dataType: 'branch',
	accepts: ['control', 'any']
});

export interface NodeHandleConfig {
	targets: HandleRule[];
	sources: HandleRule[];
}

/**
 * Static handle rules for all 14 SW 1.0 node types.
 * Dynamic ports (switch cases, fork branches) are added at runtime.
 */
export const NODE_HANDLE_RULES: Record<WorkflowNodeType, NodeHandleConfig> = {
	start: { targets: [], sources: [CONTROL_SOURCE] },
	end: { targets: [CONTROL_TARGET], sources: [] },
	call: { targets: [CONTROL_TARGET], sources: [CONTROL_SOURCE] },
	set: { targets: [CONTROL_TARGET], sources: [CONTROL_SOURCE] },
	switch: { targets: [CONTROL_TARGET], sources: [] }, // dynamic branch sources added from taskConfig
	wait: { targets: [CONTROL_TARGET], sources: [CONTROL_SOURCE] },
	emit: { targets: [CONTROL_TARGET], sources: [CONTROL_SOURCE] },
	listen: { targets: [CONTROL_TARGET], sources: [CONTROL_SOURCE] },
	for: { targets: [CONTROL_TARGET], sources: [CONTROL_SOURCE] },
	fork: { targets: [CONTROL_TARGET], sources: [] }, // dynamic branch sources added from taskConfig
	try: {
		targets: [CONTROL_TARGET],
		sources: [BRANCH_SOURCE('success'), BRANCH_SOURCE('catch')]
	},
	run: { targets: [CONTROL_TARGET], sources: [CONTROL_SOURCE] },
	raise: { targets: [CONTROL_TARGET], sources: [] },
	do: { targets: [CONTROL_TARGET], sources: [CONTROL_SOURCE] }
};

/**
 * Get the static handle rule config for a node type.
 */
export function getHandleRule(nodeType: WorkflowNodeType): NodeHandleConfig {
	return NODE_HANDLE_RULES[nodeType];
}

/**
 * Check if a source data type can connect to a target data type.
 */
export function areTypesCompatible(
	sourceType: HandleDataType,
	targetType: HandleDataType
): boolean {
	if (sourceType === 'any' || targetType === 'any') return true;
	if (sourceType === 'branch' && targetType === 'control') return true;
	return sourceType === targetType;
}

/**
 * Check if a handle has reached its maximum number of connections.
 */
export function isAtConnectionLimit(
	rule: HandleRule,
	currentConnectionCount: number
): boolean {
	if (rule.maxConnections === undefined) return false;
	return currentConnectionCount >= rule.maxConnections;
}
