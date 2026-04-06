<script lang="ts">
	import { getContext } from 'svelte';
	import { X, Trash2, Sparkles, GitBranch } from 'lucide-svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import type { createAiAssistantStore } from '$lib/stores/ai-assistant.svelte';

	interface Props {
		onClose: () => void;
	}

	let { onClose }: Props = $props();
	const assistant = getContext<ReturnType<typeof createAiAssistantStore>>('ai-assistant');

	let workflowName = $derived(assistant.workflowContext?.workflowName);
	let taskCount = $derived.by(() => {
		const spec = assistant.workflowContext?.spec;
		if (!spec) return 0;
		return ((spec as Record<string, unknown>).do as unknown[] || []).length;
	});
</script>

<div class="flex items-center justify-between border-b border-border px-3 py-2">
	<div class="flex items-center gap-2 min-w-0">
		<Sparkles size={14} class="shrink-0 text-amber-500" />
		<span class="text-sm font-medium truncate">AI Assistant</span>
		{#if workflowName}
			<Badge variant="outline" class="text-[9px] px-1.5 gap-1 max-w-[140px] truncate">
				<GitBranch size={9} class="shrink-0" />
				{workflowName}
				{#if taskCount > 0}
					<span class="opacity-60">({taskCount} tasks)</span>
				{/if}
			</Badge>
		{/if}
	</div>
	<div class="flex items-center gap-0.5">
		<Button
			variant="ghost"
			size="icon"
			class="h-6 w-6"
			onclick={() => assistant.clearHistory()}
			title="Clear history"
		>
			<Trash2 size={12} />
		</Button>
		<Button
			variant="ghost"
			size="icon"
			class="h-6 w-6"
			onclick={onClose}
			title="Close"
		>
			<X size={12} />
		</Button>
	</div>
</div>
