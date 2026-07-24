<script lang="ts">
	/**
	 * The code-first canvas host. ONE panel system: the canvas fills the page
	 * and the right panel owns Code / AI / Runs / Triggers — no floating view
	 * toggle, no second code surface.
	 *
	 * Sync contract (via the workflow store):
	 *  - node click        → open the Code tab + reveal that source line;
	 *  - editor cursor     → store.scriptCursorLine → the node lights up;
	 *  - unsaved draft     → store.scriptDraft → the canvas re-projects live.
	 */
	import { getContext } from 'svelte';
	import { History, Sparkles } from '@lucide/svelte';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import type { createUiStore } from '$lib/stores/ui.svelte';
	import ScriptCanvas from './script-canvas.svelte';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');
	const ui = getContext<ReturnType<typeof createUiStore> | undefined>('ui');

	// Live projection: the draft while dirty, else the saved source (null lets
	// the canvas fall back to store.scriptSource itself).
	const canvasSource = $derived(store.scriptDraft);
	const codeTabOpen = $derived(
		Boolean(ui?.rightPanelOpen && ui?.rightPanelTab === 'code')
	);

	function onNodeLine(line: number) {
		if (!store.isDynamicScript || line <= 0) return; // legacy rows have no source lines
		ui?.openRightPanel('code');
		store.requestScriptReveal(line);
	}

	function convertWithAi() {
		store.authorIntent = [
			'This workflow is a LEGACY SW 1.0 spec. Convert it to an equivalent',
			'dynamic script 1:1: fetch its current spec with get_workflow, port every',
			'step (durable/run → agent(), <service>/<action> calls → action(), listen',
			'gates → approve(), loops → JS loops), keep the SAME workflow name so the',
			'save updates this row, then validate and save.'
		].join(' ');
		ui?.openRightPanel('ai');
	}
</script>

<div class="relative h-full w-full">
	{#if !store.isDynamicScript && store.spec}
		<div class="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center">
			<div class="pointer-events-auto flex items-center gap-2 rounded-full border border-amber-500/40 bg-card/90 py-1 pl-3 pr-1 shadow-md backdrop-blur">
				<History class="size-3.5 text-amber-500 dark:text-amber-300" />
				<span class="text-[11px] text-muted-foreground">
					<span class="font-medium text-foreground/80">Legacy workflow (SW 1.0)</span>
					— read-only preview in the new canvas
				</span>
				<button
					class="inline-flex items-center gap-1 rounded-full bg-fuchsia-500/90 px-2.5 py-1 text-[10.5px] font-semibold text-white shadow hover:bg-fuchsia-500"
					onclick={convertWithAi}
					title="An AI author ports the spec to a dynamic script under the same name"
				>
					<Sparkles class="size-3" /> Convert to script
				</button>
			</div>
		</div>
	{/if}
	<ScriptCanvas
		scriptSource={canvasSource}
		activeLine={codeTabOpen ? store.scriptCursorLine : null}
		{onNodeLine}
	/>
</div>
