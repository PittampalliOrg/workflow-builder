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
		ui?.openRightPanel('code');
		store.requestScriptReveal(line);
	}
</script>

<ScriptCanvas
	scriptSource={canvasSource}
	activeLine={codeTabOpen ? store.scriptCursorLine : null}
	{onNodeLine}
/>
