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
	import {
		createExecutionStream,
		createInitialExecutionStreamState,
		type ExecutionStreamState,
		type ExecutionStreamStore
	} from '$lib/stores/execution-stream.svelte';
	import type { ExecutionAgentRun } from '$lib/types/execution-stream';
	import { buildAgentCanvasSubflows, remapEdgesForReplacements } from '$lib/utils/agent-subflow';

	// CNCF Serverless Workflow 1.0 node types only
	import StartNode from './nodes/sw/start-node.svelte';
	import EndNode from './nodes/sw/end-node.svelte';
	import CallNode from './nodes/sw/call-node.svelte';
	import AgentNode from './nodes/sw/agent-node.svelte';
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
	import ChildWorkflowGroupNode from './nodes/child-workflow-group-node.svelte';
	import ChildWorkflowLoopNode from './nodes/child-workflow-loop-node.svelte';
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
	import AgentSubflowFocus from './execution/agent-subflow-focus.svelte';

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
		agent: AgentNode,
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
		default: DefaultNode,
		childWorkflowGroup: ChildWorkflowGroupNode,
		childWorkflowLoop: ChildWorkflowLoopNode
	} satisfies NodeTypes;

	const edgeTypes: EdgeTypes = {
		default: AnimatedEdge,
		animated: AnimatedEdge,
		labeled: LabeledEdge
	} satisfies EdgeTypes;

	// Context menu state
	let contextMenu = $state<{ x: number; y: number; nodeId: string | null } | null>(null);
	let edgeContextMenu = $state<{ x: number; y: number; edgeId: string } | null>(null);
	let executionState = $state<ExecutionStreamState>(createInitialExecutionStreamState());
	let selectedAgentRunId = $state<string | null>(null);
	let expandedAgentRunId = $state<string | null>(null);
	let canvasNodes = $state.raw<Node[]>([]);
	let canvasEdges = $state.raw<Edge[]>([]);
	let executionStream: ExecutionStreamStore | null = null;
	let stopExecutionStream = () => {};
	let lastExecutionId = '';
	let lastExecutionLookupWorkflowId = '';
	let autoExecutionId = $state<string | null>(null);

	// Insert-on-edge: pending edge ID for inserting a node
	let insertOnEdgeId = $state<string | null>(null);
	let insertOnEdgePosition = $state<{ x: number; y: number } | null>(null);

	const agentRuns = $derived(
		(executionState.snapshot?.agentRuns as ExecutionAgentRun[] | undefined) ?? []
	);
	const runningAgentRun = $derived.by(
		() => agentRuns.find((run) => run.status === 'running') ?? null
	);
	const agentCanvasSubflows = $derived.by(() =>
		buildAgentCanvasSubflows(store.nodes, agentRuns, executionState.events, expandedAgentRunId)
	);
	const selectedAgentGroupNodeId = $derived.by(() =>
		expandedAgentRunId ? `agent-group:${expandedAgentRunId}` : null
	);
	const selectedAgentParentNodeId = $derived.by(
		() => agentRuns.find((run) => run.id === expandedAgentRunId)?.nodeId ?? null
	);
	const activeExecutionId = $derived(store.selectedExecutionId ?? autoExecutionId);

	function isChildWorkflowNode(node: Node | null | undefined): boolean {
		if (!node) return false;
		return (
			node.type === 'childWorkflowLoop' ||
			node.id.startsWith('agent-loop:')
		);
	}

	function isChildWorkflowEdge(edge: Edge | null | undefined): boolean {
		if (!edge) return false;
		return (
			edge.id.startsWith('agent:') ||
			edge.source.startsWith('agent:') ||
			edge.target.startsWith('agent:') ||
			edge.source.startsWith('agent-group:') ||
			edge.target.startsWith('agent-group:')
		);
	}

	function syncCanvasFromStore() {
		const hidden = agentCanvasSubflows.replacedNodeIds;
		const visible = hidden.size > 0 ? store.nodes.filter((n) => !hidden.has(n.id)) : store.nodes;
		canvasNodes = [...visible, ...agentCanvasSubflows.nodes];
		canvasEdges = [...remapEdgesForReplacements(store.edges, hidden, agentRuns, store.nodes), ...agentCanvasSubflows.edges];
	}

	function syncStoreNodesFromCanvas() {
		store.nodes = canvasNodes.filter((node) => !isChildWorkflowNode(node)) as typeof store.nodes;
	}

	function startExecutionOverlay(executionId: string) {
		stopExecutionStream();
		stopExecutionStream = () => {};
		executionStream?.dispose();
		executionState = createInitialExecutionStreamState();

		void fetch(`/api/workflows/executions/${executionId}/status`)
			.then((response) => (response.ok ? response.json() : null))
			.then((snapshot) => {
				if (!snapshot || store.selectedExecutionId !== executionId) return;
				executionState = {
					...executionState,
					snapshot,
					events: Array.isArray(snapshot.agentEvents) ? snapshot.agentEvents : executionState.events
				};
			})
			.catch((error) => {
				console.warn('[WorkflowCanvas] Failed to load execution snapshot', error);
			});

		executionStream = createExecutionStream(executionId);
		stopExecutionStream = executionStream.subscribe((state) => {
			executionState = state;
		});
	}

	async function ensureSelectedExecution(workflowId: string) {
		try {
			const response = await fetch(`/api/workflows/${workflowId}/executions`);
			if (!response.ok) return;
			const executions = (await response.json()) as Array<{ id: string; status: string }>;
			const preferred = executions.find((execution) =>
				['running', 'pending'].includes(execution.status?.toLowerCase?.() ?? '')
			) ?? executions[0];
			if (preferred) {
				autoExecutionId = preferred.id;
				if (!store.selectedExecutionId) {
					store.selectedExecutionId = preferred.id;
				}
			}
		} catch (error) {
			console.warn('[WorkflowCanvas] Failed to auto-select execution', error);
		}
	}

	$effect(() => {
		if (!agentRuns.length) {
			selectedAgentRunId = null;
			expandedAgentRunId = null;
		} else if (runningAgentRun) {
			selectedAgentRunId = runningAgentRun.id;
			expandedAgentRunId = runningAgentRun.id;
		} else if (selectedAgentRunId && !agentRuns.some((run) => run.id === selectedAgentRunId)) {
			selectedAgentRunId = null;
		}

		if (expandedAgentRunId && !agentRuns.some((run) => run.id === expandedAgentRunId)) {
			expandedAgentRunId = null;
		}
	});

	$effect(() => {
		const baseNodes = store.nodes;
		const baseEdges = store.edges;
		const subflowNodes = agentCanvasSubflows.nodes;
		const subflowEdges = agentCanvasSubflows.edges;
		const hidden = agentCanvasSubflows.replacedNodeIds;
		const visible = hidden.size > 0 ? baseNodes.filter((n) => !hidden.has(n.id)) : baseNodes;
		canvasNodes = [...visible, ...subflowNodes];
		canvasEdges = [...remapEdgesForReplacements(baseEdges, hidden, agentRuns, baseNodes), ...subflowEdges];
	});

	$effect(() => {
		const execId = activeExecutionId;
		if (execId && execId !== lastExecutionId) {
			lastExecutionId = execId;
			startExecutionOverlay(execId);
		}

		if (!execId) {
			lastExecutionId = '';
			stopExecutionStream();
			stopExecutionStream = () => {};
			executionStream?.dispose();
			executionStream = null;
			executionState = createInitialExecutionStreamState();
		}

		return () => {
			stopExecutionStream();
			stopExecutionStream = () => {};
			executionStream?.dispose();
			executionStream = null;
		};
	});

	$effect(() => {
		const workflowId = store.workflowId;
		if (!workflowId || activeExecutionId || workflowId === lastExecutionLookupWorkflowId) return;
		lastExecutionLookupWorkflowId = workflowId;
		void ensureSelectedExecution(workflowId);
	});

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
		if (isChildWorkflowNode(node)) {
			const runId =
				typeof (node.data as Record<string, unknown> | undefined)?.agentRunId === 'string'
					? ((node.data as Record<string, unknown>).agentRunId as string)
					: null;
			if (runId) {
				selectedAgentRunId = runId;
				expandedAgentRunId = expandedAgentRunId === runId ? null : runId;
			}
			return;
		}
		store.selectedNodeId = node.id;
		store.selectedEdgeId = null;
		const matchingRun = agentRuns.find((run) => run.nodeId === node.id);
		if (matchingRun) {
			selectedAgentRunId = matchingRun.id;
			expandedAgentRunId = expandedAgentRunId === matchingRun.id ? null : matchingRun.id;
		}
	}

	function onNodeDoubleClick({ node }: { node: Node; event: MouseEvent }) {
		if (isChildWorkflowNode(node)) return;
		// Double-click opens config panel
		store.selectedNodeId = node.id;
		ui.openRightPanel('properties');
	}

	function onNodeContextMenu({ node, event }: { node: Node; event: MouseEvent }) {
		if (isChildWorkflowNode(node)) return;
		event.preventDefault();
		contextMenu = { x: event.clientX, y: event.clientY, nodeId: node.id };
	}

	function onEdgeClick({ edge }: { edge: Edge; event: MouseEvent }) {
		if (isChildWorkflowEdge(edge)) return;
		store.selectedEdgeId = edge.id;
		store.selectedNodeId = null;
	}

	function onEdgeContextMenu({ edge, event }: { edge: Edge; event: MouseEvent }) {
		if (isChildWorkflowEdge(edge)) return;
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

	// Double-click detection for pane
	let lastPaneClickTime = 0;

	function onPaneClick({ event }: { event: MouseEvent }) {
		store.selectedNodeId = null;
		store.selectedEdgeId = null;
		contextMenu = null;
		edgeContextMenu = null;

		// Detect double-click (within 400ms)
		const now = Date.now();
		if (now - lastPaneClickTime < 400) {
			// Open command palette — position will default to center of nodes
			commandPaletteReplaceNodeId = null;
			commandPaletteInsertEdgeId = null;
			commandPalettePosition = null;
			showCommandPalette = true;
			lastPaneClickTime = 0;
		} else {
			lastPaneClickTime = now;
		}
	}

	function onNodeDragStop() {
		syncStoreNodesFromCanvas();
		store.isDirty = true;
	}

</script>

<div class="h-full w-full">
	<SvelteFlow
		bind:nodes={canvasNodes}
		bind:edges={canvasEdges}
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
		<AgentSubflowFocus
			parentNodeId={selectedAgentParentNodeId}
			groupNodeId={selectedAgentGroupNodeId}
			enabled={Boolean(activeExecutionId)}
		/>
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

<style>
	:global(.svelte-flow__node.agent-subflow-group) {
		border: 2px solid color-mix(in oklab, var(--primary) 28%, var(--border));
		border-radius: 24px;
		background:
			linear-gradient(180deg, color-mix(in oklab, var(--primary) 10%, transparent), transparent 72%),
			color-mix(in oklab, var(--card) 96%, white 4%);
		box-shadow:
			0 18px 42px color-mix(in oklab, var(--primary) 12%, transparent),
			0 2px 0 color-mix(in oklab, var(--background) 86%, transparent) inset;
	}

	:global(.svelte-flow__node.agent-subflow-group.agent-subflow-group-selected) {
		border-color: color-mix(in oklab, var(--primary) 70%, white 30%);
		box-shadow:
			0 0 0 3px color-mix(in oklab, var(--primary) 22%, transparent),
			0 18px 42px color-mix(in oklab, var(--primary) 18%, transparent);
	}
</style>

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
