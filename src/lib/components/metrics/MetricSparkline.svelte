<script lang="ts">
	/**
	 * Compact SVG sparkline for a single time series.
	 *
	 * Renders a single polyline with min/max gridless axis. Used today by:
	 *   - capacity/overview: Dapr workflow scheduling-latency trend
	 *   - in-progress run detail: activity rate over the last minute
	 *
	 * Points are assumed pre-bucketed in chronological order. Empty arrays
	 * render a dashed placeholder of the same dimensions, so layout doesn't
	 * shift when data arrives.
	 */
	type Point = { t: Date; value: number };
	type Props = {
		points: Point[];
		width?: number;
		height?: number;
		strokeColor?: string;
		fillColor?: string;
		strokeWidth?: number;
		ariaLabel?: string;
	};

	let {
		points,
		width = 96,
		height = 24,
		strokeColor = 'currentColor',
		fillColor,
		strokeWidth = 1.5,
		ariaLabel = 'sparkline',
	}: Props = $props();

	const path = $derived.by(() => {
		if (points.length === 0) return { line: '', fill: '', min: 0, max: 0 };
		const values = points.map((p) => p.value);
		const min = Math.min(...values);
		const max = Math.max(...values);
		const span = max - min || 1;
		const xStep = points.length > 1 ? width / (points.length - 1) : width / 2;
		const yFor = (v: number) =>
			height - ((v - min) / span) * (height - strokeWidth) - strokeWidth / 2;
		const xFor = (i: number) => (points.length > 1 ? i * xStep : width / 2);
		const linePts = points
			.map((p, i) => `${xFor(i).toFixed(2)},${yFor(p.value).toFixed(2)}`)
			.join(' ');
		const line = `M ${linePts.replace(/ /g, ' L ')}`;
		const fill = fillColor
			? `${line} L ${xFor(points.length - 1).toFixed(2)},${height} L 0,${height} Z`
			: '';
		return { line, fill, min, max };
	});
</script>

<svg
	{width}
	{height}
	viewBox="0 0 {width} {height}"
	aria-label={ariaLabel}
	role="img"
	class="overflow-visible"
>
	{#if points.length === 0}
		<line
			x1="0"
			y1={height / 2}
			x2={width}
			y2={height / 2}
			stroke="currentColor"
			stroke-opacity="0.15"
			stroke-dasharray="2 2"
		/>
	{:else}
		{#if fillColor && path.fill}
			<path d={path.fill} fill={fillColor} fill-opacity="0.15" stroke="none" />
		{/if}
		<path
			d={path.line}
			fill="none"
			stroke={strokeColor}
			stroke-width={strokeWidth}
			stroke-linejoin="round"
			stroke-linecap="round"
		/>
	{/if}
</svg>
