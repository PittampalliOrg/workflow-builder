<script lang="ts">
	import { getContext } from 'svelte';
	import {
		SvelteFlow,
		MiniMap,
		Controls,
		Background,
		BackgroundVariant,
		ConnectionMode,
		SelectionMode,
		MarkerType,
		type OnConnect,
		type OnReconnect,
		type IsValidConnection,
		type NodeTypes,
		type EdgeTypes,
		type Node,
		type Edge,
	} from '@xyflow/svelte';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import type { createUiStore } from '$lib/stores/ui.svelte';

	// CNCF Serverless Workflow 1.0 node types only
	import StartNode from './nodes/sw/start-node.svelte';
	import EndNode from './nodes/sw/end-node.svelte';
	import CallNode from './nodes/sw/call-node.svelte';
	import SetNode from './nodes/sw/set-node.svelte';
	import SwitchNode from './nodes/sw/switch-node.svelte';
	import WaitNode from './nodes/sw/wait-node.svelte';
	import EmitNode from './nodes/sw/emit-node.svelte';
	import ListenNode from './nodes/sw/listen-node.svelte';
	import ForNode from './nodes/sw/for-node.svelte';
	import ForkNode from './nodes/sw/fork-node.svelte';
	import TryNode from './nodes/sw/try-node.svelte';
	import RunNode from './nodes/sw/run-node.svelte';
	import RaiseNode from './nodes/sw/raise-node.svelte';
	import DoNode from './nodes/sw/do-node.svelte';
	import DefaultNode from './nodes/default-node.svelte';
	import AnimatedEdge from './edges/animated-edge.svelte';
	import LabeledEdge from './edges/labeled-edge.svelte';
	import CustomConnectionLine from './custom-connection-line.svelte';
	import KeyboardShortcuts from './keyboard-shortcuts.svelte';
	import AutoFit from './auto-fit.svelte';
	import AutoLayout from './auto-layout.svelte';
	import StepPalette from './step-palette.svelte';
	import DropTarget from './drop-target.svelte';
	import ContextMenu from './context-menu.svelte';
	import ExecutionDemo from './execution-demo.svelte';
	import ExecutionTracker from './execution-tracker.svelte';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');
	const ui = getContext<ReturnType<typeof createUiStore>>('ui');

	// Map our theme to SvelteFlow's colorMode
	let colorMode = $derived<'light' | 'dark' | 'system'>(
		ui.theme === 'dark' ? 'dark' : ui.theme === 'light' ? 'light' : 'system'
	);

	const nodeTypes: NodeTypes = {
		start: StartNode,
		end: EndNode,
		call: CallNode,
		set: SetNode,
		switch: SwitchNode,
		wait: WaitNode,
		emit: EmitNode,
		listen: ListenNode,
		for: ForNode,
		fork: ForkNode,
		try: TryNode,
		run: RunNode,
		raise: RaiseNode,
		do: DoNode,
		default: DefaultNode
	} satisfies NodeTypes;

	const edgeTypes: EdgeTypes = {
		default: AnimatedEdge,
		animated: AnimatedEdge,
		labeled: LabeledEdge
	} satisfies EdgeTypes;

	// Context menu state
	let contextMenu = $state<{ x: number; y: number; nodeId: string | null } | null>(null);

	const defaultEdgeOptions = {
		type: 'default',
		markerEnd: {
			type: MarkerType.ArrowClosed,
			width: 16,
			height: 16
		}
	};


	const isValidConnection: IsValidConnection = (connection) => {
		if (connection.source === connection.target) return false;
		return !store.edges.some(
			(e) => e.source === connection.source && e.target === connection.target
		);
	};

	const onConnect: OnConnect = (connection) => {
		if (connection.source && connection.target) {
			store.addEdge(connection.source, connection.target);
		}
	};

	const onReconnect: OnReconnect = (oldEdge, newConnection) => {
		if (!newConnection.source || !newConnection.target) return;
		if (newConnection.source === newConnection.target) return;
		store.removeEdge(oldEdge.id);
		store.addEdge(newConnection.source, newConnection.target);
	};

	async function onBeforeDelete({
		nodes: nodesToDelete
	}: {
		nodes: Node[];
		edges: Edge[];
	}): Promise<boolean> {
		if (nodesToDelete.length === 0) return true;
		const connectedNodes = nodesToDelete.filter((n) =>
			store.edges.some((e) => e.source === n.id || e.target === n.id)
		);
		if (connectedNodes.length > 0) {
			const names = connectedNodes.map((n) => (n.data as { label?: string })?.label || n.id);
			return confirm(`Delete ${names.join(', ')}? Connected edges will also be removed.`);
		}
		return true;
	}

	function onNodeClick({ node }: { node: Node; event: MouseEvent | TouchEvent }) {
		store.selectedNodeId = node.id;
		store.selectedEdgeId = null;
	}

	function onNodeDoubleClick({ node }: { node: Node; event: MouseEvent }) {
		// Double-click opens config panel
		store.selectedNodeId = node.id;
		store.activeConfigTab = 'properties';
	}

	function onNodeContextMenu({ node, event }: { node: Node; event: MouseEvent }) {
		event.preventDefault();
		contextMenu = { x: event.clientX, y: event.clientY, nodeId: node.id };
	}

	function onEdgeClick({ edge }: { edge: Edge; event: MouseEvent }) {
		store.selectedEdgeId = edge.id;
		store.selectedNodeId = null;
	}

	function onPaneClick() {
		store.selectedNodeId = null;
		store.selectedEdgeId = null;
		contextMenu = null;
	}

	function onNodeDragStop() {
		store.isDirty = true;
	}
</script>

<div class="h-full w-full">
	<SvelteFlow
		bind:nodes={store.nodes}
		bind:edges={store.edges}
		{nodeTypes}
		{edgeTypes}
		{colorMode}
		{isValidConnection}
		{defaultEdgeOptions}
		connectionMode={ConnectionMode.Strict}
		selectionMode={SelectionMode.Partial}
		connectionLineComponent={CustomConnectionLine}
		zoomOnDoubleClick={false}
		zoomOnPinch={true}
		onconnect={onConnect}
		onreconnect={onReconnect}
		onbeforedelete={onBeforeDelete}
		onnodedragstop={onNodeDragStop}
		onnodeclick={onNodeClick}
		onnodecontextmenu={onNodeContextMenu}
		onedgeclick={onEdgeClick}
		onpaneclick={onPaneClick}
		snapGrid={[16, 16]}
		minZoom={0.2}
		maxZoom={2}
		deleteKey="Delete"
	>
		<KeyboardShortcuts />
		<AutoFit />
		<AutoLayout />
		<ExecutionDemo />
		<ExecutionTracker />
		<StepPalette />
		<DropTarget />
		<Controls>
		</Controls>
		{#if store.showMinimap}
			<MiniMap zoomable pannable bgColor="var(--background)" nodeStrokeColor="var(--border)" />
		{/if}
		<Background variant={BackgroundVariant.Dots} bgColor="var(--background)" patternColor="var(--border)" gap={24} size={2} />
	</SvelteFlow>
</div>

{#if contextMenu}
	<ContextMenu
		x={contextMenu.x}
		y={contextMenu.y}
		nodeId={contextMenu.nodeId}
		onClose={() => (contextMenu = null)}
	/>
{/if}
