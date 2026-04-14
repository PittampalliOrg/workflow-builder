import type { Edge, Node } from '@xyflow/svelte';
import type { ExecutionAgentRun, ExecutionTimelineEvent } from '$lib/types/execution-stream';
import type { WorkflowNodeData, NodeStatus } from '$lib/stores/workflow.svelte';
import { getAgentTaskBody } from '$lib/types/agent-graph';

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

function compactAgentLoopGraph(
	graph: { nodes: AgentLoopNode[]; edges: AgentLoopEdge[] }
): { nodes: AgentLoopNode[]; edges: AgentLoopEdge[] } {
	if (graph.nodes.length <= 8) return graph;

	const root = graph.nodes[0];
	const body = graph.nodes.slice(1);
	const middle = body.slice(0, 5);
	const tail = body.at(-1);
	const omittedCount = Math.max(body.length - middle.length - (tail ? 1 : 0), 0);

	const nodes: AgentLoopNode[] = [root];
	const edges: AgentLoopEdge[] = [];
	let previousId = root.id;

	for (const [index, node] of middle.entries()) {
		const compactId = `${node.id}:compact:${index}`;
		nodes.push({
			...node,
			id: compactId,
			position: { x: (index + 1) * 220, y: 0 }
		});
		edges.push({
			id: `${previousId}->${compactId}`,
			source: previousId,
			target: compactId,
			type: 'animated'
		});
		previousId = compactId;
	}

	if (omittedCount > 0) {
		const summaryId = `summary:${root.id}`;
		nodes.push({
			id: summaryId,
			type: 'default',
			position: { x: (middle.length + 1) * 220, y: 0 },
			data: {
				label: `${omittedCount} more steps`,
				description: 'Expanded in Agents tab',
				status: 'idle'
			}
		});
		edges.push({
			id: `${previousId}->${summaryId}`,
			source: previousId,
			target: summaryId,
			type: 'animated'
		});
		previousId = summaryId;
	}

	if (tail) {
		const tailId = `${tail.id}:tail`;
		nodes.push({
			...tail,
			id: tailId,
			position: { x: (nodes.length + 1) * 220, y: 0 }
		});
		edges.push({
			id: `${previousId}->${tailId}`,
			source: previousId,
			target: tailId,
			type: 'animated'
		});
	}

	return { nodes, edges };
}

function latestToolName(events: ExecutionTimelineEvent[]): string | null {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		const name =
			asString(event.toolName) ??
			asString(event.data.toolName) ??
			asString(event.data.name);
		if (name) return name;
	}
	return null;
}

function latestRunError(run: ExecutionAgentRun, events: ExecutionTimelineEvent[]): string | undefined {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const error = asString(events[index].data.error) ?? asString(events[index].data.message);
		if (error) return shortText(error, 96);
	}
	return shortText(run.error, 96);
}

function agentTurnCount(events: ExecutionTimelineEvent[]): number {
	const explicitTurns = events.filter((event) => event.type === 'turn_started').length;
	return explicitTurns > 0
		? explicitTurns
		: events.filter((event) => event.type === 'llm_complete').length;
}

function buildAgentLoopStateDiagram(
	run: ExecutionAgentRun,
	events: ExecutionTimelineEvent[]
): { nodes: AgentLoopNode[]; edges: AgentLoopEdge[] } {
	const relevant = eventsForAgentRun(run, events);
	const turnCount = agentTurnCount(relevant);
	const toolStarts = relevant.filter((event) => event.type === 'tool_call_start');
	const toolEnds = relevant.filter((event) => event.type === 'tool_call_end');
	const toolErrors = relevant.filter((event) => event.type === 'tool_call_error');
	const lastTool = latestToolName(relevant);
	const lastEvent = relevant.at(-1) ?? null;
	const completed = run.status === 'completed';
	const failed = run.status === 'failed';

	const plannerActive = Boolean(lastEvent && ['turn_started', 'llm_start', 'llm_complete'].includes(lastEvent.type));
	const toolActive = Boolean(lastEvent && lastEvent.type === 'tool_call_start');
	const observeActive = Boolean(lastEvent && ['tool_call_end', 'tool_call_error'].includes(lastEvent.type));

	const nodes: AgentLoopNode[] = [
		{
			id: `planner:${run.id}`,
			type: 'default',
			position: { x: 156, y: 32 },
			data: {
				label: 'Planner / LLM',
				description:
					turnCount > 0
						? `${turnCount} turn${turnCount === 1 ? '' : 's'}${plannerActive ? ' · reasoning' : ''}`
						: 'Waiting for first turn',
				status: failed && plannerActive ? 'error' : completed ? 'success' : plannerActive || run.status === 'running' ? 'running' : turnCount > 0 ? 'success' : 'idle'
			}
		},
		{
			id: `tool:${run.id}`,
			type: 'default',
			position: { x: 324, y: 156 },
			data: {
				label: 'Tool Execution',
				description:
					toolStarts.length > 0
						? `${toolStarts.length} call${toolStarts.length === 1 ? '' : 's'}${lastTool ? ` · ${lastTool}` : ''}`
						: 'No tools used',
				status:
					failed && toolActive
						? 'error'
						: completed
							? toolStarts.length > 0
								? 'success'
								: 'idle'
							: toolActive
								? 'running'
								: toolStarts.length > 0
									? toolErrors.length > 0
										? 'error'
										: 'success'
									: 'idle'
			}
		},
		{
			id: `observe:${run.id}`,
			type: 'default',
			position: { x: 156, y: 288 },
			data: {
				label: 'Observation',
				description:
					toolEnds.length > 0 || toolErrors.length > 0
						? `${toolEnds.length} result${toolEnds.length === 1 ? '' : 's'}${toolErrors.length ? ` · ${toolErrors.length} error${toolErrors.length === 1 ? '' : 's'}` : ''}`
						: 'Awaiting tool results',
				status:
					failed && observeActive
						? 'error'
						: completed
							? toolEnds.length > 0 || toolErrors.length > 0
								? 'success'
								: 'idle'
							: observeActive
								? 'running'
								: toolEnds.length > 0 || toolErrors.length > 0
									? 'success'
									: 'idle'
			}
		},
		{
			id: `result:${run.id}`,
			type: 'default',
			position: { x: 0, y: 156 },
			data: {
				label: failed ? 'Run Failed' : completed ? 'Final Response' : 'Pending Outcome',
				description:
					failed
						? latestRunError(run, relevant) ?? 'See Agents tab for details'
						: completed
							? 'Goal achieved'
							: 'Loop until done',
				status: failed ? 'error' : completed ? 'success' : run.status === 'running' ? 'running' : 'idle'
			}
		}
	];

	const edges: AgentLoopEdge[] = [
		{
			id: `planner->tool:${run.id}`,
			source: `planner:${run.id}`,
			target: `tool:${run.id}`,
			type: 'animated',
			sourceHandle: 'right-source',
			targetHandle: 'left-target',
			animated: toolActive || (!completed && toolStarts.length > 0),
			label: toolStarts.length > 0 ? 'Action' : undefined,
			data: { route: 'arc' }
		},
		{
			id: `tool->observe:${run.id}`,
			source: `tool:${run.id}`,
			target: `observe:${run.id}`,
			type: 'animated',
			sourceHandle: 'bottom-source',
			targetHandle: 'top-target',
			animated: observeActive || (!completed && (toolEnds.length > 0 || toolErrors.length > 0)),
			label: toolEnds.length > 0 || toolErrors.length > 0 ? 'Results' : undefined,
			data: { route: 'arc' }
		},
		{
			id: `observe->planner:${run.id}`,
			source: `observe:${run.id}`,
			target: `planner:${run.id}`,
			type: 'animated',
			sourceHandle: 'left-source',
			targetHandle: 'bottom-target',
			animated: !completed && !failed && (turnCount > 1 || toolEnds.length > 0 || observeActive),
			label: turnCount > 1 || observeActive ? 'Loop' : undefined,
			data: { route: 'arc' }
		},
		{
			id: `planner->result:${run.id}`,
			source: `planner:${run.id}`,
			target: `result:${run.id}`,
			type: 'animated',
			sourceHandle: 'left-source',
			targetHandle: 'top-target',
			animated: completed || failed,
			label: completed ? 'Goal achieved' : failed ? 'Failed' : undefined,
			data: { route: 'arc' }
		}
	];

	return { nodes, edges };
}

function parentNodeSize(node: Node): { width: number; height: number } {
	return {
		width: node.measured?.width ?? node.width ?? 220,
		height: node.measured?.height ?? node.height ?? 96
	};
}

function resolveWorkflowNode(
	workflowNodes: Node[],
	runNodeId: string
): Node | undefined {
	return (
		workflowNodes.find((node) => node.id === runNodeId) ??
		workflowNodes.find((node) => node.id === `/${runNodeId}`) ??
		workflowNodes.find((node) => node.id.endsWith(`/${runNodeId}`)) ??
		workflowNodes.find((node) => {
			const label = (node.data as Record<string, unknown> | undefined)?.label;
			return typeof label === 'string' && label.trim() === runNodeId;
		})
	);
}

function formatTurnBudget(maxTurns: unknown): string | null {
	const parsed =
		typeof maxTurns === 'number'
			? maxTurns
			: typeof maxTurns === 'string'
				? Number.parseInt(maxTurns, 10)
				: Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? `max ${parsed} turns` : null;
}

export function buildAgentCanvasSubflows(
	workflowNodes: Node[],
	agentRuns: ExecutionAgentRun[],
	events: ExecutionTimelineEvent[],
	_expandedRunId: string | null
): { nodes: AgentCanvasNode[]; edges: AgentCanvasEdge[]; replacedNodeIds: Set<string> } {
	const nodes: AgentCanvasNode[] = [];
	const edges: AgentCanvasEdge[] = [];
	const replacedNodeIds = new Set<string>();

	const loopNodeWidth = 260;
	const groupPadX = 20;
	const groupPadTop = 56;
	const groupWidth = loopNodeWidth + groupPadX * 2;
	const groupHeight = 240;

	for (const run of agentRuns) {
		const workflowNode = resolveWorkflowNode(workflowNodes, run.nodeId);
		if (!workflowNode) continue;

		const relevant = eventsForAgentRun(run, events);
		const toolCount = relevant.filter((e) => e.type === 'tool_call_start').length;
		const turnCount = agentTurnCount(relevant);
		const lastTool = latestToolName(relevant);
		const runStatus = asWorkflowNodeStatus(nodeStatusForRun(run.status));
		const taskConfig = (workflowNode.data as Record<string, unknown> | undefined)?.taskConfig;
		const agentBody = getAgentTaskBody(taskConfig as Record<string, unknown> | undefined);
		const turnBudget = formatTurnBudget(agentBody.maxTurns);

		const groupId = `agent-group:${run.id}`;
		const loopId = `agent-loop:${run.id}`;

		const parentLabel = typeof (workflowNode.data as Record<string, unknown>)?.label === 'string'
			? (workflowNode.data as Record<string, unknown>).label as string
			: run.nodeId;

		// Mark the original node for removal — the group replaces it
		replacedNodeIds.add(workflowNode.id);

		// Subflow group positioned exactly where the original node was
		nodes.push({
			id: groupId,
			type: 'childWorkflowGroup',
			position: { ...workflowNode.position },
			draggable: false,
			selectable: true,
			connectable: false,
			style: `width:${groupWidth}px;height:${groupHeight}px;`,
			data: {
				label: parentLabel,
				description: [run.mode, run.status, turnBudget].filter(Boolean).join(' · '),
				status: runStatus,
				type: 'run',
				childWorkflow: true,
				agentRunId: run.id,
				replacedNodeId: workflowNode.id
			}
		});

		// Loop node nested inside the group
		nodes.push({
			id: loopId,
			type: 'childWorkflowLoop',
			parentId: groupId,
			extent: 'parent',
			position: { x: groupPadX, y: groupPadTop },
			draggable: false,
			selectable: true,
			connectable: false,
			style: `width:${loopNodeWidth}px;`,
			data: {
				label: run.status === 'running' && lastTool
					? `Running · ${lastTool}`
					: run.status === 'failed'
						? latestRunError(run, relevant) ?? 'Failed'
						: run.status === 'completed'
							? 'Done'
							: 'Waiting',
				status: runStatus,
				type: 'run',
				childWorkflow: true,
				agentRunId: run.id,
				childWorkflowTurnCount: turnCount,
				childWorkflowMaxTurns: agentBody.maxTurns,
				childWorkflowToolCount: toolCount
			}
		});
	}

	return { nodes, edges, replacedNodeIds };
}

/** Remap edges so that any edge pointing to/from a replaced node points to its group instead. */
export function remapEdgesForReplacements(
	edges: Edge[],
	replacedNodeIds: Set<string>,
	agentRuns: { id: string; nodeId: string }[],
	workflowNodes: Node[]
): Edge[] {
	if (replacedNodeIds.size === 0) return edges;

	// Build a map: original node id → group id
	const remap = new Map<string, string>();
	for (const run of agentRuns) {
		const wfNode = resolveWorkflowNode(workflowNodes, run.nodeId);
		if (wfNode && replacedNodeIds.has(wfNode.id)) {
			remap.set(wfNode.id, `agent-group:${run.id}`);
		}
	}

	return edges.map((edge) => {
		const newSource = remap.get(edge.source);
		const newTarget = remap.get(edge.target);
		if (!newSource && !newTarget) return edge;
		return {
			...edge,
			source: newSource ?? edge.source,
			target: newTarget ?? edge.target
		};
	});
}
