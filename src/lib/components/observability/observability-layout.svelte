<script lang="ts">
	/**
	 * Two-panel layout shell for the observability tracing UI.
	 *
	 * +-------------------------------+----------------------+
	 * |      MAIN AREA                |    RIGHT DETAIL      |
	 * |      (flex-1)                 |    (resizable)       |
	 * |  Toolbar + content tabs       |    Detail tabs       |
	 * |  (Turns / Waterfall / Logs)   |    (Overview/Conv/   |
	 * |                               |     LLM/Tools/Raw)   |
	 * +-------------------------------+----------------------+
	 */
	import { getContext } from 'svelte';
	import type { ObservabilitySelectionStore } from '$lib/stores/observability-selection.svelte';
	import type { Snippet } from 'svelte';

	interface Props {
		mainToolbar: Snippet;
		mainContent: Snippet;
		bottomDock?: Snippet;
		rightPanel: Snippet;
	}

	let { mainToolbar, mainContent, bottomDock, rightPanel }: Props = $props();

	const store = getContext<ObservabilitySelectionStore>('observability-selection');
	const panelWidth = $derived(store.detailPanelWidth);
	const dockCollapsed = $derived(store.logDockCollapsed);
	const dockHeight = $derived(store.logDockHeight);

	// --- Right panel resize ---
	const MIN_WIDTH = 320;
	const MAX_WIDTH = 900;
	const DEFAULT_WIDTH = 420;

	let isResizing = $state(false);
	let startX = $state(0);
	let startWidth = $state(DEFAULT_WIDTH);

	function onResizeStart(e: MouseEvent) {
		isResizing = true;
		startX = e.clientX;
		startWidth = panelWidth;
		e.preventDefault();
	}

	function onResizeMove(e: MouseEvent) {
		if (!isResizing) return;
		const delta = startX - e.clientX;
		const newWidth = Math.max(MIN_WIDTH, Math.min(startWidth + delta, MAX_WIDTH));
		store.setDetailPanelWidth(newWidth);
	}

	function onResizeEnd() {
		isResizing = false;
	}

	function onResizeHandleDblClick() {
		if (panelWidth > DEFAULT_WIDTH + 50) {
			store.setDetailPanelWidth(DEFAULT_WIDTH);
		} else {
			store.setDetailPanelWidth(640);
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="grid h-full overflow-hidden"
	style:grid-template-columns="minmax(0,1fr) {panelWidth}px"
	style:grid-template-rows="1fr"
	onmousemove={onResizeMove}
	onmouseup={onResizeEnd}
	onmouseleave={onResizeEnd}
>
	<!-- MAIN AREA -->
	<main class="flex flex-col overflow-hidden">
		<div class="flex-none border-b border-zinc-800 px-3 py-2">
			{@render mainToolbar()}
		</div>

		<div class="flex-1 overflow-y-auto">
			{@render mainContent()}
		</div>

		<!-- Bottom dock (logs) -->
		{#if bottomDock && !dockCollapsed}
			<div
				class="flex-none border-t border-zinc-800 overflow-y-auto"
				style:height="{dockHeight}px"
			>
				{@render bottomDock()}
			</div>
		{/if}

		{#if bottomDock}
			<button
				class="flex-none flex items-center justify-center gap-2 px-3 py-1 border-t border-zinc-800 text-xs text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50 transition-colors"
				onclick={() => store.toggleLogDock()}
			>
				<span>{dockCollapsed ? 'Show Logs' : 'Hide Logs'}</span>
			</button>
		{/if}
	</main>

	<!-- RIGHT PANEL with resize handle -->
	<div class="relative border-l border-zinc-800 overflow-hidden bg-zinc-950/30">
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-orange-500/40 transition-colors z-10"
			class:bg-orange-500={isResizing}
			onmousedown={onResizeStart}
			ondblclick={onResizeHandleDblClick}
		></div>

		<div class="h-full overflow-y-auto pl-1">
			{@render rightPanel()}
		</div>
	</div>
</div>

{#if isResizing}
	<div class="fixed inset-0 z-50 cursor-col-resize"></div>
{/if}
