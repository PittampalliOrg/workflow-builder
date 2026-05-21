<script lang="ts">
	import { ChevronRight, ChevronDown, Wrench } from '@lucide/svelte';
	import type { ObservabilityTraceSpan, ObservabilityToolSpan } from '$lib/types/observability';
	import { fmtMs } from '$lib/utils/span-presentation';
	import { toolName } from '$lib/utils/io-value';
	import DrilldownIo from './drilldown-io.svelte';

	// Driven by the tool-category trace spans (gen_ai.tool.name / run_tool, which carry
	// input.value=args + output.value=result). `fallback` supplies obs.tool_spans.
	let {
		spans,
		fallback = []
	}: { spans: ObservabilityTraceSpan[]; fallback?: ObservabilityToolSpan[] } = $props();

	let fb = $derived(new Map(fallback.map((s) => [s.spanId, s])));
	let expanded = $state(new Set<string>());
	function toggle(id: string) {
		const next = new Set(expanded);
		next.has(id) ? next.delete(id) : next.add(id);
		expanded = next;
	}
	function shortName(span: ObservabilityTraceSpan, fbName?: string): string {
		const n = toolName(span.attributes) ?? fbName;
		if (n) return n;
		// run_tool span operationName like "agent-session-xxx.run_tool" → "run_tool"
		const op = span.operationName ?? 'tool';
		return op.includes('.') ? op.slice(op.lastIndexOf('.') + 1) : op;
	}
</script>

<div class="space-y-1.5 py-2">
	{#each spans as span (span.spanId)}
		{@const open = expanded.has(span.spanId)}
		{@const f = fb.get(span.spanId)}
		{@const name = shortName(span, f?.toolName)}
		{@const args = span.attributes?.['input.value'] ?? f?.toolArguments}
		{@const result = span.attributes?.['output.value'] ?? f?.toolResult}
		<div class="rounded-md border bg-card">
			<button class="flex w-full items-center gap-2 px-2.5 py-2 text-left" onclick={() => toggle(span.spanId)}>
				{#if open}<ChevronDown size={13} class="shrink-0 text-muted-foreground" />{:else}<ChevronRight size={13} class="shrink-0 text-muted-foreground" />{/if}
				<Wrench size={13} class="shrink-0 text-chart-4" />
				<span class="truncate font-mono text-xs font-medium">{name}</span>
				<span class="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">{fmtMs(span.duration)}</span>
			</button>
			{#if open}
				<div class="space-y-2 border-t px-2.5 py-2">
					<DrilldownIo label="Arguments" value={args} />
					<DrilldownIo label="Result" value={result} />
					{#if args == null && result == null}
						<p class="text-[11px] text-muted-foreground">No captured arguments or result.</p>
					{/if}
				</div>
			{/if}
		</div>
	{/each}
</div>
