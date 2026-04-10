<script lang="ts">
	import { useNodesInitialized, useSvelteFlow } from '@xyflow/svelte';

	interface Props {
		parentNodeId: string | null;
		groupNodeId: string | null;
		enabled?: boolean;
	}

	let { parentNodeId, groupNodeId, enabled = true }: Props = $props();

	const { getNodes, fitView, getViewport, setCenter } = useSvelteFlow();
	const nodesInitialized = useNodesInitialized();

	let lastFocusKey = $state<string | null>(null);

	function focusSelection() {
		if (!enabled || !parentNodeId || !groupNodeId) return;

		const allNodes = getNodes();
		const parentNode = allNodes.find((node) => node.id === parentNodeId);
		const groupNode = allNodes.find((node) => node.id === groupNodeId);
		if (!parentNode || !groupNode) return;

		const key = `${parentNodeId}:${groupNodeId}`;
		if (key === lastFocusKey) return;

		const targetNodes = [parentNode, groupNode];
		fitView({
			nodes: targetNodes,
			padding: 0.28,
			duration: 350,
			maxZoom: 0.9
		});

		queueMicrotask(() => {
			const viewport = getViewport();
			if (viewport.zoom >= 0.42) return;

			const parentWidth = parentNode.measured?.width ?? parentNode.width ?? 220;
			const parentHeight = parentNode.measured?.height ?? parentNode.height ?? 96;
			const groupWidth = groupNode.measured?.width ?? groupNode.width ?? 420;
			const groupHeight = groupNode.measured?.height ?? groupNode.height ?? 220;
			const left = Math.min(parentNode.position.x, groupNode.position.x);
			const right = Math.max(parentNode.position.x + parentWidth, groupNode.position.x + groupWidth);
			const top = Math.min(parentNode.position.y, groupNode.position.y);
			const bottom = Math.max(parentNode.position.y + parentHeight, groupNode.position.y + groupHeight);

			setCenter((left + right) / 2, (top + bottom) / 2, {
				zoom: 0.42,
				duration: 350
			});
		});

		lastFocusKey = key;
	}

	$effect(() => {
		if (!nodesInitialized) return;
		focusSelection();
	});
</script>
