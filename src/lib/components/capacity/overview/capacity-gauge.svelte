<script lang="ts">
	/**
	 * 270° radial gauge for the Capacity Overview hero. The arc opens at the
	 * bottom: starts at 8-o'clock, sweeps clockwise to 4-o'clock.
	 *
	 * Tone thresholds match `usage-bar.svelte`:
	 *   <70%  emerald
	 *   70-89% amber
	 *   ≥90%  rose
	 *
	 * When `over > 0` (Kueue borrowing past nominal), the entire used arc
	 * renders rose and a small `+N%` borrow badge is shown.
	 *
	 * Nominal of 0 is rendered with an em-dash center and a neutral arc.
	 */
	type Props = {
		used: number;
		nominal: number;
		over?: number;
		primaryLabel: string;
		secondaryLabel?: string;
		tertiaryLabel?: string;
		size?: number;
		strokeWidth?: number;
	};

	let {
		used,
		nominal,
		over = 0,
		primaryLabel,
		secondaryLabel,
		tertiaryLabel,
		size = 220,
		strokeWidth = 18
	}: Props = $props();

	const VIEWBOX = 100;
	const CX = 50;
	const CY = 50;
	const RADIUS = 40;
	const STROKE = $derived((strokeWidth / size) * VIEWBOX);

	// Gauge geometry: 270° arc starting at 8-o'clock (angle 135 from top, clockwise = -135 normalized),
	// ending at 4-o'clock (angle 225 from top, clockwise = +135 normalized).
	const START_ANGLE = -135;
	const END_ANGLE = 135;
	const SWEEP_DEGREES = END_ANGLE - START_ANGLE; // 270°

	function polar(angleDeg: number): [number, number] {
		// 0 = top, clockwise. Convert to standard math by subtracting 90.
		const rad = ((angleDeg - 90) * Math.PI) / 180;
		return [CX + RADIUS * Math.cos(rad), CY + RADIUS * Math.sin(rad)];
	}

	function arcPath(startAngle: number, endAngle: number): string {
		const [sx, sy] = polar(startAngle);
		const [ex, ey] = polar(endAngle);
		const largeArc = Math.abs(endAngle - startAngle) > 180 ? 1 : 0;
		const sweep = endAngle > startAngle ? 1 : 0;
		return `M ${sx} ${sy} A ${RADIUS} ${RADIUS} 0 ${largeArc} ${sweep} ${ex} ${ey}`;
	}

	const safeNominal = $derived(nominal > 0 ? nominal : 0);
	const ratio = $derived(safeNominal > 0 ? Math.max(0, Math.min(1, used / safeNominal)) : 0);
	const percent = $derived(safeNominal > 0 ? Math.round(ratio * 100) : 0);
	const overPercent = $derived(
		safeNominal > 0 && over > 0 ? Math.round((over / safeNominal) * 100) : 0
	);

	const tone = $derived.by(() => {
		if (safeNominal <= 0) return 'neutral';
		if (over > 0 || percent >= 90) return 'rose';
		if (percent >= 70) return 'amber';
		return 'emerald';
	});

	const toneClass = $derived(
		tone === 'rose'
			? 'stroke-rose-500'
			: tone === 'amber'
				? 'stroke-amber-500'
				: tone === 'emerald'
					? 'stroke-emerald-500'
					: 'stroke-muted-foreground/40'
	);

	const backgroundPath = $derived(arcPath(START_ANGLE, END_ANGLE));
	const usedEndAngle = $derived(START_ANGLE + ratio * SWEEP_DEGREES);
	const usedPath = $derived(
		ratio > 0 ? arcPath(START_ANGLE, usedEndAngle) : null
	);
</script>

<div class="flex flex-col items-center gap-2" style="width: {size}px;">
	<div class="relative" style="width: {size}px; height: {size}px;">
		<svg
			viewBox="0 0 {VIEWBOX} {VIEWBOX}"
			class="block"
			width={size}
			height={size}
			role="img"
			aria-label={`${primaryLabel} ${secondaryLabel ?? ''}`}
		>
			<!-- background track -->
			<path
				d={backgroundPath}
				fill="none"
				stroke="currentColor"
				stroke-width={STROKE}
				stroke-linecap="round"
				class="text-muted/40"
			/>
			<!-- used arc -->
			{#if usedPath}
				<path
					d={usedPath}
					fill="none"
					stroke="currentColor"
					stroke-width={STROKE}
					stroke-linecap="round"
					class="{toneClass} transition-[d] duration-500 ease-out"
				/>
			{/if}
		</svg>

		<!-- center labels -->
		<div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
			{#if safeNominal <= 0}
				<span class="text-3xl font-semibold tabular-nums text-muted-foreground">—</span>
			{:else}
				<span
					class="text-4xl font-semibold tabular-nums leading-none {tone === 'rose'
						? 'text-rose-600 dark:text-rose-400'
						: tone === 'amber'
							? 'text-amber-600 dark:text-amber-400'
							: 'text-foreground'}"
				>
					{percent}%
				</span>
			{/if}
			{#if secondaryLabel}
				<span class="mt-1.5 text-xs font-mono text-muted-foreground tabular-nums">
					{secondaryLabel}
				</span>
			{/if}
			{#if tertiaryLabel}
				<span class="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/80">
					{tertiaryLabel}
				</span>
			{/if}
			{#if overPercent > 0}
				<span
					class="mt-1.5 inline-flex items-center rounded-full border border-rose-500/40 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-mono text-rose-700 dark:text-rose-400"
					title="Kueue borrowing over nominal quota"
				>
					+{overPercent}% borrow
				</span>
			{/if}
		</div>
	</div>
	<span class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
		{primaryLabel}
	</span>
</div>
