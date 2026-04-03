<script lang="ts">
	import { getBezierPath, Position } from '@xyflow/svelte';

	let {
		fromX = 0,
		fromY = 0,
		toX = 0,
		toY = 0,
		fromPosition = Position.Bottom,
		toPosition = Position.Top
	}: {
		fromX?: number;
		fromY?: number;
		toX?: number;
		toY?: number;
		fromPosition?: Position;
		toPosition?: Position;
	} = $props();

	let [path] = $derived(
		getBezierPath({
			sourceX: fromX,
			sourceY: fromY,
			sourcePosition: fromPosition,
			targetX: toX,
			targetY: toY,
			targetPosition: toPosition
		})
	);
</script>

<g>
	<path
		d={path}
		fill="none"
		stroke="var(--primary)"
		stroke-width="1.5"
		stroke-dasharray="6 4"
		opacity="0.6"
		class="connection-line-path"
	/>
	<path
		d={path}
		fill="none"
		stroke="var(--primary)"
		stroke-width="4"
		opacity="0.1"
		filter="blur(3px)"
	/>
</g>

<style>
	@keyframes connection-dash {
		to {
			stroke-dashoffset: -20;
		}
	}

	.connection-line-path {
		animation: connection-dash 0.5s linear infinite;
	}
</style>
