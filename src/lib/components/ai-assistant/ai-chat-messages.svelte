<script lang="ts">
	import { getContext } from 'svelte';
	import { Sparkles, Zap, GitBranch, Repeat, Shield } from 'lucide-svelte';
	import { ChatContainerRoot, ChatContainerScrollAnchor } from '$lib/components/ui/prompt-kit/chat-container';
	import { ScrollButton } from '$lib/components/ui/prompt-kit/scroll-button';
	import type { createAiAssistantStore } from '$lib/stores/ai-assistant.svelte';
	import AiMessageBubble from './ai-message-bubble.svelte';

	const assistant = getContext<ReturnType<typeof createAiAssistantStore>>('ai-assistant');

	const starterPrompts = [
		{ icon: Zap, text: 'Build an API data pipeline with error handling' },
		{ icon: Zap, text: 'Add an OpenAI structured output step after the selected node' },
		{ icon: GitBranch, text: 'Create a workflow that checks a condition and branches' },
		{ icon: Repeat, text: 'Add a loop that processes each item in a list' },
		{ icon: Shield, text: 'Wrap the current steps in try/catch error handling' },
	];

	function sendStarter(text: string) {
		assistant.sendMessage(text);
	}
</script>

<ChatContainerRoot class="relative flex-1 px-3 py-3 space-y-3" style="min-height: 0;">
	{#if assistant.messages.length === 0}
		<div class="flex flex-col items-center justify-center h-full text-center text-muted-foreground gap-3 py-8">
			<div class="rounded-full bg-amber-100 dark:bg-amber-900/30 p-3">
				<Sparkles size={20} class="text-amber-500" />
			</div>
			<div>
				<p class="text-xs font-medium text-foreground">AI Workflow Assistant</p>
				<p class="text-[10px] mt-0.5 max-w-[240px]">
					{#if assistant.workflowContext}
						Describe changes to your workflow and I'll generate the operations.
					{:else}
						Ask about workflow design, or open a workflow to start editing.
					{/if}
				</p>
			</div>

			{#if assistant.workflowContext}
				<div class="w-full space-y-1.5 mt-2">
					{#each starterPrompts as prompt}
						<button
							onclick={() => sendStarter(prompt.text)}
							class="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-[10px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
						>
							<prompt.icon size={12} class="shrink-0 text-muted-foreground" />
							<span>{prompt.text}</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>
	{:else}
		{#each assistant.messages as message (message.id)}
			<AiMessageBubble {message} />
		{/each}

		<ChatContainerScrollAnchor />
		<ScrollButton />
	{/if}
</ChatContainerRoot>
