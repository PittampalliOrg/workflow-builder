<script lang="ts">
	import { getContext } from 'svelte';
	import { Send, Square, GitBranch, Zap } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import type { createAiAssistantStore } from '$lib/stores/ai-assistant.svelte';
	import type { createBuildWorkflowStore } from '$lib/stores/build-workflow.svelte';

	const assistant = getContext<ReturnType<typeof createAiAssistantStore>>('ai-assistant');
	const buildAgent = getContext<ReturnType<typeof createBuildWorkflowStore>>('build-workflow');

	let input = $state('');
	let textareaEl: HTMLTextAreaElement | undefined = $state();

	function handleSend() {
		if (!input.trim() || assistant.isStreaming) return;
		const text = input.trim();

		// Detect /build-workflow command
		if (text.startsWith('/build-workflow ') || text.startsWith('/build ')) {
			const prompt = text.replace(/^\/build(-workflow)?\s+/, '');
			const workflowId = assistant.workflowContext?.workflowId;
			if (workflowId && prompt) {
				buildAgent.start(workflowId, prompt);
			}
			input = '';
			if (textareaEl) textareaEl.style.height = 'auto';
			return;
		}

		assistant.sendMessage(text);
		input = '';
		if (textareaEl) textareaEl.style.height = 'auto';
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			handleSend();
		}
	}

	function autoResize(e: Event) {
		const el = e.target as HTMLTextAreaElement;
		el.style.height = 'auto';
		el.style.height = Math.min(el.scrollHeight, 120) + 'px';
	}

	let hasContext = $derived(!!assistant.workflowContext);
	let contextLabel = $derived.by(() => {
		const ctx = assistant.workflowContext;
		if (!ctx) return null;
		const taskCount = ctx.spec ? ((ctx.spec as Record<string, unknown>).do as unknown[] || []).length : 0;
		const selected = ctx.selectedTaskName ? `, selected: ${ctx.selectedTaskName}` : '';
		return `${ctx.workflowName}${taskCount > 0 ? ` (${taskCount} tasks${selected})` : selected ? ` (${selected.slice(2)})` : ''}`;
	});
</script>

<div class="border-t border-border p-3 space-y-2">
	{#if hasContext}
		<div class="flex items-center gap-1.5">
			<div class="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[9px] text-muted-foreground">
				<GitBranch size={9} />
				<span class="truncate max-w-[200px]">{contextLabel}</span>
			</div>
		</div>
	{/if}

	<div class="flex items-end gap-2">
		<textarea
			bind:this={textareaEl}
			bind:value={input}
			onkeydown={handleKeydown}
			oninput={autoResize}
			placeholder={hasContext ? 'Describe a workflow or selected-node change...' : 'Ask about workflows...'}
			rows={1}
			disabled={assistant.isStreaming}
			class="flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
		></textarea>
		{#if assistant.isStreaming}
			<Button
				size="icon"
				variant="outline"
				class="h-8 w-8 shrink-0"
				onclick={() => assistant.stop()}
				title="Stop"
			>
				<Square size={12} />
			</Button>
		{:else}
			<Button
				size="icon"
				class="h-8 w-8 shrink-0"
				disabled={!input.trim()}
				onclick={handleSend}
				title="Send (Cmd+Enter)"
			>
				<Send size={12} />
			</Button>
		{/if}
	</div>

	{#if assistant.error}
		<p class="text-[10px] text-destructive">{assistant.error}</p>
	{/if}

	<p class="text-[9px] text-muted-foreground">
		<kbd class="rounded border px-0.5 text-[8px]">{navigator?.platform?.includes('Mac') ? '⌘' : 'Ctrl'}+Enter</kbd> to send
	</p>
</div>
