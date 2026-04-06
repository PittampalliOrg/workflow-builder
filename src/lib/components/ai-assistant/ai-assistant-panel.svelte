<script lang="ts">
	import { getContext } from 'svelte';
	import { fly } from 'svelte/transition';
	import type { createUiStore } from '$lib/stores/ui.svelte';
	import type { createAiAssistantStore } from '$lib/stores/ai-assistant.svelte';
	import type { createBuildWorkflowStore } from '$lib/stores/build-workflow.svelte';
	import AiChatHeader from './ai-chat-header.svelte';
	import AiChatMessages from './ai-chat-messages.svelte';
	import AiChatInput from './ai-chat-input.svelte';
	import BuildWorkflowPanel from './build-workflow-panel.svelte';

	const ui = getContext<ReturnType<typeof createUiStore>>('ui');
	const assistant = getContext<ReturnType<typeof createAiAssistantStore>>('ai-assistant');
	const buildAgent = getContext<ReturnType<typeof createBuildWorkflowStore>>('build-workflow');

	let showBuildPanel = $derived(buildAgent.phase !== 'idle');
</script>

{#if ui.aiPanelOpen}
	<div
		class="fixed right-0 top-0 z-40 flex h-full w-[400px] flex-col border-l border-border bg-background shadow-lg"
		transition:fly={{ x: 400, duration: 200 }}
	>
		<AiChatHeader onClose={() => { ui.aiPanelOpen = false; }} />

		{#if showBuildPanel}
			<BuildWorkflowPanel />
		{/if}

		<AiChatMessages />
		<AiChatInput />
	</div>
{/if}
