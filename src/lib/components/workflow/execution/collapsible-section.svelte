<script lang="ts">
	import { ChevronDown, ChevronRight, Copy, Check } from 'lucide-svelte';
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		defaultOpen?: boolean;
		copyData?: string;
		isError?: boolean;
		children: Snippet;
	}

	let { title, defaultOpen = false, copyData, isError = false, children }: Props = $props();

	let isOpen = $state(defaultOpen);
	let copyFeedback = $state(false);

	async function handleCopy() {
		if (!copyData) return;
		try {
			await navigator.clipboard.writeText(copyData);
			copyFeedback = true;
			setTimeout(() => (copyFeedback = false), 1500);
		} catch {
			// ignore
		}
	}
</script>

<div>
	<div class="mb-1.5 flex w-full items-center justify-between">
		<button
			class="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
			onclick={() => (isOpen = !isOpen)}
		>
			{#if isOpen}
				<ChevronDown size={10} class="text-muted-foreground" />
			{:else}
				<ChevronRight size={10} class="text-muted-foreground" />
			{/if}
			<span class="text-[10px] font-medium uppercase tracking-wide {isError ? 'text-red-500' : 'text-muted-foreground'}">
				{title}
			</span>
		</button>

		{#if copyData}
			<button
				class="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
				onclick={handleCopy}
				title="Copy"
			>
				{#if copyFeedback}
					<Check size={10} class="text-green-500" />
				{:else}
					<Copy size={10} />
				{/if}
			</button>
		{/if}
	</div>

	{#if isOpen}
		{@render children()}
	{/if}
</div>
