<script lang="ts">
	import { getContext } from 'svelte';
	import { Sparkles } from 'lucide-svelte';
	import type { createUiStore } from '$lib/stores/ui.svelte';

	interface Props {
		collapsed?: boolean;
	}

	let { collapsed = false }: Props = $props();
	const ui = getContext<ReturnType<typeof createUiStore>>('ui');
</script>

{#if collapsed}
	<button
		onclick={() => ui.toggleAiPanel()}
		class="flex h-8 w-full items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground {ui.aiPanelOpen ? 'bg-accent text-accent-foreground' : ''}"
		title="AI Assistant"
	>
		<Sparkles size={15} />
	</button>
{:else}
	<button
		onclick={() => ui.toggleAiPanel()}
		class="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground {ui.aiPanelOpen ? 'bg-accent font-medium text-accent-foreground' : ''}"
	>
		<Sparkles size={15} class="shrink-0" />
		<span>AI Assistant</span>
	</button>
{/if}
