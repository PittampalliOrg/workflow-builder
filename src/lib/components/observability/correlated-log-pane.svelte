<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import type { ObservabilityLogEntry } from '$lib/types/observability';

	export type LogPaneMode = 'session' | 'span';

	interface Props {
		logs: ObservabilityLogEntry[];
		totalCount: number;
		mode: LogPaneMode;
		selectedSpan?: { traceId: string; spanId: string; label?: string | null } | null;
		selectedLogKey?: string | null;
		onModeChange?: (mode: LogPaneMode) => void;
		onSelectLog?: (log: ObservabilityLogEntry, key: string) => void;
	}

	let {
		logs,
		totalCount,
		mode,
		selectedSpan = null,
		selectedLogKey = null,
		onModeChange = () => {},
		onSelectLog = () => {}
	}: Props = $props();

	function formatTimestamp(value: string): string {
		return new Date(value).toLocaleTimeString(undefined, {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			fractionalSecondDigits: 3
		});
	}

	function severityTone(severity: string): string {
		const value = severity.toLowerCase();
		if (value.includes('error') || value.includes('fatal')) return 'bg-red-500/15 text-red-200';
		if (value.includes('warn')) return 'bg-amber-500/15 text-amber-200';
		if (value.includes('debug') || value.includes('trace')) return 'bg-white/5 text-zinc-300';
		return 'bg-cyan-500/15 text-cyan-200';
	}
</script>

<section class="rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(15,15,19,0.98),rgba(9,9,12,0.98))] shadow-[0_14px_38px_rgba(0,0,0,0.2)]">
	<div class="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
		<div>
			<p class="text-[11px] font-medium uppercase tracking-[0.24em] text-zinc-500">Correlated logs</p>
			<p class="mt-1 text-sm text-zinc-300">{logs.length} of {totalCount} visible</p>
		</div>
		<div class="flex items-center gap-2">
			<div class="flex items-center rounded-xl border border-white/10 bg-white/5 p-1">
				<button
					class={`rounded-lg px-3 py-1.5 text-xs transition-colors ${mode === 'session' ? 'bg-white/10 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'}`}
					onclick={() => onModeChange('session')}
				>
					Session
				</button>
				<button
					class={`rounded-lg px-3 py-1.5 text-xs transition-colors ${mode === 'span' ? 'bg-white/10 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'} disabled:opacity-40`}
					onclick={() => onModeChange('span')}
					disabled={!selectedSpan}
				>
					Selected span
				</button>
			</div>
		</div>
	</div>

	<div class="max-h-[340px] overflow-auto">
		{#if logs.length === 0}
			<div class="px-4 py-10 text-center text-sm text-zinc-500">
				{#if mode === 'span'}
					No logs are attached to the selected span.
				{:else}
					No correlated OTEL logs match the current filters.
				{/if}
			</div>
		{:else}
			<div class="divide-y divide-white/[0.05]">
				{#each logs as log, index (`${log.timestamp}:${log.traceId}:${log.spanId}:${index}`)}
					{@const key = `${log.timestamp}:${log.traceId}:${log.spanId}:${index}`}
					<button
						class={`w-full px-4 py-3 text-left transition-colors hover:bg-white/[0.04] ${selectedLogKey === key ? 'bg-amber-500/10' : ''}`}
						onclick={() => onSelectLog(log, key)}
					>
						<div class="grid gap-2 xl:grid-cols-[108px_90px_140px_minmax(0,1fr)] xl:items-start xl:gap-3">
							<div class="font-mono text-[11px] text-zinc-500">{formatTimestamp(log.timestamp)}</div>
							<div>
								<span class={`inline-flex rounded-full px-2 py-0.5 font-mono text-[10px] ${severityTone(log.severityText || 'info')}`}>
									{log.severityText || 'INFO'}
								</span>
							</div>
							<div class="truncate font-mono text-[11px] text-zinc-400">{log.serviceName}</div>
							<div class="min-w-0">
								<p class="break-words font-mono text-[12px] text-zinc-200">{log.body || '(empty log body)'}</p>
								<div class="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-zinc-500">
									<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-[10px] text-zinc-300">
										{log.traceId.slice(0, 10)}
									</Badge>
									<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-[10px] text-zinc-300">
										{log.spanId.slice(0, 10)}
									</Badge>
								</div>
							</div>
						</div>
					</button>
				{/each}
			</div>
		{/if}
	</div>
</section>
