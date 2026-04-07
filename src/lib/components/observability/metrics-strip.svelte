<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';

	interface MetricItem {
		label: string;
		value: string;
		meta?: string | null;
		tone?: 'default' | 'error' | 'llm' | 'tool' | 'log';
	}

	interface ServiceSummary {
		name: string;
		durationMs: number;
		errors: number;
	}

	interface Props {
		title: string;
		subtitle?: string | null;
		metrics: MetricItem[];
		topServices?: ServiceSummary[];
		slowestSpanLabel?: string | null;
		slowestSpanDuration?: string | null;
		timeWindowLabel?: string | null;
	}

	let {
		title,
		subtitle = null,
		metrics,
		topServices = [],
		slowestSpanLabel = null,
		slowestSpanDuration = null,
		timeWindowLabel = null
	}: Props = $props();

	function toneClasses(tone: MetricItem['tone']): string {
		switch (tone) {
			case 'error':
				return 'border-red-500/20 bg-red-500/10 text-red-50';
			case 'llm':
				return 'border-cyan-500/20 bg-cyan-500/10 text-cyan-50';
			case 'tool':
				return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-50';
			case 'log':
				return 'border-amber-500/20 bg-amber-500/10 text-amber-50';
			default:
				return 'border-white/10 bg-white/5 text-zinc-50';
		}
	}
</script>

<section class="rounded-[26px] border border-white/10 bg-[linear-gradient(180deg,rgba(18,18,22,0.96),rgba(11,11,15,0.98))] p-4 shadow-[0_18px_50px_rgba(0,0,0,0.28)]">
	<div class="flex flex-wrap items-start justify-between gap-4">
		<div>
			<p class="text-[11px] font-medium uppercase tracking-[0.28em] text-zinc-500">Observability</p>
			<h2 class="mt-2 text-xl font-semibold tracking-tight text-zinc-50">{title}</h2>
			{#if subtitle}
				<p class="mt-1 text-sm text-zinc-400">{subtitle}</p>
			{/if}
		</div>

		<div class="flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
			{#if slowestSpanLabel && slowestSpanDuration}
				<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-[10px] text-zinc-200">
					Slowest {slowestSpanDuration}
				</Badge>
				<span class="max-w-[28ch] truncate">{slowestSpanLabel}</span>
			{/if}
			{#if timeWindowLabel}
				<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-[10px] text-zinc-300">
					{timeWindowLabel}
				</Badge>
			{/if}
		</div>
	</div>

	<div class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-8">
		{#each metrics as metric}
			<div class={`rounded-2xl border px-3 py-3 ${toneClasses(metric.tone)}`}>
				<p class="text-[10px] uppercase tracking-[0.22em] text-zinc-400">{metric.label}</p>
				<p class="mt-2 font-mono text-xl font-semibold">{metric.value}</p>
				{#if metric.meta}
					<p class="mt-1 truncate text-[11px] text-zinc-400">{metric.meta}</p>
				{/if}
			</div>
		{/each}
	</div>

	{#if topServices.length > 0}
		<div class="mt-4 flex flex-wrap items-center gap-2">
			<p class="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Top services</p>
			{#each topServices as service}
				<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-[10px] text-zinc-200">
					{service.name} {service.durationMs < 1000 ? `${Math.round(service.durationMs)}ms` : `${(service.durationMs / 1000).toFixed(2)}s`}
					{#if service.errors > 0}
						<span class="ml-1 text-red-300">({service.errors} err)</span>
					{/if}
				</Badge>
			{/each}
		</div>
	{/if}
</section>
