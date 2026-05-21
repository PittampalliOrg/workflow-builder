<script lang="ts">
	import Response from '$lib/components/ui/ai-elements/response/Response.svelte';
	import JsonView from '$lib/components/sessions/json-view.svelte';
	import { parseIoValue, capText } from '$lib/utils/io-value';

	let { value, label = null }: { value: unknown; label?: string | null } = $props();

	let parsed = $derived(parseIoValue(value));
	let isEmpty = $derived(
		!parsed.text && !parsed.json && (!parsed.messages || parsed.messages.length === 0)
	);

	function roleTone(role: string): string {
		const r = role.toLowerCase();
		if (r === 'assistant') return 'text-chart-2';
		if (r === 'system') return 'text-chart-5';
		if (r === 'tool' || r === 'function') return 'text-chart-4';
		return 'text-muted-foreground';
	}
</script>

{#if !isEmpty}
	<div class="space-y-1.5">
		{#if label}
			<div class="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
		{/if}
		<div class="wb-io">
			{#if parsed.messages}
				<div class="space-y-2">
					{#each parsed.messages as m, i (i)}
						<div class="rounded border bg-muted/30 p-2">
							<div class="mb-1 text-[10px] font-semibold uppercase tracking-wide {roleTone(m.role)}">{m.role}</div>
							<div class="prose-sm max-w-none text-xs leading-relaxed">
								<Response content={capText(m.content)} parseIncompleteMarkdown={true} />
							</div>
						</div>
					{/each}
				</div>
			{:else if parsed.text}
				<div class="prose-sm max-w-none text-xs leading-relaxed">
					<Response content={capText(parsed.text)} parseIncompleteMarkdown={true} />
				</div>
			{:else if parsed.json !== undefined}
				<JsonView value={parsed.json} class="text-[11px]" />
			{/if}
		</div>
	</div>
{/if}

<style>
	.wb-io {
		max-height: 360px;
		overflow: auto;
		border-radius: calc(var(--radius) - 4px);
		border: 1px solid var(--border);
		background: var(--muted);
		padding: 8px 10px;
	}
</style>
