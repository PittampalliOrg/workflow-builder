<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import type { ObservabilityTraceSpan } from '$lib/types/observability';
	import { ChevronDown, ChevronRight } from 'lucide-svelte';

	export interface TraceGroup {
		traceId: string;
		label: string;
		serviceName: string;
		startTime: string;
		durationMs: number;
		spanCount: number;
		errorCount: number;
		spans: ObservabilityTraceSpan[];
	}

	interface Props {
		groups: TraceGroup[];
		selectedSpan?: { traceId: string; spanId: string } | null;
		llmCounts?: Record<string, number>;
		toolCounts?: Record<string, number>;
		logCounts?: Record<string, number>;
		globalStartMs: number;
		globalDurationMs: number;
		collapsedTraceIds?: Set<string>;
		onToggleTrace?: (traceId: string) => void;
		onSelectSpan?: (span: ObservabilityTraceSpan) => void;
	}

	let {
		groups,
		selectedSpan = null,
		llmCounts = {},
		toolCounts = {},
		logCounts = {},
		globalStartMs,
		globalDurationMs,
		collapsedTraceIds = new Set<string>(),
		onToggleTrace = () => {},
		onSelectSpan = () => {}
	}: Props = $props();

	function formatDuration(value: number): string {
		if (!Number.isFinite(value) || value <= 0) return '0ms';
		if (value < 1000) return `${Math.round(value)}ms`;
		return `${(value / 1000).toFixed(2)}s`;
	}

	function formatTime(value: string): string {
		return new Date(value).toLocaleTimeString(undefined, {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			fractionalSecondDigits: 3
		});
	}

	function rowKey(span: ObservabilityTraceSpan): string {
		return `${span.traceId}:${span.spanId}`;
	}

	function offsetPct(span: ObservabilityTraceSpan): number {
		if (globalDurationMs <= 0) return 0;
		return ((new Date(span.startTime).getTime() - globalStartMs) / globalDurationMs) * 100;
	}

	function widthPct(span: ObservabilityTraceSpan): number {
		if (globalDurationMs <= 0) return 100;
		return Math.max((span.duration / globalDurationMs) * 100, 0.8);
	}

	function statusTone(span: ObservabilityTraceSpan): string {
		if (span.status === 'error') return 'bg-red-400';
		if ((llmCounts[rowKey(span)] ?? 0) > 0) return 'bg-cyan-400';
		if ((toolCounts[rowKey(span)] ?? 0) > 0) return 'bg-emerald-400';
		return 'bg-orange-400';
	}
</script>

<section class="rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(17,17,22,0.96),rgba(10,10,14,0.98))] shadow-[0_14px_40px_rgba(0,0,0,0.24)]">
	<div class="border-b border-white/10 px-4 py-3">
		<div class="grid grid-cols-[minmax(0,1.8fr)_140px_86px_108px_minmax(260px,1fr)] gap-3 text-[10px] font-medium uppercase tracking-[0.24em] text-zinc-500">
			<span>Span</span>
			<span>Service</span>
			<span>Status</span>
			<span>Duration</span>
			<span>Waterfall</span>
		</div>
	</div>

	<div class="max-h-[760px] overflow-auto">
		{#if groups.length === 0}
			<div class="px-4 py-12 text-center text-sm text-zinc-500">No spans match the current filters.</div>
		{:else}
			{#each groups as group (group.traceId)}
				<div class="border-b border-white/5 last:border-b-0">
					<button
						class="flex w-full items-center gap-3 bg-white/[0.03] px-4 py-3 text-left hover:bg-white/[0.05]"
						onclick={() => onToggleTrace(group.traceId)}
					>
						{#if collapsedTraceIds.has(group.traceId)}
							<ChevronRight size={15} class="text-zinc-400" />
						{:else}
							<ChevronDown size={15} class="text-zinc-400" />
						{/if}
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<p class="truncate font-mono text-sm text-zinc-100">{group.label}</p>
								<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-[10px] text-zinc-300">
									{group.traceId.slice(0, 12)}
								</Badge>
								{#if group.errorCount > 0}
									<Badge variant="destructive" class="text-[10px]">{group.errorCount} err</Badge>
								{/if}
							</div>
							<div class="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-zinc-500">
								<span>{group.serviceName}</span>
								<span>{group.spanCount} spans</span>
								<span>{formatDuration(group.durationMs)}</span>
								<span>{formatTime(group.startTime)}</span>
							</div>
						</div>
					</button>

					{#if !collapsedTraceIds.has(group.traceId)}
						<div>
							{#each group.spans as span (rowKey(span))}
								{@const key = rowKey(span)}
								<button
									class={`grid w-full grid-cols-[minmax(0,1.8fr)_140px_86px_108px_minmax(260px,1fr)] gap-3 border-t border-white/[0.04] px-4 py-2 text-left transition-colors hover:bg-white/[0.04] ${selectedSpan?.traceId === span.traceId && selectedSpan?.spanId === span.spanId ? 'bg-orange-500/10' : ''}`}
									onclick={() => onSelectSpan(span)}
								>
									<div class="min-w-0" style={`padding-left: ${span.depth * 18}px`}>
										<div class="flex items-center gap-2">
											<div class={`h-2.5 w-2.5 rounded-full ${statusTone(span)}`}></div>
											<p class="truncate font-mono text-[13px] text-zinc-100">{span.operationName}</p>
										</div>
										<div class="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-zinc-500">
											<span>{formatTime(span.startTime)}</span>
											{#if (llmCounts[key] ?? 0) > 0}
												<Badge variant="outline" class="border-cyan-500/20 bg-cyan-500/10 text-[10px] text-cyan-100">
													LLM {(llmCounts[key] ?? 0)}
												</Badge>
											{/if}
											{#if (toolCounts[key] ?? 0) > 0}
												<Badge variant="outline" class="border-emerald-500/20 bg-emerald-500/10 text-[10px] text-emerald-100">
													Tools {(toolCounts[key] ?? 0)}
												</Badge>
											{/if}
											{#if (logCounts[key] ?? 0) > 0}
												<Badge variant="outline" class="border-amber-500/20 bg-amber-500/10 text-[10px] text-amber-100">
													Logs {(logCounts[key] ?? 0)}
												</Badge>
											{/if}
										</div>
									</div>
									<div class="truncate font-mono text-[11px] text-zinc-400">{span.serviceName}</div>
									<div class="text-[11px]">
										<span class={`inline-flex rounded-full px-2 py-0.5 font-mono ${span.status === 'error' ? 'bg-red-500/15 text-red-200' : 'bg-white/5 text-zinc-300'}`}>
											{span.status}
										</span>
									</div>
									<div class="font-mono text-[11px] text-zinc-300">{formatDuration(span.duration)}</div>
									<div class="relative my-1 h-6 rounded-full bg-white/[0.05]">
										<div
											class={`absolute inset-y-1 rounded-full ${span.status === 'error' ? 'bg-gradient-to-r from-red-500/80 to-orange-400/70' : (llmCounts[key] ?? 0) > 0 ? 'bg-gradient-to-r from-cyan-500/80 to-sky-300/70' : (toolCounts[key] ?? 0) > 0 ? 'bg-gradient-to-r from-emerald-500/80 to-lime-300/70' : 'bg-gradient-to-r from-orange-500/80 to-amber-300/70'}`}
											style={`left:${offsetPct(span)}%; width:${widthPct(span)}%;`}
										></div>
									</div>
								</button>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</section>
