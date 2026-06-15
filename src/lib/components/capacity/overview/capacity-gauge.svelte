<script lang="ts">
	/**
	 * 270° radial capacity gauge. The arc opens at the bottom (8 o'clock → 4
	 * o'clock, clockwise). Used at ~78px in the Fleet header and ~140px on the
	 * Capacity Overview.
	 *
	 * Design: the circle interior shows ONLY the scaled % (so it never crowds at
	 * small sizes); the resource label, used/nominal, and any borrow badge live in
	 * the footer below the arc. The used arc is a tone-graded gradient with a soft
	 * glow.
	 *
	 * Tone thresholds match `usage-bar.svelte`: <70% emerald · 70–89% amber · ≥90%
	 * rose. `over > 0` (Kueue borrowing past nominal) forces rose + a borrow badge.
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
		/** Optional secondary cap tick (e.g. Kueue admission ceiling). Same units
		 * as `nominal`; ignored unless 0 < capMark < nominal. */
		capMark?: number;
		capMarkLabel?: string;
	};

	let {
		used,
		nominal,
		over = 0,
		primaryLabel,
		secondaryLabel,
		tertiaryLabel,
		size = 220,
		strokeWidth = 18,
		capMark = 0,
		capMarkLabel
	}: Props = $props();

	const VIEWBOX = 100;
	const CX = 50;
	const CY = 50;
	const RADIUS = 40;
	const STROKE = $derived((strokeWidth / size) * VIEWBOX);

	// SSR-stable unique id so multiple gauges (different tones) on one page don't
	// collide on the gradient ref.
	const uid = $props.id();

	const START_ANGLE = -135;
	const END_ANGLE = 135;
	const SWEEP_DEGREES = END_ANGLE - START_ANGLE; // 270°

	function polar(angleDeg: number): [number, number] {
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

	// Gradient stops + glow color per tone (Tailwind 400 → 600).
	const grad = $derived.by(() => {
		switch (tone) {
			case 'rose':
				return { from: 'rgb(251 113 133)', to: 'rgb(225 29 72)', glow: 'rgba(244 63 94 / 0.45)' };
			case 'amber':
				return { from: 'rgb(251 191 36)', to: 'rgb(217 119 6)', glow: 'rgba(245 158 11 / 0.40)' };
			case 'emerald':
				return { from: 'rgb(52 211 153)', to: 'rgb(5 150 105)', glow: 'rgba(16 185 129 / 0.40)' };
			default:
				return { from: 'rgb(148 163 184)', to: 'rgb(100 116 139)', glow: 'rgba(148 163 184 / 0.25)' };
		}
	});

	const textToneClass = $derived(
		tone === 'rose'
			? 'text-rose-600 dark:text-rose-400'
			: tone === 'amber'
				? 'text-amber-600 dark:text-amber-400'
				: tone === 'emerald'
					? 'text-emerald-600 dark:text-emerald-400'
					: 'text-muted-foreground'
	);

	const backgroundPath = $derived(arcPath(START_ANGLE, END_ANGLE));
	const usedEndAngle = $derived(START_ANGLE + ratio * SWEEP_DEGREES);
	const usedPath = $derived(ratio > 0 ? arcPath(START_ANGLE, usedEndAngle) : null);

	// Cap-marker tick (only when meaningfully between 0 and nominal).
	const capRatio = $derived(
		safeNominal > 0 && capMark > 0 && capMark < safeNominal ? capMark / safeNominal : 0
	);
	const capAngle = $derived(START_ANGLE + capRatio * SWEEP_DEGREES);
	const capPercent = $derived(Math.round(capRatio * 100));
	const capTickInner = $derived.by(() => {
		if (capRatio <= 0) return null;
		const rad = ((capAngle - 90) * Math.PI) / 180;
		const inner = RADIUS - STROKE * 0.9;
		return [CX + inner * Math.cos(rad), CY + inner * Math.sin(rad)];
	});
	const capTickOuter = $derived.by(() => {
		if (capRatio <= 0) return null;
		const rad = ((capAngle - 90) * Math.PI) / 180;
		const outer = RADIUS + STROKE * 0.9;
		return [CX + outer * Math.cos(rad), CY + outer * Math.sin(rad)];
	});

	// Scale the center % with the gauge size so it never overflows the arc.
	const percentFont = $derived(Math.round(size * 0.27));
	const glowRadius = $derived(Math.max(2, Math.round(size * 0.045)));
</script>

<div class="flex flex-col items-center gap-2" style="width: {size}px;">
	<div class="relative" style="width: {size}px; height: {size}px;">
		<svg
			viewBox="0 0 {VIEWBOX} {VIEWBOX}"
			class="block overflow-visible"
			width={size}
			height={size}
			role="img"
			aria-label={`${primaryLabel} ${percent}%`}
		>
			<defs>
				<linearGradient id="cg-{uid}" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stop-color={grad.from} />
					<stop offset="100%" stop-color={grad.to} />
				</linearGradient>
			</defs>

			<!-- background track -->
			<path
				d={backgroundPath}
				fill="none"
				stroke="currentColor"
				stroke-width={STROKE}
				stroke-linecap="round"
				class="text-muted/40"
			/>

			<!-- used arc: tone gradient + soft glow -->
			{#if usedPath}
				<path
					d={usedPath}
					fill="none"
					stroke="url(#cg-{uid})"
					stroke-width={STROKE}
					stroke-linecap="round"
					class="transition-[d] duration-500 ease-out"
					style="filter: drop-shadow(0 0 {glowRadius}px {grad.glow});"
				/>
			{/if}

			<!-- cap marker (optional secondary threshold tick) -->
			{#if capTickInner && capTickOuter}
				<line
					x1={capTickInner[0]}
					y1={capTickInner[1]}
					x2={capTickOuter[0]}
					y2={capTickOuter[1]}
					stroke="currentColor"
					stroke-width={STROKE * 0.18}
					stroke-linecap="round"
					class="text-foreground/80"
				>
					<title>{capMarkLabel ?? 'cap'} at {capPercent}%</title>
				</line>
			{/if}
		</svg>

		<!-- center: only the scaled % -->
		<div class="pointer-events-none absolute inset-0 flex items-center justify-center">
			{#if safeNominal <= 0}
				<span class="font-semibold tabular-nums text-muted-foreground" style="font-size: {percentFont}px; line-height: 1;">—</span>
			{:else}
				<span class="font-semibold tabular-nums {textToneClass}" style="font-size: {percentFont}px; line-height: 1;">
					{percent}<span style="font-size: {Math.round(percentFont * 0.5)}px;" class="font-medium opacity-70">%</span>
				</span>
			{/if}
		</div>
	</div>

	<!-- footer: label · used/nominal · tertiary · borrow badge -->
	<div class="flex max-w-full flex-col items-center gap-0.5 text-center leading-tight">
		<span class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{primaryLabel}</span>
		{#if secondaryLabel}
			<span class="max-w-full truncate font-mono text-[11px] tabular-nums text-foreground/80">{secondaryLabel}</span>
		{/if}
		{#if tertiaryLabel}
			<span class="text-[10px] uppercase tracking-wide text-muted-foreground/70">{tertiaryLabel}</span>
		{/if}
		{#if overPercent > 0}
			<span
				class="mt-0.5 inline-flex items-center rounded-full border border-rose-500/40 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-mono text-rose-700 dark:text-rose-400"
				title="Kueue borrowing over nominal quota"
			>
				+{overPercent}% borrow
			</span>
		{/if}
	</div>
</div>
