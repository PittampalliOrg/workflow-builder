<script lang="ts">
	/**
	 * Horizontal phase-attribution waterfall.
	 *
	 * Each phase is a coloured segment whose width is proportional to its ms /
	 * totalMs. If totalMs > Σ phases.ms, the trailing gap stays uncoloured —
	 * makes it obvious when there's unaccounted time (e.g., queue + cold-start
	 * + inference + eval don't add up to wall-clock).
	 *
	 * Used today by /workspaces/<slug>/benchmarks/runs/<runId> to attribute
	 * run wall-clock to {queue, sandbox-startup, inference, evaluation}.
	 */
	type Phase = {
		label: string;
		ms: number;
		color?: string;
		tooltip?: string;
	};
	type Props = {
		phases: Phase[];
		totalMs: number;
		height?: number;
	};

	let { phases, totalMs, height = 24 }: Props = $props();

	const segments = $derived.by(() => {
		const denom = Math.max(totalMs, 1);
		const sumPhases = phases.reduce((acc, p) => acc + Math.max(0, p.ms), 0);
		const gap = Math.max(0, denom - sumPhases);
		return {
			items: phases.map((p) => ({
				...p,
				pct: (Math.max(0, p.ms) / denom) * 100,
			})),
			gapPct: (gap / denom) * 100,
		};
	});

	function fmt(ms: number): string {
		if (!Number.isFinite(ms) || ms <= 0) return '—';
		if (ms < 1000) return `${Math.round(ms)}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		return `${(ms / 60_000).toFixed(1)}m`;
	}
</script>

<div class="space-y-2">
	<div
		class="flex w-full overflow-hidden rounded border border-border bg-muted/30"
		style:height={`${height}px`}
		role="img"
		aria-label="Run-time attribution waterfall"
	>
		{#each segments.items as seg, i (i)}
			<div
				class="flex items-center justify-center text-[10px] font-medium text-white/90 transition-all"
				style:width={`${seg.pct}%`}
				style:background-color={seg.color ?? 'currentColor'}
				title={seg.tooltip ?? `${seg.label}: ${fmt(seg.ms)}`}
			>
				{#if seg.pct > 8}{fmt(seg.ms)}{/if}
			</div>
		{/each}
		{#if segments.gapPct > 0.5}
			<div
				class="flex items-center justify-center text-[10px] text-muted-foreground"
				style:width={`${segments.gapPct}%`}
				title={`Unattributed: ${fmt((segments.gapPct / 100) * totalMs)}`}
			>
				{#if segments.gapPct > 8}gap{/if}
			</div>
		{/if}
	</div>
	<ul class="flex flex-wrap gap-3 text-xs">
		{#each segments.items as seg, i (i)}
			<li class="flex items-center gap-1.5">
				<span
					class="inline-block h-2.5 w-2.5 rounded-sm"
					style:background-color={seg.color ?? 'currentColor'}
				></span>
				<span class="text-muted-foreground">{seg.label}:</span>
				<span class="font-mono">{fmt(seg.ms)}</span>
			</li>
		{/each}
	</ul>
</div>
