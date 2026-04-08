<script lang="ts">
	/**
	 * ExecutionTracker — tracks live execution and updates nodes via useSvelteFlow.
	 *
	 * Uses updateNodeData() from useSvelteFlow to directly update node data
	 * rather than going through the store (which uses $state.raw and may not
	 * trigger SvelteFlow re-renders for deep property changes).
	 */
	import { useSvelteFlow } from '@xyflow/svelte';
	import { getContext } from 'svelte';
	import {
		createExecutionStream,
		createInitialExecutionStreamState,
		type ExecutionStreamStore,
		type ExecutionStreamState
	} from '$lib/stores/execution-stream.svelte';
	import type { ExecutionReadModel } from '$lib/types/execution-stream';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');
	const { setCenter, updateNodeData, getNodes } = useSvelteFlow();

	let executionStream: ExecutionStreamStore | null = null;
	let executionState = $state<ExecutionStreamState>(createInitialExecutionStreamState());
	let stopExecutionStream = () => {};
	let lastExecutionId = '';
	let lastActiveNodeId = '';

	function stepNameToNodeId(stepName: string): string | null {
		const nodes = getNodes();
		// Try exact match
		const exact = nodes.find((n) => n.id === stepName);
		if (exact) return exact.id;
		// Try with leading slash
		const slashed = nodes.find((n) => n.id === `/${stepName}`);
		if (slashed) return slashed.id;
		// Special cases
		if (stepName === 'trigger' || stepName === '__start__') {
			return nodes.find((n) => n.type === 'start')?.id ?? null;
		}
		if (stepName === '__end__') {
			return nodes.find((n) => n.type === 'end')?.id ?? null;
		}
		return null;
	}

	function setNodeStatus(nodeId: string, status: string) {
		updateNodeData(nodeId, { status });
	}

	function setEdgeStatus(targetOrSource: 'source' | 'target', nodeId: string, status: string) {
		// For edges we still need to go through the store since useSvelteFlow
		// doesn't have an updateEdgeData method
		store.edges = store.edges.map((e) =>
			e[targetOrSource] === nodeId ? { ...e, data: { ...e.data, status } } : e
		) as typeof store.edges;
	}

	function resetAllStatuses() {
		const nodes = getNodes();
		for (const node of nodes) {
			updateNodeData(node.id, { status: 'idle' });
		}
		store.edges = store.edges.map((e) => ({
			...e,
			data: { ...e.data, status: 'idle' }
		})) as typeof store.edges;
	}

	function processSnapshot(snapshot: ExecutionReadModel) {
		resetAllStatuses();

		for (const [stepName, status] of Object.entries(snapshot.nodeStatuses ?? {})) {
			const nodeId = stepNameToNodeId(stepName);
			if (!nodeId) continue;
			setNodeStatus(nodeId, status);
			if (status === 'running') {
				setEdgeStatus('target', nodeId, 'running');
			} else {
				setEdgeStatus('source', nodeId, status);
			}
		}

		// Highlight current active node
		const activeStepName = snapshot.currentNodeName || snapshot.currentNodeId;
		if (activeStepName && activeStepName !== lastActiveNodeId) {
			const activeId = stepNameToNodeId(activeStepName);
			if (activeId) {
				setNodeStatus(activeId, 'running');
				setEdgeStatus('target', activeId, 'running');

				// Center on active node
				const nodes = getNodes();
				const node = nodes.find((n) => n.id === activeId);
				if (node) {
					setCenter(node.position.x + 100, node.position.y + 30, {
						zoom: 0.85,
						duration: 500
					});
				}
			}

			lastActiveNodeId = activeStepName;
		}

		// Start node always succeeds once execution begins
		if (snapshot.status === 'running' || snapshot.status === 'success' || snapshot.status === 'error') {
			const startNode = getNodes().find((n) => n.type === 'start');
			if (startNode) setNodeStatus(startNode.id, 'success');
		}

		// Terminal state: mark end node
		if (snapshot.status === 'success') {
			const endNode = getNodes().find((n) => n.type === 'end');
			if (endNode) setNodeStatus(endNode.id, 'success');
		}
	}

	function startTracking(executionId: string) {
		stopExecutionStream();
		executionStream?.dispose();
		lastActiveNodeId = '';
		executionState = createInitialExecutionStreamState();
		resetAllStatuses();

		// Immediately set start node to running
		const startNode = getNodes().find((n) => n.type === 'start');
		if (startNode) setNodeStatus(startNode.id, 'running');
		executionStream = createExecutionStream(executionId);
		stopExecutionStream = executionStream.subscribe((state) => {
			executionState = state;
		});
	}

	// Watch for new execution
	$effect(() => {
		const execId = store.selectedExecutionId;
		if (execId && execId !== lastExecutionId) {
			lastExecutionId = execId;
			startTracking(execId);
		}
		return () => {
			stopExecutionStream();
			stopExecutionStream = () => {};
			executionStream?.dispose();
			executionStream = null;
		};
	});

	$effect(() => {
		const snapshot = executionState.snapshot;
		if (snapshot) {
			processSnapshot(snapshot);
		}
	});
</script>
