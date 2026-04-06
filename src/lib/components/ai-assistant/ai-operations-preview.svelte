<script lang="ts">
	import { getContext } from 'svelte';
	import { Check, X, FileCode } from 'lucide-svelte';
	import { Button } from '$lib/components/ui/button';
	import type { createAiAssistantStore } from '$lib/stores/ai-assistant.svelte';

	interface Props {
		spec: Record<string, unknown>;
		messageId: string;
	}

	let { spec, messageId }: Props = $props();
	const assistant = getContext<ReturnType<typeof createAiAssistantStore>>('ai-assistant');

	// Summarize what changed in the spec — handle `do` at root or inside document
	function getDoArray(): Array<Record<string, unknown>> {
		if (Array.isArray(spec?.do)) return spec.do as Array<Record<string, unknown>>;
		const doc = spec?.document as Record<string, unknown> | undefined;
		if (doc && Array.isArray(doc.do)) return doc.do as Array<Record<string, unknown>>;
		return [];
	}

	let taskCount = $derived(getDoArray().length);

	let taskNames = $derived.by(() => {
		return getDoArray().map((entry) => Object.keys(entry)[0]).filter(Boolean);
	});

	let specName = $derived((spec?.document as Record<string, unknown>)?.title || (spec?.document as Record<string, unknown>)?.name || 'Untitled');

	function handleApply() {
		window.dispatchEvent(
			new CustomEvent('ai-assistant:apply-spec', {
				detail: { spec, messageId },
			}),
		);
	}

	function handleDismiss() {
		assistant.dismissSpec();
	}
</script>

<div class="rounded-lg border border-border bg-card p-2.5 space-y-2">
	<div class="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
		<FileCode size={10} />
		Workflow Spec
	</div>

	<div class="space-y-1 text-[10px]">
		<div class="flex items-center gap-1.5">
			<span class="text-muted-foreground">Name:</span>
			<span class="font-medium">{specName}</span>
		</div>
		<div class="flex items-center gap-1.5">
			<span class="text-muted-foreground">Tasks:</span>
			<span>{taskCount}</span>
		</div>
		{#if taskNames.length > 0}
			<div class="text-muted-foreground">
				{taskNames.join(' → ')}
			</div>
		{/if}
	</div>

	<div class="flex items-center gap-1.5 pt-1">
		<Button size="sm" class="h-6 text-[10px] px-2.5 gap-1" onclick={handleApply}>
			<Check size={10} />
			Apply Spec
		</Button>
		<Button variant="outline" size="sm" class="h-6 text-[10px] px-2.5 gap-1" onclick={handleDismiss}>
			<X size={10} />
			Dismiss
		</Button>
	</div>
</div>
