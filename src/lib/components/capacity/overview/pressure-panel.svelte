<script lang="ts">
	/**
	 * Linux PSI (Pressure Stall Information) panel — the "is the cluster
	 * actually struggling?" companion to the Kueue-budget gauge.
	 *
	 * The Kueue gauge on ryzen reads ~100% under normal load because the
	 * budget is intentionally pinned to the per-worker Docker memory wall
	 * (see kueue-capacity/RATIONALE.md). That gauge is honest about Kueue's
	 * admission cap, but says nothing about whether the underlying nodes
	 * are actually stalling on CPU/memory/IO.
	 *
	 * PSI (K8s 1.36 GA, exposed via kubelet `/stats/summary`) answers that
	 * directly: `some.avg60` is the share of the last 60s with ANY task
	 * stalled on the resource. Memory PSI rising before OOM-crashing is the
	 * specific signal that motivated the K8s 1.36 upgrade.
	 */
	import { Activity } from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import MetricSparkline from '$lib/components/metrics/MetricSparkline.svelte';
	import type { CapacityPsiSnapshot } from '$lib/types/capacity';
	import type { HistoryPoint } from './capacity-trends-panel.svelte';

	type Props = {
		/** Current snapshot's PSI block (live values). Undefined when scrape failed or pre-K8s 1.36. */
		psi: CapacityPsiSnapshot | undefined;
		/** Rolling history for the sparklines (typically last 5 min @ 5s). */
		history: HistoryPoint[];
	};

	let { psi, history }: Props = $props();

	// Per-row tone — green < 5%, amber 5-15%, rose ≥ 15%. Tuned to the
	// observer's PSI_WARN_THRESHOLD=10% memory floor. Easy to adjust once
	// we've watched real SWE-bench runs.
	function toneClass(avg60: number | null | undefined): string {
		const v = avg60 ?? 0;
		if (v >= 15) return 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300';
		if (v >= 5) return 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300';
		return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
	}

	function strokeColor(avg60: number | null | undefined): string {
		const v = avg60 ?? 0;
		if (v >= 15) return 'rgb(244 63 94)'; // rose-500
		if (v >= 5) return 'rgb(245 158 11)'; // amber-500
		return 'rgb(16 185 129)'; // emerald-500
	}

	function formatPct(v: number | null | undefined): string {
		if (v === null || v === undefined) return '—';
		if (v < 0.01) return '0.00%';
		if (v < 1) return `${v.toFixed(2)}%`;
		return `${v.toFixed(1)}%`;
	}

	type Row = {
		label: string;
		current: { avg10?: number; avg60?: number; avg300?: number } | undefined;
		historyKey: 'psiCpuSome60' | 'psiMemorySome60' | 'psiIoSome60';
		hint: string;
	};

	const rows = $derived<Row[]>([
		{
			label: 'CPU',
			current: psi?.cpu?.some,
			historyKey: 'psiCpuSome60',
			hint: 'CPU pressure (some): % of wallclock with ANY task waiting on CPU'
		},
		{
			label: 'Memory',
			current: psi?.memory?.some,
			historyKey: 'psiMemorySome60',
			hint: 'Memory pressure (some): early warning of the Docker per-worker memory wall'
		},
		{
			label: 'IO',
			current: psi?.io?.some,
			historyKey: 'psiIoSome60',
			hint: 'IO pressure (some): % of wallclock with ANY task waiting on disk / cgroup IO'
		}
	]);

	function sparklinePoints(rows: HistoryPoint[], key: Row['historyKey']) {
		return rows
			.filter((p) => p[key] !== null && p[key] !== undefined)
			.map((p) => ({ t: new Date(p.t), value: p[key] as number }));
	}

	const psiPresent = $derived(!!psi && (psi.cpu || psi.memory || psi.io));

	function perNodeTooltip(historyKey: Row['historyKey']): string {
		const perNode = psi?.perNode;
		if (!perNode) return '';
		const lines: string[] = [];
		for (const [node, blocks] of Object.entries(perNode)) {
			const resource =
				historyKey === 'psiCpuSome60'
					? 'cpu'
					: historyKey === 'psiMemorySome60'
						? 'memory'
						: 'io';
			const v = blocks?.[resource as 'cpu' | 'memory' | 'io']?.some?.avg60;
			lines.push(`${node}: ${formatPct(v)}`);
		}
		return lines.join('\n');
	}
</script>

<div class="rounded-md border border-border bg-card p-3 shadow-sm">
	<div class="mb-2 flex items-baseline justify-between gap-2">
		<h3 class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
			<Activity class="size-3.5" />
			Node pressure (PSI)
		</h3>
		<span class="text-[10px] text-muted-foreground">
			% of 60s stalled · K8s 1.36 kubelet
		</span>
	</div>

	{#if !psiPresent}
		<p class="py-2 text-[11px] text-muted-foreground/70">
			Waiting for PSI metrics… (requires K8s ≥ 1.36 + cgroup v2)
		</p>
	{:else}
		<ul class="space-y-1.5">
			{#each rows as row (row.label)}
				{@const v = row.current?.avg60 ?? null}
				{@const points = sparklinePoints(history, row.historyKey)}
				{@const tooltip = perNodeTooltip(row.historyKey) || row.hint}
				<li
					class="grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-2"
					title={tooltip}
				>
					<span class="text-[11px] text-muted-foreground">{row.label}</span>
					<MetricSparkline
						{points}
						width={120}
						height={18}
						strokeColor={strokeColor(v)}
						strokeWidth={1.25}
					/>
					<Badge variant="outline" class="border {toneClass(v)} font-mono text-[10px] tabular-nums">
						{formatPct(v)}
					</Badge>
				</li>
			{/each}
		</ul>
		<p class="mt-1.5 text-[10px] text-muted-foreground/70">
			Hover a row for per-node breakdown. Memory ≥ 10% = approaching Docker memory wall.
		</p>
	{/if}
</div>
