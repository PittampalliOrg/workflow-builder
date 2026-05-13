<script lang="ts">
	import type {
		ObservabilityLlmSpan,
		ObservabilityToolSpan
	} from '$lib/types/observability';

	type Props = {
		llmSpans: ObservabilityLlmSpan[];
		toolSpans: ObservabilityToolSpan[];
	};

	let { llmSpans, toolSpans }: Props = $props();

	let toolHistogram = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const s of toolSpans) {
			const name = s.toolName || '(unknown)';
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
		return [...counts.entries()].sort((a, b) => b[1] - a[1]);
	});

	let totalToolCalls = $derived(toolSpans.length);
	let totalLlmCalls = $derived(llmSpans.length);
	let totalTokens = $derived(
		llmSpans.reduce((acc, s) => acc + (s.totalTokens ?? 0), 0)
	);
	let cacheReadTokens = $derived(
		llmSpans.reduce((acc, s) => acc + (s.cacheReadInputTokens ?? 0), 0)
	);
	let cacheCreationTokens = $derived(
		llmSpans.reduce((acc, s) => acc + (s.cacheCreationInputTokens ?? 0), 0)
	);
	let reasoningTokens = $derived(
		llmSpans.reduce((acc, s) => acc + (s.reasoningTokens ?? 0), 0)
	);
	let firstTs = $derived(llmSpans[0]?.timestamp ?? null);

	function formatRelative(timestamp: string): string {
		if (!firstTs) return timestamp;
		const t0 = new Date(firstTs).getTime();
		const t = new Date(timestamp).getTime();
		if (!Number.isFinite(t0) || !Number.isFinite(t)) return timestamp;
		const dt = (t - t0) / 1000;
		if (dt < 1) return `+${(dt * 1000).toFixed(0)}ms`;
		if (dt < 60) return `+${dt.toFixed(1)}s`;
		const m = Math.floor(dt / 60);
		const s = dt - m * 60;
		return `+${m}m${s.toFixed(0)}s`;
	}
</script>

{#if llmSpans.length === 0 && toolSpans.length === 0}
	<div class="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
		No spans recorded for this instance. The runtime may have completed before OTel spans
		propagated, or the trace IDs were never stamped on the row.
	</div>
{:else}
	<div class="grid gap-3 sm:grid-cols-3">
		<div class="rounded-md border border-border p-3">
			<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
				LLM calls
			</div>
			<div class="mt-1 text-sm font-semibold tabular-nums">
				{totalLlmCalls}
			</div>
		</div>
		<div class="rounded-md border border-border p-3">
			<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
				Tool calls
			</div>
			<div class="mt-1 text-sm font-semibold tabular-nums">
				{totalToolCalls}
			</div>
		</div>
		<div class="rounded-md border border-border p-3">
			<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
				Total tokens (span sum)
			</div>
			<div class="mt-1 text-sm font-semibold tabular-nums">
				{totalTokens.toLocaleString()}
			</div>
			{#if cacheReadTokens || cacheCreationTokens || reasoningTokens}
				<div class="mt-0.5 text-[10px] text-muted-foreground">
					{#if cacheReadTokens}{cacheReadTokens.toLocaleString()} cache-read{/if}
					{#if cacheCreationTokens}{cacheReadTokens ? ' / ' : ''}{cacheCreationTokens.toLocaleString()} cache-write{/if}
					{#if reasoningTokens}{cacheReadTokens || cacheCreationTokens ? ' / ' : ''}{reasoningTokens.toLocaleString()} reasoning{/if}
				</div>
			{/if}
		</div>
	</div>

	{#if toolHistogram.length > 0}
		<section>
			<h4 class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
				Tools by call count
			</h4>
			<ul class="space-y-1">
				{#each toolHistogram as [name, count] (name)}
					<li class="flex items-center justify-between gap-2 text-xs">
						<span class="font-mono">{name}</span>
						<span class="tabular-nums text-muted-foreground">{count}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if llmSpans.length > 0}
		<section>
			<h4 class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
				LLM spans (chronological)
			</h4>
			<ol class="space-y-1 max-h-72 overflow-y-auto rounded border border-border bg-muted/20 p-2">
				{#each llmSpans as s, i (s.spanId)}
					<li class="flex items-baseline gap-2 font-mono text-[11px]">
						<span class="w-12 text-muted-foreground tabular-nums">#{i + 1}</span>
						<span class="w-20 text-muted-foreground tabular-nums">{formatRelative(s.timestamp)}</span>
						<span class="flex-1 truncate">
							{s.modelName ?? '?'}
							{#if s.promptTokens !== null && s.completionTokens !== null}
								<span class="ml-1 text-muted-foreground">
									{s.promptTokens.toLocaleString()} in / {s.completionTokens.toLocaleString()} out
								</span>
							{/if}
							{#if s.cacheReadInputTokens || s.cacheCreationInputTokens || s.reasoningTokens}
								<span class="ml-1 text-muted-foreground">
									{#if s.cacheReadInputTokens}{s.cacheReadInputTokens.toLocaleString()} cache-read{/if}
									{#if s.cacheCreationInputTokens}{s.cacheReadInputTokens ? ' / ' : ''}{s.cacheCreationInputTokens.toLocaleString()} cache-write{/if}
									{#if s.reasoningTokens}{s.cacheReadInputTokens || s.cacheCreationInputTokens ? ' / ' : ''}{s.reasoningTokens.toLocaleString()} reasoning{/if}
								</span>
							{/if}
						</span>
						{#if s.finishReason}
							<span class="text-muted-foreground">{s.finishReason}</span>
						{/if}
					</li>
				{/each}
			</ol>
		</section>
	{/if}

	{#if toolSpans.length > 0}
		<section>
			<h4 class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
				Tool spans (chronological)
			</h4>
			<ol class="space-y-1 max-h-60 overflow-y-auto rounded border border-border bg-muted/20 p-2">
				{#each toolSpans as s, i (s.spanId)}
					<li class="flex items-baseline gap-2 font-mono text-[11px]">
						<span class="w-12 text-muted-foreground tabular-nums">#{i + 1}</span>
						<span class="w-20 text-muted-foreground tabular-nums">{formatRelative(s.timestamp)}</span>
						<span class="flex-1 truncate">{s.toolName}</span>
						{#if s.statusCode && s.statusCode !== 'OK' && s.statusCode !== 'STATUS_CODE_OK'}
							<span class="text-red-600 dark:text-red-400">{s.statusCode}</span>
						{/if}
					</li>
				{/each}
			</ol>
		</section>
	{/if}
{/if}
