import type { Edge, Node } from '@xyflow/svelte';
import type { ExecutionReadModel } from '$lib/types/execution-stream';

export type ExecutionCanvasStatus = 'idle' | 'running' | 'success' | 'error';

export interface ExecutionCanvasState {
	activeNodeId: string | null;
	activeNodeLabel: string | null;
	nodeStatuses: Record<string, ExecutionCanvasStatus>;
	edgeStatuses: Record<string, ExecutionCanvasStatus>;
	isTerminal: boolean;
}

function normalizeStatus(status: string | null | undefined): ExecutionCanvasStatus {
	switch ((status ?? '').toLowerCase()) {
		case 'running':
		case 'pending':
			return 'running';
		case 'success':
		case 'completed':
			return 'success';
		case 'error':
		case 'failed':
		case 'cancelled':
			return 'error';
		default:
			return 'idle';
	}
}

export function resolveExecutionNodeId(
	rawNodeId: string | null | undefined,
	nodes: Node[]
): string | null {
	const candidate = rawNodeId?.trim();
	if (!candidate) return null;

	const exact = nodes.find((node) => node.id === candidate);
	if (exact) return exact.id;

	const slashPrefixed = nodes.find((node) => node.id === `/${candidate}`);
	if (slashPrefixed) return slashPrefixed.id;

	const byLabel = nodes.find((node) => {
		const data = (node.data ?? {}) as Record<string, unknown>;
		return (
			(typeof data.label === 'string' && data.label.trim() === candidate) ||
			(typeof data.stepName === 'string' && data.stepName.trim() === candidate) ||
			(typeof data.name === 'string' && data.name.trim() === candidate)
		);
	});
	if (byLabel) return byLabel.id;

	if (candidate === 'trigger' || candidate === '__start__') {
		return nodes.find((node) => node.type === 'start' || node.id === '__start__')?.id ?? null;
	}

	if (candidate === '__end__') {
		return nodes.find((node) => node.type === 'end' || node.id === '__end__')?.id ?? null;
	}

	return null;
}

export function buildExecutionCanvasState(
	snapshot: ExecutionReadModel | null,
	nodes: Node[],
	edges: Edge[]
): ExecutionCanvasState {
	const nodeStatuses = Object.fromEntries(
		nodes.map((node) => [node.id, 'idle' as ExecutionCanvasStatus])
	);
	const edgeStatuses = Object.fromEntries(
		edges.map((edge) => [edge.id, 'idle' as ExecutionCanvasStatus])
	);

	if (!snapshot) {
		return {
			activeNodeId: null,
			activeNodeLabel: null,
			nodeStatuses,
			edgeStatuses,
			isTerminal: false
		};
	}

	for (const [rawNodeId, rawStatus] of Object.entries(snapshot.nodeStatuses ?? {})) {
		const resolvedNodeId = resolveExecutionNodeId(rawNodeId, nodes);
		if (!resolvedNodeId) continue;
		nodeStatuses[resolvedNodeId] = normalizeStatus(rawStatus);
	}

	const activeNodeId =
		resolveExecutionNodeId(snapshot.currentNodeId, nodes) ??
		resolveExecutionNodeId(snapshot.currentNodeName, nodes);
	const activeNodeLabel =
		snapshot.currentNodeName?.trim() || snapshot.currentNodeId?.trim() || null;
	const activeNodeStatus = normalizeStatus(
		(activeNodeId && snapshot.nodeStatuses?.[activeNodeId]) ||
			(snapshot.currentNodeId && snapshot.nodeStatuses?.[snapshot.currentNodeId]) ||
			(snapshot.currentNodeName && snapshot.nodeStatuses?.[snapshot.currentNodeName]) ||
			undefined
	);
	const executionStatus = normalizeStatus(snapshot.status);
	const isTerminal = executionStatus === 'success' || executionStatus === 'error';

	const startNodeId =
		nodes.find((node) => node.type === 'start' || node.id === '__start__')?.id ?? null;
	const endNodeId = nodes.find((node) => node.type === 'end' || node.id === '__end__')?.id ?? null;

	if (startNodeId && executionStatus !== 'idle') {
		nodeStatuses[startNodeId] = 'success';
	}

	if (activeNodeId) {
		// When the workflow has finished, the current node is the last one
		// executed. If the snapshot carries an explicit per-node status, honor
		// it; otherwise inherit the execution's terminal status. Previously we
		// fell through to 'running' here, which left agent nodes spinning
		// perpetually after a successful run (the workflow-level completed
		// event doesn't always stamp a per-node success into nodeStatuses,
		// e.g. for durable/run children whose terminal state is tracked via
		// workflow_agent_runs instead).
		if (executionStatus === 'error' && activeNodeStatus === 'idle') {
			nodeStatuses[activeNodeId] = 'error';
		} else if (isTerminal) {
			nodeStatuses[activeNodeId] =
				activeNodeStatus !== 'idle' ? activeNodeStatus : executionStatus;
		} else {
			nodeStatuses[activeNodeId] = 'running';
		}
	}

	if (executionStatus === 'success' && endNodeId) {
		nodeStatuses[endNodeId] = 'success';
	}

	for (const edge of edges) {
		const targetStatus = nodeStatuses[edge.target];

		if (targetStatus === 'running') {
			edgeStatuses[edge.id] = 'running';
			continue;
		}

		if (targetStatus === 'success') {
			edgeStatuses[edge.id] = 'success';
			continue;
		}

		if (targetStatus === 'error') {
			edgeStatuses[edge.id] = 'error';
		}
	}

	return {
		activeNodeId,
		activeNodeLabel,
		nodeStatuses,
		edgeStatuses,
		isTerminal
	};
}
