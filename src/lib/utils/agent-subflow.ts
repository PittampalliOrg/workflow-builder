import type { Edge, Node } from '@xyflow/svelte';
import type { ExecutionAgentRun, ExecutionTimelineEvent } from '$lib/types/execution-stream';
import type { WorkflowNodeData, NodeStatus } from '$lib/stores/workflow.svelte';

type AgentLoopNodeData = {
	label: string;
	description?: string;
	status: 'idle' | 'pending' | 'running' | 'success' | 'error';
};

export type AgentLoopNode = Node<AgentLoopNodeData>;
export type AgentLoopEdge = Edge;
export type AgentCanvasNode = Node<WorkflowNodeData>;
export type AgentCanvasEdge = Edge;

function asWorkflowNodeStatus(status: AgentLoopNodeData['status']): NodeStatus {
	switch (status) {
		case 'running':
			return 'running';
		case 'success':
			return 'success';
		case 'error':
			return 'error';
		default:
			return 'idle';
	}
}

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function shortText(value: unknown, max = 72): string | undefined {
	const text = asString(value);
	if (!text) return undefined;
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function nodeStatusForRun(
	status: ExecutionAgentRun['status']
): AgentLoopNodeData['status'] {
	switch (status) {
		case 'completed':
			return 'success';
		case 'failed':
			return 'error';
		case 'running':
			return 'running';
		case 'scheduled':
			return 'idle';
		default:
			return 'idle';
	}
}

function eventStatus(type: string): AgentLoopNodeData['status'] {
	if (type === 'tool_call_error' || type === 'run_error') return 'error';
	if (type === 'tool_call_end' || type === 'llm_complete' || type === 'run_complete') return 'success';
	return 'running';
}

function eventLabel(event: ExecutionTimelineEvent, turnNumber: number | null): string {
	switch (event.type) {
		case 'turn_started':
			return turnNumber ? `Turn ${turnNumber}` : 'Turn';
		case 'llm_start':
		case 'llm_complete':
			return asString(event.data.model) ?? asString(event.data.modelName) ?? 'LLM';
		case 'tool_call_start':
		case 'tool_call_end':
		case 'tool_call_error':
			return asString(event.toolName) ?? asString(event.data.toolName) ?? asString(event.data.name) ?? 'Tool';
		case 'run_complete':
			return 'Run complete';
		case 'run_error':
			return 'Run failed';
		default:
			return event.type;
	}
}

function eventDescription(event: ExecutionTimelineEvent): string | undefined {
	switch (event.type) {
		case 'turn_started':
			return shortText(event.data.goal ?? event.data.summary ?? event.data.phase);
		case 'llm_start':
		case 'llm_complete':
			return shortText(event.data.phase ?? event.data.summary ?? event.data.reasoning);
		case 'tool_call_start':
			return shortText(event.data.description ?? event.data.command ?? event.data.file_path);
		case 'tool_call_end':
			return shortText(event.data.summary ?? event.data.result ?? event.data.output);
		case 'tool_call_error':
		case 'run_error':
			return shortText(event.data.error);
		case 'run_complete':
			return shortText(event.data.summary ?? event.data.output);
		default:
			return shortText(event.data.summary ?? event.data.phase);
	}
}

function isStructuralEvent(type: string): boolean {
	return [
		'run_started',
		'turn_started',
		'llm_start',
		'llm_complete',
		'tool_call_start',
		'tool_call_end',
		'tool_call_error',
		'run_complete',
		'run_error'
	].includes(type);
}

export function eventsForAgentRun(
	run: ExecutionAgentRun | null | undefined,
	events: ExecutionTimelineEvent[]
): ExecutionTimelineEvent[] {
	if (!run) return [];
	return events.filter(
		(event) =>
			event.workflowAgentRunId === run.id ||
			(event.daprInstanceId && event.daprInstanceId === run.daprInstanceId)
	);
}

export function buildAgentLoopGraph(
	run: ExecutionAgentRun | null | undefined,
	events: ExecutionTimelineEvent[]
): { nodes: AgentLoopNode[]; edges: AgentLoopEdge[] } {
	if (!run) return { nodes: [], edges: [] };

	const filtered = eventsForAgentRun(run, events).filter((event) => isStructuralEvent(event.type));
	const nodes: AgentLoopNode[] = [];
	const edges: AgentLoopEdge[] = [];

	const rootId = `run:${run.id}`;
	nodes.push({
		id: rootId,
		type: 'default',
		position: { x: 0, y: 0 },
		data: {
			label: run.nodeId,
			description: `${run.mode} · ${run.status}`,
			status: nodeStatusForRun(run.status)
		}
	});

	let previousId = rootId;
	let turnNumber = 0;
	let row = 0;
	let col = 1;

	for (const event of filtered) {
		if (event.type === 'run_started') {
			continue;
		}

		if (event.type === 'turn_started') {
			turnNumber += 1;
			row += 1;
			col = 1;
		}

		const nodeId = `event:${event.id}`;
		nodes.push({
			id: nodeId,
			type: 'default',
			position: { x: col * 220, y: row * 160 },
			data: {
				label: eventLabel(event, turnNumber || null),
				description: eventDescription(event),
				status:
					event.type === 'run_complete'
						? 'success'
						: event.type === 'run_error'
							? 'error'
							: eventStatus(event.type)
			}
		});
		edges.push({
			id: `${previousId}->${nodeId}`,
			source: previousId,
			target: nodeId,
			type: 'animated'
		});
		previousId = nodeId;
		col += 1;
	}

	if (!filtered.some((event) => event.type === 'run_complete' || event.type === 'run_error')) {
		const statusId = `run-status:${run.id}`;
		nodes.push({
			id: statusId,
			type: 'default',
			position: { x: Math.max(col, 1) * 220, y: row * 160 },
			data: {
				label: run.status === 'running' ? 'In progress' : 'Waiting',
				description: asString(run.error) ?? undefined,
				status: nodeStatusForRun(run.status)
			}
		});
		edges.push({
			id: `${previousId}->${statusId}`,
			source: previousId,
			target: statusId,
			type: 'animated'
		});
	}

	return { nodes, edges };
}

function parentNodeSize(node: Node): { width: number; height: number } {
	return {
		width: node.measured?.width ?? node.width ?? 220,
		height: node.measured?.height ?? node.height ?? 96
	};
}

function groupClass(runId: string, selectedRunId: string | null): string {
	return `agent-subflow-group${selectedRunId === runId ? ' agent-subflow-group-selected' : ''}`;
}

export function buildAgentCanvasSubflows(
	workflowNodes: Node[],
	agentRuns: ExecutionAgentRun[],
	events: ExecutionTimelineEvent[],
	selectedRunId: string | null
): { nodes: AgentCanvasNode[]; edges: AgentCanvasEdge[] } {
	const nodes: AgentCanvasNode[] = [];
	const edges: AgentCanvasEdge[] = [];

	for (const run of agentRuns) {
		const workflowNode = workflowNodes.find((node) => node.id === run.nodeId);
		if (!workflowNode) continue;

		const graph = buildAgentLoopGraph(run, events);
		if (graph.nodes.length === 0) continue;

		const { width: parentWidth, height: parentHeight } = parentNodeSize(workflowNode);
		const paddingX = 24;
		const paddingTop = 24;
		const paddingBottom = 24;
		const maxX = Math.max(...graph.nodes.map((node) => node.position.x)) + 180;
		const maxY = Math.max(...graph.nodes.map((node) => node.position.y)) + 96;
		const groupWidth = Math.max(420, maxX + paddingX * 2);
		const groupHeight = Math.max(220, maxY + paddingTop + paddingBottom);
		const groupId = `agent-group:${run.id}`;

		nodes.push({
			id: groupId,
			type: 'group',
			position: {
				x: workflowNode.position.x + parentWidth + 140,
				y: workflowNode.position.y - Math.max(40, (groupHeight - parentHeight) / 3)
			},
			draggable: false,
			selectable: false,
			connectable: false,
			class: groupClass(run.id, selectedRunId),
			style: `width:${groupWidth}px;height:${groupHeight}px;`,
			data: {
				label: `${run.nodeId} child run`,
				description: `${run.mode} · ${run.status}`,
				status: asWorkflowNodeStatus(nodeStatusForRun(run.status)),
				type: 'run'
			}
		});

		for (const node of graph.nodes) {
			nodes.push({
				id: `agent:${run.id}:${node.id}`,
				type: 'default',
				parentId: groupId,
				extent: 'parent',
				position: {
					x: node.position.x + paddingX,
					y: node.position.y + paddingTop
				},
				draggable: false,
				selectable: false,
				connectable: false,
				data: {
					label: node.data.label,
					description: node.data.description,
					status: asWorkflowNodeStatus(node.data.status),
					type: 'run'
				}
			});
		}

		const rootChildId = `agent:${run.id}:${graph.nodes[0]?.id}`;
		edges.push({
			id: `${workflowNode.id}->${rootChildId}`,
			source: workflowNode.id,
			target: rootChildId,
			type: 'animated',
			selectable: false,
			focusable: false,
			data: {
				status: run.status === 'failed' ? 'error' : run.status === 'completed' ? 'success' : 'running'
			}
		});

		for (const edge of graph.edges) {
			edges.push({
				...edge,
				id: `agent:${run.id}:${edge.id}`,
				source: `agent:${run.id}:${edge.source}`,
				target: `agent:${run.id}:${edge.target}`,
				selectable: false,
				focusable: false
			});
		}
	}

	return { nodes, edges };
}
