<script lang="ts">
	/**
	 * Hand-rolled SVG candlestick (LayerChart has no candlestick primitive, so
	 * this follows the same SVG approach as capacity-gauge.svelte). Each candle
	 * is one time bucket of a utilization % series — open / high / low / close —
	 * showing how capacity utilization churned within the bucket as workloads
	 * became active. Up candle (close ≥ open) = emerald, down = rose. Faint
	 * emerald/amber/rose zone bands behind reinforce the danger zones (high
	 * utilization = bad): emerald below `warn`, amber `warn`–`crit`, rose above.
	 */
	export type Candle = { t: number; open: number; high: number; low: number; close: number };

	type Props = {
		candles: Candle[];
		/** Domain max (default 100 for a percentage series). */
		valueMax?: number;
		height?: number;
		/** Utilization danger thresholds (percent). Drawn faint behind the candles. */
		zones?: { warn: number; crit: number } | null;
	};

	let { candles, valueMax = 100, height = 120, zones = { warn: 70, crit: 90 } }: Props = $props();

	// Fixed coordinate space; the SVG scales to its container via viewBox.
	const W = 300;
	const H = $derived(height);
	const PAD_T = 6;
	const PAD_B = 6;
	const plotH = $derived(H - PAD_T - PAD_B);

	const n = $derived(candles.length);
	const slot = $derived(n > 0 ? W / n : W);
	const bodyW = $derived(Math.max(2, Math.min(18, slot * 0.6)));

	function y(v: number): number {
		const clamped = Math.max(0, Math.min(valueMax, v));
		return PAD_T + plotH * (1 - clamped / valueMax);
	}

	const bands = $derived.by(() => {
		if (!zones) return [];
		return [
			{ from: 0, to: zones.warn, cls: 'fill-emerald-500/10' },
			{ from: zones.warn, to: zones.crit, cls: 'fill-amber-500/12' },
			{ from: zones.crit, to: valueMax, cls: 'fill-rose-500/15' }
		];
	});
</script>

{#if n === 0}
	<p class="py-6 text-center text-[11px] text-muted-foreground/70">Waiting for capacity samples…</p>
{:else}
	<svg viewBox="0 0 {W} {H}" class="h-full w-full" preserveAspectRatio="none" role="img" aria-label="Capacity range candlestick">
		<!-- zone bands -->
		{#each bands as band (band.cls)}
			<rect x="0" y={y(band.to)} width={W} height={Math.max(0, y(band.from) - y(band.to))} class={band.cls} />
		{/each}
		<!-- candles -->
		{#each candles as c, i (c.t)}
			{@const cx = i * slot + slot / 2}
			{@const up = c.close >= c.open}
			{@const stroke = up ? 'rgb(16 185 129)' : 'rgb(244 63 94)'}
			{@const bodyTop = y(Math.max(c.open, c.close))}
			{@const bodyBot = y(Math.min(c.open, c.close))}
			<!-- wick -->
			<line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} stroke={stroke} stroke-width="1" opacity="0.85" />
			<!-- body -->
			<rect
				x={cx - bodyW / 2}
				y={bodyTop}
				width={bodyW}
				height={Math.max(1.5, bodyBot - bodyTop)}
				fill={stroke}
				opacity="0.9"
				rx="1"
			>
				<title>{`O ${c.open.toFixed(0)} · H ${c.high.toFixed(0)} · L ${c.low.toFixed(0)} · C ${c.close.toFixed(0)}`}</title>
			</rect>
		{/each}
	</svg>
{/if}
