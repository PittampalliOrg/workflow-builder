import type { Node } from '@xyflow/svelte';
import type { ExecutionAgentRun, ExecutionTimelineEvent } from '$lib/types/execution-stream';

type AgentProgress = {
	turnCount: number;
	toolCount: number;
	activeTool: string | null;
	eventCount: number;
};

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nestedData(event: ExecutionTimelineEvent): Record<string, unknown> | null {
	return typeof event.data?.data === 'object' && event.data.data !== null && !Array.isArray(event.data.data)
		? (event.data.data as Record<string, unknown>)
		: null;
}

function eventType(event: ExecutionTimelineEvent): string | null {
	return (
		asString(event.type) ??
		asString(event.data?.type) ??
		asString(nestedData(event)?.type)
	);
}

function eventRunIds(event: ExecutionTimelineEvent): string[] {
	const nested = nestedData(event);
	return [
		event.workflowAgentRunId,
		event.data?.workflowAgentRunId,
		nested?.workflowAgentRunId,
		event.data?.agentWorkflowId,
		nested?.agentWorkflowId,
		event.daprInstanceId,
		event.data?.daprInstanceId,
		nested?.daprInstanceId
	]
		.map(asString)
		.filter(Boolean) as string[];
}

function eventNodeId(event: ExecutionTimelineEvent): string | null {
	const nested = nestedData(event);
	return asString(event.data?.nodeId) ?? asString(nested?.nodeId);
}

function eventsForRun(
	run: ExecutionAgentRun,
	events: ExecutionTimelineEvent[]
): ExecutionTimelineEvent[] {
	const runIds = new Set([run.id, run.agentWorkflowId, run.daprInstanceId].filter(Boolean));
	return events.filter(
		(event) => eventRunIds(event).some((id) => runIds.has(id)) || eventNodeId(event) === run.nodeId
	);
}

function turnCount(events: ExecutionTimelineEvent[]): number {
	const explicit = events.filter((event) => eventType(event) === 'turn_started').length;
	if (explicit > 0) return explicit;
	return events.filter((event) => eventType(event) === 'llm_complete').length;
}

function latestTool(events: ExecutionTimelineEvent[]): string | null {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		const nested = nestedData(event);
		const tool =
			asString(event.toolName) ??
			asString(event.data.toolName) ??
			asString(nested?.toolName) ??
			asString(event.data.name) ??
			asString(nested?.name);
		if (tool) return tool;
	}
	return null;
}

function nodeStatusForRun(status: ExecutionAgentRun['status']): string {
	if (status === 'completed') return 'success';
	if (status === 'failed') return 'error';
	if (status === 'running') return 'running';
	return 'idle';
}

function nodeLabel(node: Node): string | null {
	const label = (node.data as Record<string, unknown> | undefined)?.label;
	return asString(label);
}

export function findAgentRunForNode(
	node: Node | null | undefined,
	runs: ExecutionAgentRun[]
): ExecutionAgentRun | null {
	if (!node) return null;
	return (
		runs.find((run) => run.nodeId === node.id) ??
		runs.find((run) => node.id === `/${run.nodeId}`) ??
		runs.find((run) => node.id.endsWith(`/${run.nodeId}`)) ??
		runs.find((run) => nodeLabel(node) === run.nodeId) ??
		null
	);
}

export function buildAgentProgress(
	run: ExecutionAgentRun,
	events: ExecutionTimelineEvent[]
): AgentProgress {
	const relevant = eventsForRun(run, events);
	const toolEvents = relevant.filter((event) => eventType(event) === 'tool_call_start');
	return {
		turnCount: turnCount(relevant),
		toolCount: toolEvents.length,
		activeTool: run.status === 'running' ? latestTool(relevant) : null,
		eventCount: relevant.length
	};
}

export function withAgentNodeMetrics(
	nodes: Node[],
	runs: ExecutionAgentRun[],
	events: ExecutionTimelineEvent[]
): Node[] {
	if (runs.length === 0) return nodes;

	return nodes.map((node) => {
		const run = findAgentRunForNode(node, runs);
		if (!run) return node;

		return {
			...node,
			data: {
				...(node.data as Record<string, unknown>),
				status: nodeStatusForRun(run.status),
				agentRunId: run.id,
				agentProgress: buildAgentProgress(run, events)
			}
		};
	});
}
