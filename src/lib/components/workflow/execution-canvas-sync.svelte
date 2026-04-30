<script lang="ts">
	import { Panel, useNodesInitialized, useSvelteFlow, type Edge } from '@xyflow/svelte';
	import { CheckCircle2, Loader2, MapPinned, XCircle } from '@lucide/svelte';
	import type { ExecutionReadModel, ExecutionTimelineEvent } from '$lib/types/execution-stream';
	import {
		buildExecutionCanvasState,
		resolveExecutionNodeId,
		type ExecutionCanvasStatus
	} from '$lib/utils/execution-canvas';
	import { mergeTimelineEvents } from '$lib/utils/execution-timeline';

	interface Props {
		snapshot: ExecutionReadModel | null;
		streamEvents?: ExecutionTimelineEvent[];
		edges: Edge[];
		setEdges: (edges: Edge[]) => void;
		managedNodeIds?: string[] | null;
		companionNodeId?: string | null;
		onAutoCenter?: () => void;
		showPanel?: boolean;
	}

	let {
		snapshot,
		streamEvents = [],
		edges,
		setEdges,
		managedNodeIds = null,
		companionNodeId = null,
		onAutoCenter,
		showPanel = true
	}: Props = $props();

	const { getNodes, updateNodeData, setCenter, getViewport, fitView } = useSvelteFlow();
	const nodesInitialized = useNodesInitialized();

	let lastActiveNodeId = $state<string | null>(null);
	let previousTerminal = $state(false);

	function statusIcon(status: string | null | undefined) {
		switch ((status ?? '').toLowerCase()) {
			case 'running':
			case 'pending':
				return Loader2;
			case 'success':
				return CheckCircle2;
			case 'error':
			case 'cancelled':
				return XCircle;
			default:
				return MapPinned;
		}
	}

	function centerOnNode(nodeId: string) {
		const node = getNodes().find((entry) => entry.id === nodeId);
		if (!node) return;
		const companion = companionNodeId ? getNodes().find((entry) => entry.id === companionNodeId) : null;

		if (companion && companion.id !== node.id) {
			onAutoCenter?.();
			fitView({
				nodes: [node, companion],
				padding: 0.28,
				duration: 350,
				maxZoom: 0.9
			});

			queueMicrotask(() => {
				const viewport = getViewport();
				if (viewport.zoom >= 0.42) return;

				const nodeWidth = node.measured?.width ?? node.width ?? 148;
				const nodeHeight = node.measured?.height ?? node.height ?? 148;
				const companionWidth = companion.measured?.width ?? companion.width ?? 420;
				const companionHeight = companion.measured?.height ?? companion.height ?? 220;
				const left = Math.min(node.position.x, companion.position.x);
				const right = Math.max(node.position.x + nodeWidth, companion.position.x + companionWidth);
				const top = Math.min(node.position.y, companion.position.y);
				const bottom = Math.max(node.position.y + nodeHeight, companion.position.y + companionHeight);

				setCenter((left + right) / 2, (top + bottom) / 2, {
					zoom: 0.42,
					duration: 350
				});
			});
			return;
		}

		const width = node.measured?.width ?? node.width ?? 148;
		const height = node.measured?.height ?? node.height ?? 148;
		const viewport = getViewport();
		const zoom = Math.max(viewport.zoom, 0.72);

		onAutoCenter?.();
		setCenter(node.position.x + width / 2, node.position.y + height / 2, {
			zoom,
			duration: 350
		});
	}

	function applyNodeStatuses(statuses: Record<string, ExecutionCanvasStatus>) {
		const nodes = getNodes();
		const managed = managedNodeIds ? new Set(managedNodeIds) : null;
		// Compute agent progress from both live stream events and persisted snapshot events.
		// Dapr pub/sub events are wrapped as `com.dapr.event.sent`; the actual agent event
		// payload lives under `data.data`.
		const events = mergeTimelineEvents(snapshot?.agentEvents, streamEvents);
		const nestedData = (event: ExecutionTimelineEvent) =>
			typeof event.data?.data === 'object' && event.data.data !== null && !Array.isArray(event.data.data)
				? (event.data.data as Record<string, unknown>)
				: null;
		const stringValue = (value: unknown) => (typeof value === 'string' && value ? value : null);
		const matchType = (event: ExecutionTimelineEvent, type: string) =>
			event.type === type ||
			(event.data?.type as string | undefined) === type ||
			(nestedData(event)?.type as string | undefined) === type;
		const eventRunId = (event: ExecutionTimelineEvent) =>
			stringValue(event.workflowAgentRunId) ||
			stringValue(event.data?.workflowAgentRunId) ||
			stringValue(nestedData(event)?.workflowAgentRunId) ||
			stringValue(event.daprInstanceId) ||
			stringValue(event.data?.daprInstanceId) ||
			stringValue(nestedData(event)?.daprInstanceId) ||
			null;
		const eventNodeId = (event: ExecutionTimelineEvent) =>
			stringValue(event.data?.nodeId) || stringValue(nestedData(event)?.nodeId);
		const toolName = (event: ExecutionTimelineEvent) =>
			stringValue(event.toolName) ||
			stringValue(event.data?.toolName) ||
			stringValue(nestedData(event)?.toolName);
		const agentNodeIds = new Set(
			(snapshot?.agentRuns ?? [])
				.map((run) => resolveExecutionNodeId(run.nodeId, nodes))
				.filter(Boolean) as string[]
		);
		const eventsForNode = (nodeId: string) => {
			if (!agentNodeIds.has(nodeId)) return [];
			const runIds = new Set(
				(snapshot?.agentRuns ?? [])
					.filter((run) => resolveExecutionNodeId(run.nodeId, nodes) === nodeId)
					.flatMap((run) => [run.id, run.agentWorkflowId, run.daprInstanceId].filter(Boolean) as string[])
			);
			const nodeEvents = events.filter((event) => {
				const rawEventNodeId = eventNodeId(event);
				const resolvedEventNodeId = resolveExecutionNodeId(rawEventNodeId, nodes);
				const runId = eventRunId(event);
				return (
					rawEventNodeId === nodeId ||
					resolvedEventNodeId === nodeId ||
					(runId ? runIds.has(runId) : false)
				);
			});
			return nodeEvents.length > 0 || (snapshot?.agentRuns ?? []).length !== 1
				? nodeEvents
				: events;
		};

		for (const node of nodes) {
			if (managed && !managed.has(node.id)) continue;
			const nextStatus = statuses[node.id] ?? 'idle';
			const updates: Record<string, unknown> = { status: nextStatus };
			const nodeEvents = eventsForNode(node.id);
			const turnCount = nodeEvents.filter((event) => matchType(event, 'llm_complete')).length;
			const toolStarts = nodeEvents.filter((event) => matchType(event, 'tool_call_start'));
			const toolCount = toolStarts.length;
			const toolEndCount = nodeEvents.filter((event) => matchType(event, 'tool_call_end')).length;
			const lastToolStart = toolStarts.at(-1);
			const activeTool = lastToolStart ? toolName(lastToolStart) : null;
			const isToolActive = toolCount > toolEndCount;

			// Attach agent progress to agent nodes while running and after terminal completion.
			if (turnCount > 0 || toolCount > 0) {
				updates.agentProgress = {
					turnCount,
					toolCount,
					activeTool: nextStatus === 'running' && isToolActive ? activeTool : null,
					eventCount: nodeEvents.length,
				};
			} else {
				updates.agentProgress = null;
			}

			const current = node.data;
			const prevProgress = JSON.stringify(current?.agentProgress ?? null);
			const nextProgress = JSON.stringify(updates.agentProgress ?? null);
			if (current?.status === nextStatus && prevProgress === nextProgress) continue;
			updateNodeData(node.id, updates);
		}
	}

	function applyEdgeStatuses(statuses: Record<string, ExecutionCanvasStatus>) {
		let didChange = false;
		const nextEdges = edges.map((edge) => {
			const nextStatus = statuses[edge.id] ?? 'idle';
			const currentStatus = edge.data?.status;
			if (currentStatus === nextStatus) return edge;
			didChange = true;
			return {
				...edge,
				data: {
					...edge.data,
					status: nextStatus
				}
			};
		});

		if (didChange) {
			setEdges(nextEdges);
		}
	}

	$effect(() => {
		const initialized = nodesInitialized;
		if (!initialized) return;

		const nodes = getNodes();
		if (nodes.length === 0) return;
		const managedNodes =
			managedNodeIds && managedNodeIds.length > 0
				? nodes.filter((node) => managedNodeIds.includes(node.id))
				: nodes;

		const canvasState = buildExecutionCanvasState(snapshot, managedNodes, edges);
		applyNodeStatuses(canvasState.nodeStatuses);
		applyEdgeStatuses(canvasState.edgeStatuses);

		if (
			canvasState.activeNodeId &&
			canvasState.activeNodeId !== lastActiveNodeId &&
			!canvasState.isTerminal
		) {
			centerOnNode(canvasState.activeNodeId);
		}

		lastActiveNodeId = canvasState.activeNodeId;

		previousTerminal = canvasState.isTerminal;
	});
</script>

{#if showPanel && snapshot}
	{@const Icon = statusIcon(snapshot.status)}
	<Panel position="top-right" class="!mt-3 !mr-3">
		<div class="rounded-xl border border-border/80 bg-card/95 px-3 py-2 shadow-lg backdrop-blur-sm">
			<div class="flex items-center gap-2 text-xs">
				<Icon
					size={14}
					class={
						snapshot.status === 'running' || snapshot.status === 'pending'
							? 'animate-spin text-yellow-500'
							: snapshot.status === 'success'
								? 'text-green-500'
								: snapshot.status === 'error' || snapshot.status === 'cancelled'
									? 'text-red-500'
									: 'text-muted-foreground'
					}
				/>
				<div class="min-w-0">
					<p class="font-medium leading-none">
						{snapshot.currentNodeName || snapshot.currentNodeId || 'Waiting for execution state'}
					</p>
					<p class="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">
						{snapshot.status}
					</p>
				</div>
			</div>
			<div class="mt-2 flex items-center gap-1.5 border-t border-border/70 pt-2 text-[11px] text-muted-foreground">
				<MapPinned size={12} />
				<span>Auto-following active step</span>
			</div>
		</div>
	</Panel>
{/if}
