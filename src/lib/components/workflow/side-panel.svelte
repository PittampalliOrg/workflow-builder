<script lang="ts">
	/**
	 * Unified side panel — combines Properties/Code/Runs tabs like the Next.js app.
	 * Resizable via drag handle on the left edge.
	 */
	import { getContext } from 'svelte';
	import { PanelRightClose } from 'lucide-svelte';
	import { Tabs, TabsList, TabsTrigger, TabsContent } from '$lib/components/ui/tabs';
	import { buttonVariants } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import NodeConfigPanel from './node-config-panel.svelte';
	import RunsPanel from './runs-panel.svelte';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');

	// Panel width (persisted to localStorage)
	const MIN_WIDTH = 280;
	const MAX_WIDTH_PCT = 50; // max 50% of viewport
	const DEFAULT_WIDTH = 384; // 24rem

	let panelWidth = $state(loadWidth());
	let isResizing = $state(false);

	// Determine which tab set to show
	let activeTab = $derived(store.activeConfigTab);

	// Available tabs depend on whether a node is selected
	const tabs = $derived.by(() => {
		if (store.selectedNode) {
			return [
				{ id: 'properties', label: 'Properties' },
				{ id: 'code', label: 'Code' },
				{ id: 'runs', label: 'Runs' }
			];
		}
		return [
			{ id: 'runs', label: 'Runs' }
		];
	});

	// When no node is selected, force to 'runs' tab
	$effect(() => {
		if (!store.selectedNode && activeTab !== 'runs') {
			store.activeConfigTab = 'runs';
		}
	});

	function loadWidth(): number {
		if (typeof localStorage === 'undefined') return DEFAULT_WIDTH;
		const saved = localStorage.getItem('wb-panel-width');
		return saved ? Math.max(MIN_WIDTH, parseInt(saved, 10) || DEFAULT_WIDTH) : DEFAULT_WIDTH;
	}

	function saveWidth(w: number) {
		panelWidth = w;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('wb-panel-width', String(w));
		}
	}

	function closePanel() {
		store.selectedNodeId = null;
		store.showRunsPanel = false;
	}

	function setTab(tabId: string) {
		store.activeConfigTab = tabId;
	}

	// Resize drag handling
	function onResizeStart(e: PointerEvent) {
		e.preventDefault();
		isResizing = true;
		const startX = e.clientX;
		const startWidth = panelWidth;
		const maxWidth = window.innerWidth * (MAX_WIDTH_PCT / 100);

		function onMove(ev: PointerEvent) {
			const delta = startX - ev.clientX;
			const newWidth = Math.min(maxWidth, Math.max(MIN_WIDTH, startWidth + delta));
			panelWidth = Math.round(newWidth);
		}

		function onUp() {
			isResizing = false;
			saveWidth(panelWidth);
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		}

		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}
</script>

<div
	class="relative flex h-full flex-col border-l border-border bg-card"
	style="width: {panelWidth}px;"
>
	<!-- Resize handle -->
	<div
		class="absolute left-0 top-0 bottom-0 z-10 flex w-1.5 cursor-col-resize items-center justify-center hover:bg-primary/10 active:bg-primary/20 transition-colors"
		onpointerdown={onResizeStart}
		role="separator"
		aria-orientation="vertical"
		tabindex={0}
	>
		{#if isResizing}
			<div class="h-8 w-0.5 rounded-full bg-primary"></div>
		{/if}
	</div>

	<!-- Header -->
	<div class="flex h-9 items-center justify-between border-b border-border px-3">
		{#if store.selectedNode}
			<h3 class="min-w-0 truncate text-xs font-medium text-card-foreground">
				{store.selectedNode.data.label || 'Node'}
			</h3>
		{:else}
			<span class="text-xs font-medium">Workflow</span>
		{/if}

		<Tooltip.Root>
			<Tooltip.Trigger
				class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
				onclick={closePanel}
			>
				<PanelRightClose size={14} />
			</Tooltip.Trigger>
			<Tooltip.Content>Close panel</Tooltip.Content>
		</Tooltip.Root>
	</div>

	<!-- Tabbed content -->
	<Tabs bind:value={store.activeConfigTab} class="flex flex-1 flex-col overflow-hidden">
		<div class="px-2 pt-1.5 pb-1.5">
			<TabsList class="w-full h-8">
				{#each tabs as tab (tab.id)}
					<TabsTrigger
						value={tab.id}
						class="text-[11px] flex-1"
					>
						{tab.label}
					</TabsTrigger>
				{/each}
			</TabsList>
		</div>

		{#if store.selectedNode}
			<TabsContent value="properties" class="mt-0 flex-1 overflow-auto">
				<NodeConfigPanel mode="properties" />
			</TabsContent>
			<TabsContent value="code" class="mt-0 flex-1 overflow-auto">
				<NodeConfigPanel mode="code" />
			</TabsContent>
		{/if}
		<TabsContent value="runs" class="mt-0 flex-1 overflow-hidden">
			<RunsPanel embedded />
		</TabsContent>
	</Tabs>
</div>
