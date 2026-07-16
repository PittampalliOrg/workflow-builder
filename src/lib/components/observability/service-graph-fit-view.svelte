<script lang="ts">
	/** Re-fit only after async graph nodes have been measured. */
	import { useNodesInitialized, useSvelteFlow } from '@xyflow/svelte';

	let { fitKey }: { fitKey: string } = $props();

	const { fitView, getNodes } = useSvelteFlow();
	const nodesInitialized = useNodesInitialized();
	let lastFitKey = $state('');

	$effect(() => {
		const initialized = nodesInitialized.current;
		const key = fitKey;
		if (!initialized || !key || key === lastFitKey) return;

		let measureFrame: number | undefined;
		const layoutFrame = requestAnimationFrame(() => {
			measureFrame = requestAnimationFrame(() => {
				const nodes = getNodes().map(({ id }) => ({ id }));
				if (nodes.length === 0) return;
				lastFitKey = key;
				void fitView({
					nodes,
					padding: 0.18,
					minZoom: 0.35,
					maxZoom: 1,
					duration: 0
				});
			});
		});

		return () => {
			cancelAnimationFrame(layoutFrame);
			if (measureFrame !== undefined) cancelAnimationFrame(measureFrame);
		};
	});
</script>
