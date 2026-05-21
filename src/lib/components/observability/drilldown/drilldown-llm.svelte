<script lang="ts">
	import { ChevronRight, ChevronDown, Sparkles, ArrowDown, ArrowUp } from '@lucide/svelte';
	import type { ObservabilityTraceSpan, ObservabilityLlmSpan } from '$lib/types/observability';
	import { fmtTokens, fmtMs } from '$lib/utils/span-presentation';
	import { llmModel, llmTokens, llmFinish } from '$lib/utils/io-value';
	import DrilldownIo from './drilldown-io.svelte';

	// Driven by the LLM-category trace spans (which carry input.value/output.value +
	// gen_ai usage). `fallback` supplies obs.llm_spans messages when a span lacks them.
	let {
		spans,
		fallback = []
	}: { spans: ObservabilityTraceSpan[]; fallback?: ObservabilityLlmSpan[] } = $props();

	let fb = $derived(new Map(fallback.map((s) => [s.spanId, s])));
	let expanded = $state(new Set<string>());
	function toggle(id: string) {
		const next = new Set(expanded);
		next.has(id) ? next.delete(id) : next.add(id);
		expanded = next;
	}
</script>

<div class="space-y-1.5 py-2">
	{#each spans as span (span.spanId)}
		{@const open = expanded.has(span.spanId)}
		{@const f = fb.get(span.spanId)}
		{@const tok = llmTokens(span.attributes)}
		{@const inTok = tok.input ?? f?.promptTokens ?? 0}
		{@const outTok = tok.output ?? f?.completionTokens ?? 0}
		{@const model = llmModel(span.attributes) ?? f?.modelName ?? 'LLM call'}
		{@const finish = llmFinish(span.attributes)}
		{@const inputVal = span.attributes?.['input.value'] ?? f?.inputMessages}
		{@const outputVal = span.attributes?.['output.value'] ?? f?.outputMessages}
		<div class="rounded-md border bg-card">
			<button class="flex w-full items-center gap-2 px-2.5 py-2 text-left" onclick={() => toggle(span.spanId)}>
				{#if open}<ChevronDown size={13} class="shrink-0 text-muted-foreground" />{:else}<ChevronRight size={13} class="shrink-0 text-muted-foreground" />{/if}
				<Sparkles size={13} class="shrink-0 text-chart-2" />
				<span class="truncate text-xs font-medium">{model}</span>
				<div class="ml-auto flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground tabular-nums">
					<span class="inline-flex items-center gap-0.5" title="input tokens"><ArrowUp size={9} />{fmtTokens(inTok)}</span>
					<span class="inline-flex items-center gap-0.5" title="output tokens"><ArrowDown size={9} />{fmtTokens(outTok)}</span>
					<span title="duration">{fmtMs(span.duration)}</span>
					{#if finish}<span class="rounded bg-muted px-1 py-px">{finish}</span>{/if}
				</div>
			</button>
			{#if open}
				<div class="space-y-2 border-t px-2.5 py-2">
					<DrilldownIo label="Prompt" value={inputVal} />
					<DrilldownIo label="Response" value={outputVal} />
					{#if inputVal == null && outputVal == null}
						<p class="text-[11px] text-muted-foreground">No captured content for this call.</p>
					{/if}
				</div>
			{/if}
		</div>
	{/each}
</div>
