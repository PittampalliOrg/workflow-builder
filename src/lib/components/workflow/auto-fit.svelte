<script lang="ts">
	/**
	 * AutoFit — child of <SvelteFlow> that manages intelligent viewport positioning.
	 *
	 * Strategy: Instead of fitting ALL nodes (which over-zooms on wide layouts),
	 * we use a "smart start" approach:
	 * 1. Find the start node (or first node)
	 * 2. Center on it at a comfortable zoom level (0.65–0.8)
	 * 3. If the workflow is small (< 8 nodes), fit all nodes
	 * 4. Provide explicit "Fit All" via Ctrl+/ or button
	 */
	import { useSvelteFlow, useNodesInitialized } from '@xyflow/svelte';
	import { getContext, onMount } from 'svelte';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import { getWorkflowNodeBounds } from '$lib/utils/layout';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');
	const { fitView, setCenter, getNodes } = useSvelteFlow();
	const nodesInitialized = useNodesInitialized();

	// Comfortable zoom for reading node labels
	const COMFORTABLE_ZOOM = 0.7;

	// Small workflow threshold — below this, fit all nodes
	const SMALL_WORKFLOW_THRESHOLD = 8;

	// Aspect ratio threshold — workflows wider than this are "too horizontal" to fit-all
	const MAX_FIT_ASPECT_RATIO = 4;

	let hasInitialFit = false;
	let lastWorkflowId = '';

	function smartInitialView() {
		const nodes = store.nodes;
		if (nodes.length === 0) return;
		const bounds = getWorkflowNodeBounds(nodes);
		if (!bounds) return;

		const aspectRatio = bounds.width / bounds.height;

		// Small workflows: fit all nodes comfortably
		if (nodes.length <= SMALL_WORKFLOW_THRESHOLD && aspectRatio <= MAX_FIT_ASPECT_RATIO) {
			fitView({
				padding: 0.4,
				maxZoom: 1,
				minZoom: 0.5,
				duration: 0
			});
			return;
		}

		// Large or wide workflows: center on start node at comfortable zoom
		const direction = store.layoutConfig.direction;
		const focusX =
			direction === 'TB'
				? bounds.minX + bounds.width * 0.42
				: bounds.centerX;
		const focusY =
			direction === 'TB'
				? bounds.centerY
				: bounds.minY + bounds.height * 0.42;

		setCenter(focusX, focusY, { zoom: COMFORTABLE_ZOOM, duration: 0 });
	}

	// Auto-position when nodes are first initialized
	$effect(() => {
		const initialized = nodesInitialized;
		const wfId = store.workflowId;
		const nodeCount = store.nodes.length;

		if (!initialized || nodeCount === 0) return;

		if (!hasInitialFit || (wfId && wfId !== lastWorkflowId)) {
			requestAnimationFrame(() => {
				setTimeout(() => {
					smartInitialView();
					hasInitialFit = true;
					if (wfId) lastWorkflowId = wfId;
				}, 50);
			});
		}
	});

	// Safety net on mount
	onMount(() => {
		if (store.nodes.length > 0) {
			setTimeout(() => {
				if (!hasInitialFit) {
					smartInitialView();
					hasInitialFit = true;
				}
			}, 200);
		}
	});
</script>

<!-- Invisible component — only provides auto-fit behavior -->
