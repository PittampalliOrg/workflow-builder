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
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');
	const { setCenter, updateNodeData, getNodes } = useSvelteFlow();

	let pollInterval: ReturnType<typeof setInterval> | null = null;
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

	function processStatusResponse(data: Record<string, unknown>) {
		const status = data.status as string | undefined;
		const currentNodeName = data.currentNodeName as string | null;
		const currentNodeIdVal = data.currentNodeId as string | null;

		// Process completed step outputs
		const outputs =
			(data.outputs as Record<string, Record<string, unknown>> | undefined) ??
			((data.output as Record<string, unknown>)?.outputs as Record<string, Record<string, unknown>> | undefined);

		if (outputs) {
			for (const [stepName, stepOutput] of Object.entries(outputs)) {
				const nodeId = stepNameToNodeId(stepName);
				if (!nodeId) continue;

				const stepData = stepOutput.data as Record<string, unknown> | undefined;
				if (!stepData) continue;

				const success = stepData.success;
				const hasError = stepData.error;

				if (hasError || success === false) {
					setNodeStatus(nodeId, 'error');
					setEdgeStatus('source', nodeId, 'error');
				} else if (success === true || Object.keys(stepData).length > 0) {
					setNodeStatus(nodeId, 'success');
					setEdgeStatus('source', nodeId, 'success');
				}
			}
		}

		// Highlight current active node
		const activeStepName = currentNodeName || currentNodeIdVal;
		if (activeStepName && activeStepName !== lastActiveNodeId) {
			// Clear previous active node's running status (it completed)
			if (lastActiveNodeId) {
				const prevId = stepNameToNodeId(lastActiveNodeId);
				if (prevId) {
					setNodeStatus(prevId, 'success');
					setEdgeStatus('source', prevId, 'success');
				}
			}

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
		if (status === 'running' || status === 'success' || status === 'error') {
			const startNode = getNodes().find((n) => n.type === 'start');
			if (startNode) setNodeStatus(startNode.id, 'success');
		}

		// Terminal state: mark end node
		if (status === 'success') {
			const endNode = getNodes().find((n) => n.type === 'end');
			if (endNode) setNodeStatus(endNode.id, 'success');
		}
	}

	async function pollStatus(executionId: string) {
		try {
			const res = await fetch(`/api/workflows/executions/${executionId}/status`);
			if (!res.ok) return;

			const data = await res.json();
			processStatusResponse(data);

			// Terminal?
			const status = data.status as string;
			if (status === 'success' || status === 'error' || status === 'cancelled') {
				stopTracking();
				// Final update from output
				if (data.output) {
					processStatusResponse(data.output);
				}
			}
		} catch {
			// ignore
		}
	}

	function startTracking(executionId: string) {
		stopTracking();
		lastActiveNodeId = '';
		resetAllStatuses();

		// Immediately set start node to running
		const startNode = getNodes().find((n) => n.type === 'start');
		if (startNode) setNodeStatus(startNode.id, 'running');

		// First poll immediately, then every 2s
		pollStatus(executionId);
		pollInterval = setInterval(() => pollStatus(executionId), 2000);
	}

	function stopTracking() {
		if (pollInterval) {
			clearInterval(pollInterval);
			pollInterval = null;
		}
	}

	// Watch for new execution
	$effect(() => {
		const execId = store.selectedExecutionId;
		if (execId && execId !== lastExecutionId) {
			lastExecutionId = execId;
			startTracking(execId);
		}
	});

	$effect(() => {
		return () => stopTracking();
	});
</script>
