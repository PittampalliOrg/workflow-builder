<script lang="ts">
	type Point = { evaluatedAt: string; count: number };
	type Props = {
		data: Point[];
		total: number;
		startedAt?: string | null;
		completedAt?: string | null;
		class?: string;
	};

	const { data, total, startedAt, completedAt, class: className = '' }: Props = $props();

	const W = 320;
	const H = 80;
	const PAD = 6;

	const path = $derived.by(() => {
		if (data.length === 0 || total <= 0) return '';
		const start = startedAt ? new Date(startedAt).getTime() : new Date(data[0].evaluatedAt).getTime();
		const end = completedAt
			? new Date(completedAt).getTime()
			: new Date(data[data.length - 1].evaluatedAt).getTime();
		const span = Math.max(1, end - start);
		const points = data.map((p) => {
			const x = PAD + ((new Date(p.evaluatedAt).getTime() - start) / span) * (W - 2 * PAD);
			const y = H - PAD - (p.count / total) * (H - 2 * PAD);
			return { x, y };
		});
		// step-after polyline (cumulative count holds until next event)
		let d = `M ${PAD.toFixed(1)} ${(H - PAD).toFixed(1)}`;
		for (const p of points) {
			d += ` L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
		}
		// extend the line out to the right edge using the last value
		if (points.length > 0) {
			const last = points[points.length - 1];
			d += ` L ${(W - PAD).toFixed(1)} ${last.y.toFixed(1)}`;
		}
		return d;
	});

	const fillPath = $derived.by(() => {
		const p = path;
		if (!p) return '';
		return `${p} L ${(W - PAD).toFixed(1)} ${(H - PAD).toFixed(1)} Z`;
	});

	const finalCount = $derived(data.length > 0 ? data[data.length - 1].count : 0);
	const finalPct = $derived(total > 0 ? finalCount / total : 0);
</script>

<div class="rounded-md border border-border bg-background p-4 {className}">
	<div class="mb-3 flex items-center justify-between">
		<h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
			Cumulative resolved
		</h3>
		<span class="text-[10px] tabular-nums text-muted-foreground">
			{finalCount}/{total} ({Math.round(finalPct * 100)}%)
		</span>
	</div>
	{#if data.length === 0}
		<p class="py-6 text-center text-xs text-muted-foreground">No resolves yet.</p>
	{:else}
		<svg viewBox={`0 0 ${W} ${H}`} class="h-20 w-full">
			<line
				x1={PAD}
				x2={W - PAD}
				y1={H - PAD}
				y2={H - PAD}
				stroke="currentColor"
				stroke-opacity="0.1"
				stroke-width="1"
			/>
			<path d={fillPath} fill="rgb(16 185 129 / 0.18)" />
			<path d={path} fill="none" stroke="rgb(16 185 129)" stroke-width="1.75" />
		</svg>
	{/if}
</div>
