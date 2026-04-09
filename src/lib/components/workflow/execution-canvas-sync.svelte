<script lang="ts">
	import { Panel, useNodesInitialized, useSvelteFlow, type Edge } from '@xyflow/svelte';
	import { CheckCircle2, Loader2, MapPinned, XCircle } from 'lucide-svelte';
	import type { ExecutionReadModel } from '$lib/types/execution-stream';
	import {
		buildExecutionCanvasState,
		type ExecutionCanvasStatus
	} from '$lib/utils/execution-canvas';

	interface Props {
		snapshot: ExecutionReadModel | null;
		edges: Edge[];
		setEdges: (edges: Edge[]) => void;
		onAutoCenter?: () => void;
		showPanel?: boolean;
	}

	let {
		snapshot,
		edges,
		setEdges,
		onAutoCenter,
		showPanel = true
	}: Props = $props();

	const { getNodes, updateNodeData, setCenter, getViewport } = useSvelteFlow();
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
		for (const node of getNodes()) {
			const nextStatus = statuses[node.id] ?? 'idle';
			if ((node.data?.status as string | undefined) === nextStatus) continue;
			updateNodeData(node.id, { status: nextStatus });
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

		const canvasState = buildExecutionCanvasState(snapshot, nodes, edges);
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
