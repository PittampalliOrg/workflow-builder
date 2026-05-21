<script lang="ts">
	import type { ObservabilityLogEntry } from '$lib/types/observability';

	let { logs }: { logs: ObservabilityLogEntry[] } = $props();

	let filter = $state<'all' | 'error' | 'warn'>('all');

	function sev(s: string): 'error' | 'warn' | 'info' | 'debug' {
		const v = (s || '').toLowerCase();
		if (v.startsWith('err') || v.startsWith('fatal') || v.startsWith('crit')) return 'error';
		if (v.startsWith('warn')) return 'warn';
		if (v.startsWith('debug') || v.startsWith('trace')) return 'debug';
		return 'info';
	}
	const TONE: Record<string, string> = {
		error: 'text-destructive',
		warn: 'text-chart-5',
		info: 'text-chart-2',
		debug: 'text-muted-foreground'
	};

	let sorted = $derived(
		[...logs].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
	);
	let shown = $derived(
		filter === 'all'
			? sorted
			: sorted.filter((l) => (filter === 'error' ? sev(l.severityText) === 'error' : sev(l.severityText) === 'warn'))
	);
	let errorCount = $derived(logs.filter((l) => sev(l.severityText) === 'error').length);
	let warnCount = $derived(logs.filter((l) => sev(l.severityText) === 'warn').length);

	function time(ts: string): string {
		const d = new Date(ts);
		return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour12: false });
	}
</script>

<div class="py-2">
	<div class="mb-1.5 flex items-center gap-1 px-1">
		<button class="wb-chip" class:wb-chip--on={filter === 'all'} onclick={() => (filter = 'all')}>All {logs.length}</button>
		{#if errorCount > 0}
			<button class="wb-chip" class:wb-chip--on={filter === 'error'} onclick={() => (filter = 'error')}>
				<span class="text-destructive">Errors {errorCount}</span>
			</button>
		{/if}
		{#if warnCount > 0}
			<button class="wb-chip" class:wb-chip--on={filter === 'warn'} onclick={() => (filter = 'warn')}>
				<span class="text-chart-5">Warn {warnCount}</span>
			</button>
		{/if}
	</div>
	<div class="space-y-px">
		{#each shown as log, i (i)}
			{@const s = sev(log.severityText)}
			<div class="flex gap-2 rounded px-2 py-1 hover:bg-muted/40">
				<span class="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">{time(log.timestamp)}</span>
				<span class="w-10 shrink-0 font-mono text-[10px] font-semibold uppercase {TONE[s]}">{s}</span>
				<span class="min-w-0 flex-1 break-words font-mono text-[11px] leading-relaxed text-foreground">{log.body}</span>
			</div>
		{/each}
		{#if shown.length === 0}
			<p class="px-2 py-3 text-[11px] text-muted-foreground">No logs for this filter.</p>
		{/if}
	</div>
</div>

<style>
	.wb-chip {
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--card);
		padding: 1px 8px;
		font-size: 10px;
		color: var(--muted-foreground);
	}
	.wb-chip--on {
		background: var(--muted);
		color: var(--foreground);
		border-color: color-mix(in oklch, var(--primary) 30%, var(--border));
	}
</style>
