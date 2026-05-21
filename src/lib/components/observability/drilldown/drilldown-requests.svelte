<script lang="ts">
	import { Globe, ArrowLeftRight } from '@lucide/svelte';
	import type { ObservabilityTraceSpan } from '$lib/types/observability';
	import { categorizeSpan, httpSummary, statusTone, fmtMs, collapseServiceNameClient } from '$lib/utils/span-presentation';

	let { spans }: { spans: ObservabilityTraceSpan[] } = $props();

	let requests = $derived.by(() =>
		spans
			.map((s) => ({ span: s, cat: categorizeSpan(s) }))
			.filter((x) => x.cat === 'http' || x.cat === 'rpc')
			.sort((a, b) => new Date(a.span.startTime).getTime() - new Date(b.span.startTime).getTime())
			.map((x) => ({ span: x.span, cat: x.cat, http: httpSummary(x.span.attributes) }))
	);
</script>

<div class="space-y-1 py-2">
	{#each requests as r, i (r.span.spanId + i)}
		<div class="flex items-center gap-2 rounded-md border bg-card px-2.5 py-2">
			{#if r.cat === 'rpc'}<ArrowLeftRight size={13} class="shrink-0 text-chart-5" />{:else}<Globe size={13} class="shrink-0 text-chart-1" />{/if}
			{#if r.http.method}
				<span class="shrink-0 rounded bg-muted px-1.5 py-px font-mono text-[10px] font-semibold uppercase text-foreground">{r.http.method}</span>
			{/if}
			<span class="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" title={r.http.path ?? r.span.operationName}>
				{r.http.path ?? r.span.operationName}
			</span>
			{#if r.http.status != null}
				<span class="shrink-0 font-mono text-[11px] font-semibold tabular-nums {statusTone(r.http.status)}">{r.http.status}</span>
			{:else if r.span.status === 'error'}
				<span class="shrink-0 font-mono text-[11px] font-semibold text-destructive">err</span>
			{/if}
			<span class="shrink-0 text-[10px] text-muted-foreground tabular-nums">{fmtMs(r.span.duration)}</span>
			<span class="hidden shrink-0 text-[10px] text-muted-foreground sm:inline">{collapseServiceNameClient(r.span.serviceName)}</span>
		</div>
	{/each}
</div>
