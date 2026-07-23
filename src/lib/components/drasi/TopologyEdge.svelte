<script lang="ts">
	import {
		BaseEdge,
		EdgeLabel,
		getBezierPath,
		type EdgeProps,
	} from "@xyflow/svelte";
	import type { DrasiEdgeSpec } from "$lib/types/drasi";

	let {
		id,
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
		data,
		selected,
		markerEnd,
	}: EdgeProps = $props();

	let spec = $derived(data?.spec as DrasiEdgeSpec | undefined);

	let pathData = $derived(
		getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }),
	);
	let edgePath = $derived(pathData[0]);
	let labelX = $derived(pathData[1]);
	let labelY = $derived(pathData[2]);

	let stroke = $derived(
		selected
			? "var(--primary)"
			: spec?.animated
				? "color-mix(in oklch, var(--primary) 55%, var(--border))"
				: "var(--border)",
	);
</script>

<BaseEdge
	{id}
	path={edgePath}
	{markerEnd}
	style="stroke: {stroke}; stroke-width: {selected ? 2 : 1.5};"
/>
{#if spec?.label}
	<!-- EdgeLabel portals into the flow's HTML edge-label layer and centers
		itself at (x, y); scoped styles can't reach portaled content, so the
		label classes below are global. -->
	<EdgeLabel
		x={labelX}
		y={labelY}
		class="drasi-edge-label{selected ? ' drasi-edge-label--selected' : ''}"
	>
		{spec.label}
	</EdgeLabel>
{/if}

<style>
	:global(.drasi-edge-label) {
		/* Keep the label non-interactive (EdgeLabel sets pointer-events: all
			inline so labels can opt into click-to-select). */
		pointer-events: none !important;
		font-size: 9px;
		line-height: 1;
		padding: 3px 5px;
		border-radius: 4px;
		border: 1px solid var(--border);
		background: color-mix(in oklch, var(--background) 88%, transparent);
		color: var(--muted-foreground);
		backdrop-filter: blur(4px);
	}
	:global(.drasi-edge-label.drasi-edge-label--selected) {
		border-color: var(--primary);
		color: var(--foreground);
	}
</style>
