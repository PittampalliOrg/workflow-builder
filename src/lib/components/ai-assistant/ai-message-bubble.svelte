<script lang="ts">
	import { getContext } from 'svelte';
	import { Bot, User } from '@lucide/svelte';
	import { Message, MessageContent } from '$lib/components/ui/prompt-kit/message';
	import { ThinkingBar } from '$lib/components/ui/prompt-kit/thinking-bar';
	import type { UIMessage, createAiAssistantStore } from '$lib/stores/ai-assistant.svelte';
	import { extractSpec, stripSpecBlocks, getMessageText } from '$lib/stores/ai-assistant.svelte';
	import AiOperationsPreview from './ai-operations-preview.svelte';

	interface Props {
		message: UIMessage;
	}

	let { message }: Props = $props();
	const assistant = getContext<ReturnType<typeof createAiAssistantStore>>('ai-assistant');

	let isUser = $derived(message.role === 'user');
	let rawText = $derived(getMessageText(message));
	let displayContent = $derived(stripSpecBlocks(rawText));
	let spec = $derived(extractSpec(rawText));
	let hasSpec = $derived(spec !== null);
	let specApplied = $derived(assistant.isApplied(message.id));
	let operationResult = $derived(message.operationResult);
	let isThinking = $derived(message.status === 'thinking');

	/**
	 * Simple inline formatting: **bold**, `code`, - lists
	 */
	function formatText(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
			.replace(/`([^`]+)`/g, '<code class="rounded bg-background/50 px-1 py-0.5 text-[9px] font-mono">$1</code>')
			.replace(/^- (.+)$/gm, '<span class="flex gap-1"><span class="text-muted-foreground">-</span> $1</span>');
	}
</script>

<Message class="gap-2 {isUser ? 'flex-row-reverse' : ''}">
	<div class="shrink-0 mt-0.5">
		{#if isUser}
			<div class="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
				<User size={12} />
			</div>
		{:else}
			<div class="flex h-6 w-6 items-center justify-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-900/50 dark:text-amber-400">
				<Bot size={12} />
			</div>
		{/if}
	</div>
	<div class="min-w-0 flex-1 space-y-2 {isUser ? 'text-right' : ''}">
		<div
			class="inline-block rounded-lg px-3 py-2 text-xs leading-relaxed max-w-[85%] {isUser
				? 'bg-primary text-primary-foreground'
				: 'bg-muted text-foreground'}"
		>
			{#if isThinking}
				<ThinkingBar text="Thinking" class="border-0 bg-transparent px-0 py-0" />
			{:else if displayContent}
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				<MessageContent class="whitespace-pre-wrap break-words text-xs leading-relaxed prose-p:my-0 prose-ul:my-0 prose-li:my-0">{@html formatText(displayContent)}</MessageContent>
			{:else if assistant.isStreaming && message.role === 'assistant'}
				<div class="flex items-center gap-1.5 text-muted-foreground">
					<div class="h-1.5 w-1.5 rounded-full bg-current animate-pulse"></div>
					<div class="h-1.5 w-1.5 rounded-full bg-current animate-pulse [animation-delay:0.2s]"></div>
					<div class="h-1.5 w-1.5 rounded-full bg-current animate-pulse [animation-delay:0.4s]"></div>
				</div>
			{/if}
		</div>

		{#if operationResult && !isUser}
			<AiOperationsPreview result={operationResult} messageId={message.id} />
		{:else if hasSpec && spec && !specApplied}
			<AiOperationsPreview spec={spec} messageId={message.id} />
		{:else if hasSpec && specApplied}
			<div class="text-[10px] text-muted-foreground italic {isUser ? 'text-right' : ''}">
				Spec applied
			</div>
		{/if}
	</div>
</Message>
