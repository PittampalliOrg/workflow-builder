<script lang="ts">
	/**
	 * Child of <SvelteFlow> that manages viewport fitting (ported from Kargo):
	 *  - fits the whole graph once nodes are measured, and re-fits when the active
	 *    pipeline filter changes (fixes the race where a fit fires before dagre
	 *    repopulates);
	 *  - centres on stage-search matches (debounced), and re-fits all when the
	 *    search is cleared.
	 * Subscription nodes are excluded from the fit so the view centres on
	 * warehouses + stages.
	 */
	import { untrack } from "svelte";
	import { useNodesInitialized, useSvelteFlow } from "@xyflow/svelte";

	type Props = { fitKey: string; focusKey?: string; focusNodeIds?: string[] };
	let { fitKey, focusKey = "", focusNodeIds = [] }: Props = $props();

	const { fitView, getNodes } = useSvelteFlow();
	const nodesInitialized = useNodesInitialized();

	function fitAll() {
		const target = getNodes()
			.filter((n) => !n.id.startsWith("subscription/"))
			.map((n) => ({ id: n.id }));
		void fitView({ padding: 0.2, duration: 300, maxZoom: 1.2, nodes: target.length ? target : undefined });
	}

	// Base fit: re-fit the whole graph when the active pipeline filter changes.
	let lastKey = $state<string | null>(null);
	$effect(() => {
		const initialized = nodesInitialized;
		const key = fitKey;
		if (!initialized || key === lastKey) return;
		lastKey = key;
		const raf = requestAnimationFrame(fitAll);
		return () => cancelAnimationFrame(raf);
	});

	// Focus fit: centre on stage-search matches (debounced), re-fit all on clear.
	// Seed with the initial focusKey so the focus effect doesn't fire on mount.
	let lastFocus = $state<string | null>(untrack(() => focusKey));
	$effect(() => {
		const initialized = nodesInitialized;
		const fk = focusKey;
		const ids = focusNodeIds;
		if (!initialized || fk === lastFocus) return;
		lastFocus = fk;
		const timer = setTimeout(() => {
			if (!fk || ids.length === 0) {
				fitAll();
			} else {
				void fitView({ nodes: ids.map((id) => ({ id })), padding: 0.3, duration: 400, maxZoom: 1 });
			}
		}, 250);
		return () => clearTimeout(timer);
	});
</script>
