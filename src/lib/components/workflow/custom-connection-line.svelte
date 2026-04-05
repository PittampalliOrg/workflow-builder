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

	// Distance for intensity scaling
	let distance = $derived(Math.hypot(toX - fromX, toY - fromY));
	let intensity = $derived(Math.min(distance / 200, 1));
</script>

<g>
	<!-- Outer glow (grows with distance) -->
	<path
		d={path}
		fill="none"
		stroke="var(--primary)"
		stroke-width={6 + intensity * 4}
		opacity={0.06 + intensity * 0.08}
		stroke-linecap="round"
		filter="blur(6px)"
	/>

	<!-- Mid glow layer -->
	<path
		d={path}
		fill="none"
		stroke="var(--primary)"
		stroke-width={3 + intensity * 2}
		opacity={0.15 + intensity * 0.1}
		stroke-linecap="round"
		filter="blur(3px)"
	/>

	<!-- Main dashed line -->
	<path
		d={path}
		fill="none"
		stroke="var(--primary)"
		stroke-width={1.5 + intensity * 0.5}
		stroke-dasharray="6 4"
		stroke-linecap="round"
		opacity={0.7 + intensity * 0.3}
		class="cl-dash"
	/>

	<!-- Traveling pulse particle -->
	<circle r={3 + intensity * 2} fill="var(--primary)" opacity={0.6 + intensity * 0.4} class="cl-particle">
		<animateMotion dur="0.8s" repeatCount="indefinite" keyPoints="0;1" keyTimes="0;1" calcMode="linear">
			<mpath href="#cl-motion-path" />
		</animateMotion>
	</circle>

	<!-- Hidden path for particle motion -->
	<path id="cl-motion-path" d={path} fill="none" stroke="none" />

	<!-- Cursor dot at the endpoint -->
	<circle
		cx={toX}
		cy={toY}
		r={5 + intensity * 3}
		fill="var(--primary)"
		opacity={0.2 + intensity * 0.15}
		class="cl-cursor-glow"
	/>
	<circle
		cx={toX}
		cy={toY}
		r={3}
		fill="var(--primary)"
		opacity={0.8}
	/>

	<!-- Source origin pulse -->
	<circle
		cx={fromX}
		cy={fromY}
		r="6"
		fill="none"
		stroke="var(--primary)"
		stroke-width="1.5"
		opacity="0.4"
		class="cl-origin-pulse"
	/>
</g>

<style>
	@keyframes cl-dash-flow {
		to {
			stroke-dashoffset: -20;
		}
	}

	.cl-dash {
		animation: cl-dash-flow 0.4s linear infinite;
	}

	.cl-particle {
		filter: drop-shadow(0 0 4px var(--primary));
	}

	@keyframes cl-cursor-pulse {
		0%, 100% { r: 5; opacity: 0.2; }
		50% { r: 10; opacity: 0.05; }
	}

	.cl-cursor-glow {
		animation: cl-cursor-pulse 1s ease-in-out infinite;
	}

	@keyframes cl-origin-ring {
		0% { r: 4; opacity: 0.5; stroke-width: 1.5; }
		100% { r: 14; opacity: 0; stroke-width: 0.5; }
	}

	.cl-origin-pulse {
		animation: cl-origin-ring 1.2s ease-out infinite;
	}
</style>
