<script lang="ts">
	import { ChevronDown, ChevronRight, Globe, ArrowLeftRight } from '@lucide/svelte';
	import type { ObservabilityTraceSpan } from '$lib/types/observability';
	import { categorizeSpan, httpSummary, statusTone, fmtMs, collapseServiceNameClient } from '$lib/utils/span-presentation';
	import DrilldownIo from './drilldown-io.svelte';
	import { buildIoFallbackBySpanId, type DrilldownIoFallbackValue } from './io-fallback';

	let { spans }: { spans: ObservabilityTraceSpan[] } = $props();

	let expanded = $state(new Set<string>());
	let ioFallbackBySpanId = $derived(buildIoFallbackBySpanId(spans));

	const INFRA_ONLY_PATTERNS = [
		/\/TaskHubSidecarService\//,
		/\/v1\.0\/metadata/,
		/\/dapr\.proto\.runtime\.v1\.Dapr\/GetMetadata/,
		/\/dapr\.proto\.runtime\.v1\.Dapr\/GetConfiguration/,
		/\/dapr\.proto\.runtime\.v1\.Dapr\/SubscribeConfiguration/,
		/\/dapr\.proto\.runtime\.v1\.Dapr\/SubscribeTopicEvents/
	];

	function spanIo(span: ObservabilityTraceSpan) {
		const fallback = ioFallbackBySpanId.get(span.spanId);
		return {
			fallback,
			input: span.attributes?.['input.value'] ?? fallback?.input?.value,
			output: span.attributes?.['output.value'] ?? fallback?.output?.value
		};
	}

	function isInfrastructureOnly(span: ObservabilityTraceSpan): boolean {
		const text = `${span.operationName} ${span.attributes?.['url.path'] ?? ''} ${span.attributes?.['http.target'] ?? ''}`;
		return INFRA_ONLY_PATTERNS.some((pattern) => pattern.test(text));
	}

	let requests = $derived.by(() =>
		spans
			.map((s) => ({ span: s, cat: categorizeSpan(s) }))
			.filter((x) => x.cat === 'http' || x.cat === 'rpc')
			.filter((x) => {
				if (!isInfrastructureOnly(x.span)) return true;
				const io = spanIo(x.span);
				return io.input !== undefined || io.output !== undefined || x.span.status === 'error';
			})
			.sort((a, b) => new Date(a.span.startTime).getTime() - new Date(b.span.startTime).getTime())
			.map((x) => ({ span: x.span, cat: x.cat, http: httpSummary(x.span.attributes) }))
	);

	function sourceLabel(prefix: 'Input' | 'Output', fallback?: DrilldownIoFallbackValue): string {
		if (!fallback) return prefix;
		const relation = fallback.sourceRelation === 'ancestor' ? 'ancestor' : 'descendant';
		return `${prefix} from ${relation} ${fallback.sourceLabel}`;
	}

	function toggle(id: string) {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded = next;
	}
</script>

<div class="space-y-1 py-2">
	{#each requests as r, i (r.span.spanId + i)}
		{@const io = spanIo(r.span)}
		{@const fallback = io.fallback}
		{@const input = io.input}
		{@const output = io.output}
		{@const hasBody = input !== undefined || output !== undefined}
		{@const isExpanded = expanded.has(r.span.spanId)}
		<div class="rounded-md border bg-card">
			<button
				type="button"
				class="flex w-full items-center gap-2 px-2.5 py-2 text-left"
				onclick={() => hasBody && toggle(r.span.spanId)}
				aria-expanded={hasBody ? isExpanded : undefined}
				title={hasBody ? 'Show request and response content' : undefined}
			>
				{#if hasBody}
					{#if isExpanded}<ChevronDown size={13} class="shrink-0 text-muted-foreground" />{:else}<ChevronRight size={13} class="shrink-0 text-muted-foreground" />{/if}
				{/if}
				{#if r.cat === 'rpc'}<ArrowLeftRight size={13} class="shrink-0 text-chart-5" />{:else}<Globe size={13} class="shrink-0 text-chart-1" />{/if}
				{#if r.http.method}
					<span class="shrink-0 rounded bg-muted px-1.5 py-px font-mono text-[10px] font-semibold uppercase text-foreground">{r.http.method}</span>
				{/if}
				<span class="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" title={r.http.path ?? r.span.operationName}>
					{r.http.path ?? r.span.operationName}
				</span>
				{#if hasBody}
					<span class="shrink-0 rounded border border-border px-1.5 py-px text-[10px] text-muted-foreground">body</span>
				{/if}
				{#if r.http.status != null}
					<span class="shrink-0 font-mono text-[11px] font-semibold tabular-nums {statusTone(r.http.status)}">{r.http.status}</span>
				{:else if r.span.status === 'error'}
					<span class="shrink-0 font-mono text-[11px] font-semibold text-destructive">err</span>
				{/if}
				<span class="shrink-0 text-[10px] text-muted-foreground tabular-nums">{fmtMs(r.span.duration)}</span>
				<span class="hidden shrink-0 text-[10px] text-muted-foreground sm:inline">{collapseServiceNameClient(r.span.serviceName)}</span>
			</button>
			{#if hasBody && isExpanded}
				<div class="space-y-2 border-t px-2.5 py-2">
					{#if input !== undefined}
						<DrilldownIo label={sourceLabel('Input', r.span.attributes?.['input.value'] == null ? fallback?.input : undefined)} value={input} />
					{/if}
					{#if output !== undefined}
						<DrilldownIo label={sourceLabel('Output', r.span.attributes?.['output.value'] == null ? fallback?.output : undefined)} value={output} />
					{/if}
				</div>
			{/if}
		</div>
	{/each}
</div>
