<script lang="ts">
	import { getContext, tick, onMount } from 'svelte';
	import { Sparkles, Zap, GitBranch, Repeat, Shield } from 'lucide-svelte';
	import type { createAiAssistantStore } from '$lib/stores/ai-assistant.svelte';
	import AiMessageBubble from './ai-message-bubble.svelte';

	const assistant = getContext<ReturnType<typeof createAiAssistantStore>>('ai-assistant');

	let scrollContainer: HTMLDivElement | undefined = $state();
	let userScrolledUp = $state(false);

	const starterPrompts = [
		{ icon: Zap, text: 'Build an API data pipeline with error handling' },
		{ icon: GitBranch, text: 'Create a workflow that checks a condition and branches' },
		{ icon: Repeat, text: 'Add a loop that processes each item in a list' },
		{ icon: Shield, text: 'Wrap the current steps in try/catch error handling' },
	];

	function sendStarter(text: string) {
		assistant.sendMessage(text);
	}

	function scrollToBottom() {
		if (!scrollContainer) return;
		scrollContainer.scrollTop = scrollContainer.scrollHeight;
		userScrolledUp = false;
	}

	function handleScroll() {
		if (!scrollContainer) return;
		// Detect if user has scrolled up (more than 50px from bottom)
		const distFromBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
		userScrolledUp = distFromBottom > 50;
	}

	// Auto-scroll when new messages arrive
	$effect(() => {
		const _ = assistant.messages.length;
		if (!userScrolledUp) {
			tick().then(scrollToBottom);
		}
	});

	// Auto-scroll during streaming (content changes)
	$effect(() => {
		if (!assistant.isStreaming) return;
		// Access the last message's parts to trigger on each update
		const msgs = assistant.messages;
		const last = msgs[msgs.length - 1];
		const _ = last?.parts?.length;

		if (!userScrolledUp) {
			requestAnimationFrame(scrollToBottom);
		}
	});

	// Also poll during streaming for continuous scroll
	$effect(() => {
		if (!assistant.isStreaming) return;
		const interval = setInterval(() => {
			if (!userScrolledUp && scrollContainer) {
				scrollContainer.scrollTop = scrollContainer.scrollHeight;
			}
		}, 100);
		return () => clearInterval(interval);
	});
</script>

<div
	bind:this={scrollContainer}
	class="flex-1 overflow-y-auto px-3 py-3 space-y-3"
	style="min-height: 0;"
	onscroll={handleScroll}
>
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

		<!-- Scroll anchor -->
		<div class="h-1"></div>
	{/if}
</div>

{#if userScrolledUp && assistant.messages.length > 0}
	<button
		class="absolute bottom-16 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-1 text-[10px] text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors z-10"
		onclick={scrollToBottom}
	>
		↓ Scroll to bottom
	</button>
{/if}
