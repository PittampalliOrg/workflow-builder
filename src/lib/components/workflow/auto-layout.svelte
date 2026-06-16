<script lang="ts">
	import { Panel, useSvelteFlow } from '@xyflow/svelte';
	import { getContext } from 'svelte';
	import { toast } from 'svelte-sonner';
	import {
		AlignHorizontalSpaceAround,
		ArrowDownUp,
		ArrowRightLeft,
		Loader2,
		Maximize,
		Minus,
		Plus,
		Sparkles
	} from '@lucide/svelte';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import {
		DEFAULT_LAYOUT_CONFIG,
		LAYOUT_PRESETS,
		createLayoutConfig,
		getWorkflowNodeBounds,
		layoutWorkflowGraph,
		shouldAutoLayoutGraph,
		suggestLayoutConfig,
		type LayoutPreset
	} from '$lib/utils/layout';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');
	const { fitView, setCenter, getNodes } = useSvelteFlow();

	const SPACING_STEP = 12;
	const MIN_SPACING = 24;
	const MAX_SPACING = 180;

	let isLayouting = $state(false);
	let hasAutoLayouted = $state(false);

	function clampSpacing(value: number) {
		return Math.max(MIN_SPACING, Math.min(MAX_SPACING, value));
	}

	async function focusAfterLayout() {
		const config = store.layoutConfig;
		if (config.fitMode === 'preserve') return;

		if (config.fitMode === 'all') {
			fitView({ padding: 0.28, maxZoom: 1, duration: 260 });
			return;
		}

		const nodes = getNodes();
		if (nodes.length === 0) return;
		const bounds = getWorkflowNodeBounds(nodes);
		if (!bounds) return;

		const focusX =
			config.direction === 'TB'
				? bounds.minX + bounds.width * 0.42
				: bounds.centerX;
		const focusY =
			config.direction === 'TB'
				? bounds.centerY
				: bounds.minY + bounds.height * 0.42;

		setCenter(focusX, focusY, {
			zoom: 0.74,
			duration: 260
		});
	}

	async function autoLayout(options: { suggested?: boolean } = {}) {
		if (store.nodes.length === 0 || isLayouting) return;

		store.pushHistory();
		isLayouting = true;

		try {
			const layoutConfig =
				options.suggested && !store.layoutConfigTouched
					? suggestLayoutConfig(store.nodes, store.edges, store.layoutConfig)
					: createLayoutConfig(store.layoutConfig, store.layoutConfig);

			if (options.suggested && !store.layoutConfigTouched) {
				store.setLayoutConfig(layoutConfig, { touched: false });
			}

			const layoutedNodes = await layoutWorkflowGraph(store.nodes, store.edges, layoutConfig);
			store.nodes = layoutedNodes as typeof store.nodes;
			store.isDirty = true;

			requestAnimationFrame(() => {
				void focusAfterLayout();
			});
		} catch (err) {
			console.error('Auto layout failed:', err);
		} finally {
			isLayouting = false;
		}
	}

	/**
	 * "Reset layout" — the one-click escape hatch when the canvas looks wrong.
	 * Unlike Arrange (which re-runs the CURRENT settings), Reset re-picks the best
	 * preset for the graph's shape, re-arranges, and fits everything in view. It's
	 * fully undoable (history + an Undo toast action) so it's safe to try.
	 */
	async function resetLayout() {
		if (store.nodes.length === 0 || isLayouting) return;

		store.pushHistory();
		isLayouting = true;
		try {
			const suggested = suggestLayoutConfig(store.nodes, store.edges, DEFAULT_LAYOUT_CONFIG);
			store.setLayoutConfig(suggested, { touched: false });

			const layoutedNodes = await layoutWorkflowGraph(store.nodes, store.edges, suggested);
			store.nodes = layoutedNodes as typeof store.nodes;
			store.isDirty = true;

			requestAnimationFrame(() => {
				fitView({ padding: 0.22, maxZoom: 1, duration: 320 });
			});

			const presetLabel =
				LAYOUT_PRESETS.find((p) => p.id === suggested.preset)?.label ?? suggested.preset;
			toast.success('Layout reset', {
				description: `Auto-arranged with the ${presetLabel} preset.`,
				action: {
					label: 'Undo',
					onClick: () => {
						store.undo();
						requestAnimationFrame(() => fitView({ padding: 0.22, maxZoom: 1, duration: 240 }));
					}
				}
			});
		} catch (err) {
			console.error('Reset layout failed:', err);
			toast.error('Could not reset the layout');
		} finally {
			isLayouting = false;
		}
	}

	function fitToView() {
		if (store.nodes.length === 0) return;
		fitView({ padding: 0.2, maxZoom: 1.1, duration: 280 });
	}

	function applyPreset(preset: LayoutPreset) {
		const presetConfig = LAYOUT_PRESETS.find((candidate) => candidate.id === preset)?.config;
		if (!presetConfig) return;
		store.setLayoutConfig(presetConfig);
		void autoLayout();
	}

	function toggleDirection() {
		store.setLayoutConfig({
			direction: store.layoutConfig.direction === 'LR' ? 'TB' : 'LR'
		});
		void autoLayout();
	}

	function updateSpacing(kind: 'nodeSpacing' | 'layerSpacing', delta: number) {
		store.setLayoutConfig({
			[kind]: clampSpacing(store.layoutConfig[kind] + delta)
		});
		void autoLayout();
	}

	$effect(() => {
		if (hasAutoLayouted || store.nodes.length < 2) return;
		if (!shouldAutoLayoutGraph(store.nodes, store.edges)) return;

		hasAutoLayouted = true;
		requestAnimationFrame(() => {
			void autoLayout({ suggested: true });
		});
	});
</script>

<Panel position="bottom-center" class="!mb-2">
	<div class="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card/95 px-3 py-2 shadow-md backdrop-blur-sm">
		<div class="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
			{#each LAYOUT_PRESETS as preset (preset.id)}
				<button
					type="button"
					onclick={() => applyPreset(preset.id)}
					class="rounded-md px-2 py-1 text-[10px] font-medium transition-colors {store.layoutConfig.preset === preset.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'}"
					title={preset.description}
				>
					{preset.label}
				</button>
			{/each}
		</div>

		<div class="h-5 w-px bg-border"></div>

		<button
			type="button"
			onclick={() => void autoLayout()}
			disabled={isLayouting}
			class="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
			title="Auto arrange nodes"
		>
			{#if isLayouting}
				<Loader2 size={14} class="animate-spin" />
			{:else}
				<AlignHorizontalSpaceAround size={14} />
			{/if}
			Arrange
		</button>

		<button
			type="button"
			onclick={resetLayout}
			disabled={isLayouting}
			class="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
			title="Reset to the best auto layout for this workflow and fit it in view (undoable)"
		>
			<Sparkles size={14} />
			Reset
		</button>

		<button
			type="button"
			onclick={toggleDirection}
			class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
			title="Toggle layout direction"
		>
			{#if store.layoutConfig.direction === 'LR'}
				<ArrowRightLeft size={12} />
				LR
			{:else}
				<ArrowDownUp size={12} />
				TB
			{/if}
		</button>

		<div class="h-5 w-px bg-border"></div>

		<div class="flex items-center gap-1 text-[11px] text-muted-foreground">
			<span class="uppercase tracking-wide">Node gap</span>
			<button
				type="button"
				onclick={() => updateSpacing('nodeSpacing', -SPACING_STEP)}
				class="rounded-md border border-border p-1 hover:bg-accent hover:text-accent-foreground"
				aria-label="Reduce node spacing"
			>
				<Minus size={12} />
			</button>
			<span class="w-8 text-center font-medium text-foreground">{store.layoutConfig.nodeSpacing}</span>
			<button
				type="button"
				onclick={() => updateSpacing('nodeSpacing', SPACING_STEP)}
				class="rounded-md border border-border p-1 hover:bg-accent hover:text-accent-foreground"
				aria-label="Increase node spacing"
			>
				<Plus size={12} />
			</button>
		</div>

		<div class="flex items-center gap-1 text-[11px] text-muted-foreground">
			<span class="uppercase tracking-wide">Layer gap</span>
			<button
				type="button"
				onclick={() => updateSpacing('layerSpacing', -SPACING_STEP)}
				class="rounded-md border border-border p-1 hover:bg-accent hover:text-accent-foreground"
				aria-label="Reduce layer spacing"
			>
				<Minus size={12} />
			</button>
			<span class="w-8 text-center font-medium text-foreground">{store.layoutConfig.layerSpacing}</span>
			<button
				type="button"
				onclick={() => updateSpacing('layerSpacing', SPACING_STEP)}
				class="rounded-md border border-border p-1 hover:bg-accent hover:text-accent-foreground"
				aria-label="Increase layer spacing"
			>
				<Plus size={12} />
			</button>
		</div>

		<div class="h-5 w-px bg-border"></div>

		<button
			type="button"
			onclick={fitToView}
			class="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
			title="Fit all nodes in view"
		>
			<Maximize size={14} />
			Fit
		</button>
	</div>
</Panel>
