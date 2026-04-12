<script lang="ts">
	import { Panel, useNodesInitialized, useSvelteFlow, type Edge } from '@xyflow/svelte';
	import { CheckCircle2, Loader2, MapPinned, XCircle } from 'lucide-svelte';
	import type { ExecutionReadModel, ExecutionTimelineEvent } from '$lib/types/execution-stream';
	import {
		buildExecutionCanvasState,
		type ExecutionCanvasStatus
	} from '$lib/utils/execution-canvas';

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
		const managed = managedNodeIds ? new Set(managedNodeIds) : null;
		// Compute agent progress from stream events (primary) or snapshot (fallback)
		const events = streamEvents.length > 0 ? streamEvents : (snapshot?.agentEvents ?? []);
		const matchType = (e: { type: string; data?: Record<string, unknown> }, t: string) =>
			e.type === t || (e.data?.type as string) === t;
		const turnCount = events.filter(e => matchType(e, 'llm_complete')).length;
		const toolStarts = events.filter(e => matchType(e, 'tool_call_start'));
		const toolCount = toolStarts.length;
		const lastTool = toolStarts.at(-1);
		const activeTool = (lastTool as any)?.toolName
			?? (lastTool?.data?.toolName as string | undefined)
			?? null;
		const toolEndCount = events.filter(e => matchType(e, 'tool_call_end')).length;
		const isToolActive = toolCount > toolEndCount;

		for (const node of getNodes()) {
			if (managed && !managed.has(node.id)) continue;
			const nextStatus = statuses[node.id] ?? 'idle';
			const updates: Record<string, unknown> = { status: nextStatus };

			// Attach agent progress to running nodes
			if (nextStatus === 'running' && (turnCount > 0 || toolCount > 0)) {
				updates.agentProgress = {
					turnCount,
					toolCount,
					activeTool: isToolActive ? activeTool : null,
					eventCount: events.length,
				};
			} else if (nextStatus !== 'running') {
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
