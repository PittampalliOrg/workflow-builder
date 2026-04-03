<script lang="ts">
	/**
	 * AutoLayout — child of <SvelteFlow> for auto-arranging nodes.
	 *
	 * Provides:
	 * - Algorithm selector (ELK / Dagre)
	 * - "Auto Arrange" button that applies the selected layout
	 * - Auto-layout on first load if nodes are all at (0,0) or overlapping
	 * - Direction toggle (LR vs TB)
	 */
	import { Panel, useSvelteFlow } from '@xyflow/svelte';
	import { getContext } from 'svelte';
	import { AlignHorizontalSpaceAround, ArrowDownUp, ArrowRightLeft, Loader2 } from 'lucide-svelte';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import { layoutWorkflowNodes, type DagreLayoutOptions } from '$lib/utils/layout/dagre-layout';
	import { layoutElkWorkflowNodes } from '$lib/utils/layout/elk-layout';
	import { LAYOUT_ALGORITHMS, type LayoutAlgorithm } from '$lib/utils/layout';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');
	const { fitView } = useSvelteFlow();

	// TB (top-to-bottom) is default — matches handle positions (top=target, bottom=source)
	let direction: 'LR' | 'TB' = $state('TB');
	let algorithm: LayoutAlgorithm = $state('elk');
	let isLayouting = $state(false);

	async function autoLayout() {
		if (store.nodes.length === 0 || isLayouting) return;

		store.pushHistory();
		isLayouting = true;

		try {
			if (algorithm === 'elk') {
				const layoutedNodes = await layoutElkWorkflowNodes(store.nodes, store.edges, {
					direction,
					nodeWidth: 148,
					nodeHeight: 148,
					rankSep: direction === 'TB' ? 60 : 80,
					nodeSep: direction === 'TB' ? 40 : 60
				});
				store.nodes = layoutedNodes as typeof store.nodes;
			} else {
				const options: DagreLayoutOptions = {
					direction,
					nodeWidth: 148,
					nodeHeight: 148,
					rankSep: direction === 'TB' ? 60 : 80,
					nodeSep: direction === 'TB' ? 40 : 60,
					strategy: 'auto'
				};
				const layoutedNodes = layoutWorkflowNodes(store.nodes, store.edges, options);
				store.nodes = layoutedNodes as typeof store.nodes;
			}

			store.isDirty = true;

			// Fit the new layout after a brief delay for DOM update
			requestAnimationFrame(() => {
				fitView({ padding: 0.3, maxZoom: 1, duration: 300 });
			});
		} catch (err) {
			console.error('Auto layout failed:', err);
		} finally {
			isLayouting = false;
		}
	}

	function toggleDirection() {
		direction = direction === 'LR' ? 'TB' : 'LR';
		autoLayout();
	}

	function selectAlgorithm(alg: LayoutAlgorithm) {
		algorithm = alg;
		autoLayout();
	}

	// Auto-layout on first load if nodes need rearranging
	let hasAutoLayouted = false;

	$effect(() => {
		if (hasAutoLayouted || store.nodes.length < 2) return;

		const positions = store.nodes.map((n) => n.position);
		const allAtOrigin = positions.every((p) => p.x === 0 && p.y === 0);

		const minX = Math.min(...positions.map((p) => p.x));
		const maxX = Math.max(...positions.map((p) => p.x));
		const minY = Math.min(...positions.map((p) => p.y));
		const maxY = Math.max(...positions.map((p) => p.y));
		const width = maxX - minX;
		const height = maxY - minY || 1;
		const aspectRatio = width / height;
		const isExtremelyWide = aspectRatio > 5;

		if (allAtOrigin || isExtremelyWide) {
			hasAutoLayouted = true;
			if (isExtremelyWide) direction = 'TB';
			requestAnimationFrame(() => autoLayout());
		}
	});
</script>

<Panel position="bottom-center" class="!mb-2">
	<div class="flex items-center gap-1 rounded-lg border border-border bg-card/95 px-2 py-1 shadow-md backdrop-blur-sm">
		<!-- Algorithm selector -->
		{#each LAYOUT_ALGORITHMS as alg (alg.id)}
			<button
				onclick={() => selectAlgorithm(alg.id)}
				class="rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-colors {algorithm === alg.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'}"
				title={alg.description}
			>
				{alg.label}
			</button>
		{/each}

		<div class="h-4 w-px bg-border"></div>

		<!-- Auto Arrange button -->
		<button
			onclick={autoLayout}
			disabled={isLayouting}
			class="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
			title="Auto arrange nodes"
		>
			{#if isLayouting}
				<Loader2 size={14} class="animate-spin" />
			{:else}
				<AlignHorizontalSpaceAround size={14} />
			{/if}
			<span>Auto Arrange</span>
		</button>

		<div class="h-4 w-px bg-border"></div>

		<!-- Direction toggle -->
		<button
			onclick={toggleDirection}
			class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
			title="Toggle layout direction ({direction === 'LR' ? 'Left to Right' : 'Top to Bottom'})"
		>
			{#if direction === 'LR'}
				<ArrowRightLeft size={12} />
				<span>LR</span>
			{:else}
				<ArrowDownUp size={12} />
				<span>TB</span>
			{/if}
		</button>
	</div>
</Panel>
