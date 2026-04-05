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
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
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
	import CommandPalette from './command-palette.svelte';
	import ExecutionDemo from './execution-demo.svelte';
	import ExecutionTracker from './execution-tracker.svelte';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');
	const ui = getContext<ReturnType<typeof createUiStore>>('ui');

	// Command palette state
	let showCommandPalette = $state(false);
	let commandPaletteReplaceNodeId = $state<string | null>(null);
	let commandPaletteInsertEdgeId = $state<string | null>(null);
	let commandPalettePosition = $state<{ x: number; y: number } | null>(null);

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
	let edgeContextMenu = $state<{ x: number; y: number; edgeId: string } | null>(null);

	// Insert-on-edge: pending edge ID for inserting a node
	let insertOnEdgeId = $state<string | null>(null);
	let insertOnEdgePosition = $state<{ x: number; y: number } | null>(null);

	function handleInsertOnEdge(event: Event) {
		const detail = (event as CustomEvent).detail as { edgeId: string; position: { x: number; y: number } };
		// Open command palette for edge insertion
		commandPaletteInsertEdgeId = detail.edgeId;
		commandPalettePosition = detail.position;
		commandPaletteReplaceNodeId = null;
		showCommandPalette = true;
	}

	function handleOpenCommandPalette() {
		commandPaletteReplaceNodeId = null;
		commandPaletteInsertEdgeId = null;
		commandPalettePosition = null;
		showCommandPalette = true;
	}

	function handleReplaceAction(event: Event) {
		const detail = (event as CustomEvent).detail as { nodeId: string };
		openReplaceAction(detail.nodeId);
	}

	onMount(() => {
		window.addEventListener('workflow:insert-on-edge', handleInsertOnEdge);
		window.addEventListener('workflow:command-palette', handleOpenCommandPalette);
		window.addEventListener('workflow:replace-action', handleReplaceAction);
		return () => {
			window.removeEventListener('workflow:insert-on-edge', handleInsertOnEdge);
			window.removeEventListener('workflow:command-palette', handleOpenCommandPalette);
			window.removeEventListener('workflow:replace-action', handleReplaceAction);
		};
	});

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

	function onEdgeContextMenu({ edge, event }: { edge: Edge; event: MouseEvent }) {
		event.preventDefault();
		edgeContextMenu = { x: event.clientX, y: event.clientY, edgeId: edge.id };
		contextMenu = null;
	}

	function deleteEdge(edgeId: string) {
		store.removeEdge(edgeId);
		edgeContextMenu = null;
	}

	function insertNodeOnEdge(edgeId: string) {
		const edge = store.edges.find((e) => e.id === edgeId);
		if (!edge) return;
		const sourceNode = store.nodes.find((n) => n.id === edge.source);
		const targetNode = store.nodes.find((n) => n.id === edge.target);
		if (sourceNode && targetNode) {
			const pos = {
				x: (sourceNode.position.x + targetNode.position.x) / 2,
				y: (sourceNode.position.y + targetNode.position.y) / 2
			};
			commandPaletteInsertEdgeId = edgeId;
			commandPalettePosition = pos;
			commandPaletteReplaceNodeId = null;
			showCommandPalette = true;
		}
		edgeContextMenu = null;
	}

	function openReplaceAction(nodeId: string) {
		commandPaletteReplaceNodeId = nodeId;
		commandPaletteInsertEdgeId = null;
		commandPalettePosition = null;
		showCommandPalette = true;
	}

	function onPaneClick() {
		store.selectedNodeId = null;
		store.selectedEdgeId = null;
		contextMenu = null;
		edgeContextMenu = null;
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
		connectionRadius={40}
		clickConnect={true}
		autoPanOnConnect={true}
		zoomOnDoubleClick={false}
		zoomOnPinch={true}
		onconnect={onConnect}
		onreconnect={onReconnect}
		onbeforedelete={onBeforeDelete}
		onnodedragstop={onNodeDragStop}
		onnodeclick={onNodeClick}
		onnodecontextmenu={onNodeContextMenu}
		onedgeclick={onEdgeClick}
		onedgecontextmenu={onEdgeContextMenu}
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

{#if edgeContextMenu}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="fixed inset-0 z-50"
		onclick={() => (edgeContextMenu = null)}
		oncontextmenu={(e) => { e.preventDefault(); edgeContextMenu = null; }}
	>
		<div
			class="absolute rounded-md border border-border bg-popover p-1 shadow-md"
			style="left: {edgeContextMenu.x}px; top: {edgeContextMenu.y}px;"
		>
			<button
				class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent"
				onclick={(e) => { e.stopPropagation(); insertNodeOnEdge(edgeContextMenu?.edgeId || ''); }}
			>
				Insert node
			</button>
			<button
				class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10"
				onclick={(e) => { e.stopPropagation(); deleteEdge(edgeContextMenu?.edgeId || ''); }}
			>
				Delete edge
			</button>
		</div>
	</div>
{/if}

<CommandPalette
	open={showCommandPalette}
	onClose={() => {
		showCommandPalette = false;
		commandPaletteReplaceNodeId = null;
		commandPaletteInsertEdgeId = null;
		commandPalettePosition = null;
	}}
	replaceNodeId={commandPaletteReplaceNodeId}
	insertOnEdgeId={commandPaletteInsertEdgeId}
	position={commandPalettePosition}
/>
