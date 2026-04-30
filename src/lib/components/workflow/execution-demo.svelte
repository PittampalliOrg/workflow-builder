<script lang="ts">
	/**
	 * ExecutionDemo — simulates workflow execution progress for animation testing.
	 * Rendered as a child of <SvelteFlow> so it can access the store.
	 *
	 * Walks through nodes in topological order, setting each to 'running' for a
	 * configurable duration, then 'success'. Edges between completed nodes are
	 * also marked as 'success' to trigger edge animations.
	 */
	import { Panel, useSvelteFlow } from '@xyflow/svelte';
	import { getContext } from 'svelte';
	import { Play, Square } from '@lucide/svelte';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');
	const { setCenter } = useSvelteFlow();

	let isRunning = $state(false);
	let currentNodeIndex = $state(-1);
	let stepDuration = $state(1500); // ms per node

	// Compute topological order from edges
	function getExecutionOrder(): string[] {
		const nodes = store.nodes;
		const edges = store.edges;
		const nodeIds = nodes.map((n) => n.id);

		const inDegree = new Map<string, number>();
		const adjacency = new Map<string, string[]>();

		for (const id of nodeIds) {
			inDegree.set(id, 0);
			adjacency.set(id, []);
		}

		for (const edge of edges) {
			if (inDegree.has(edge.source) && inDegree.has(edge.target)) {
				adjacency.get(edge.source)!.push(edge.target);
				inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
			}
		}

		const queue = nodeIds.filter((id) => (inDegree.get(id) || 0) === 0);
		const order: string[] = [];

		while (queue.length > 0) {
			const node = queue.shift()!;
			order.push(node);
			for (const neighbor of adjacency.get(node) || []) {
				const deg = (inDegree.get(neighbor) || 1) - 1;
				inDegree.set(neighbor, deg);
				if (deg === 0) queue.push(neighbor);
			}
		}

		// Append any unreached nodes
		for (const id of nodeIds) {
			if (!order.includes(id)) order.push(id);
		}

		return order;
	}

	function resetAllStatuses() {
		store.nodes = store.nodes.map((n) => ({
			...n,
			data: { ...n.data, status: 'idle' }
		})) as typeof store.nodes;
		store.edges = store.edges.map((e) => ({
			...e,
			data: { ...e.data, status: 'idle' }
		})) as typeof store.edges;
	}

	function setNodeStatus(nodeId: string, status: string) {
		store.nodes = store.nodes.map((n) =>
			n.id === nodeId ? { ...n, data: { ...n.data, status } } : n
		) as typeof store.nodes;
	}

	function setEdgeStatusForCompletedNode(nodeId: string) {
		// Mark outgoing edges from this node as 'running'
		store.edges = store.edges.map((e) =>
			e.source === nodeId ? { ...e, data: { ...e.data, status: 'running' } } : e
		) as typeof store.edges;

		// After a brief delay, mark incoming edges as 'success'
		setTimeout(() => {
			store.edges = store.edges.map((e) =>
				e.target === nodeId ? { ...e, data: { ...e.data, status: 'success' } } : e
			) as typeof store.edges;
		}, 200);
	}

	async function runDemo() {
		if (isRunning) return;
		isRunning = true;
		currentNodeIndex = -1;

		resetAllStatuses();

		const order = getExecutionOrder();

		for (let i = 0; i < order.length; i++) {
			if (!isRunning) break;
			currentNodeIndex = i;

			const nodeId = order[i];
			const node = store.nodes.find((n) => n.id === nodeId);

			// Smooth pan to the running node
			if (node) {
				const nodeWidth = 200;
				const nodeHeight = 60;
				setCenter(
					node.position.x + nodeWidth / 2,
					node.position.y + nodeHeight / 2,
					{ zoom: 0.85, duration: 500 }
				);
			}

			// Set current node to running
			setNodeStatus(nodeId, 'running');

			// Mark outgoing edges as running (particles!)
			store.edges = store.edges.map((e) =>
				e.source === nodeId ? { ...e, data: { ...e.data, status: 'running' } } : e
			) as typeof store.edges;

			// Wait for step duration
			await new Promise((r) => setTimeout(r, stepDuration));

			if (!isRunning) break;

			// Set current node to success
			setNodeStatus(nodeId, 'success');

			// Mark incoming edges as success, outgoing edges back to idle
			setEdgeStatusForCompletedNode(nodeId);

			// Brief pause between nodes
			await new Promise((r) => setTimeout(r, 300));
		}

		isRunning = false;
		currentNodeIndex = -1;
	}

	function stopDemo() {
		isRunning = false;
		currentNodeIndex = -1;
		resetAllStatuses();
	}
</script>

<Panel position="top-right" class="!m-2">
	<div class="flex items-center gap-1 rounded-lg border border-border bg-card/95 px-2 py-1 shadow-md backdrop-blur-sm">
		{#if !isRunning}
			<button
				onclick={runDemo}
				class="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
				title="Simulate workflow execution"
			>
				<Play size={12} />
				<span>Demo Run</span>
			</button>
		{:else}
			<button
				onclick={stopDemo}
				class="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
				title="Stop simulation"
			>
				<Square size={12} />
				<span>Stop</span>
			</button>
			<span class="px-1 text-[10px] text-muted-foreground">
				Node {currentNodeIndex + 1}/{store.nodes.length}
			</span>
		{/if}
	</div>
</Panel>
