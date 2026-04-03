<script lang="ts">
	import {
		BaseEdge,
		getBezierPath,
		EdgeReconnectAnchor,
		type EdgeProps
	} from '@xyflow/svelte';

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
		style
	}: EdgeProps = $props();

	let [edgePath] = $derived(
		getBezierPath({
			sourceX,
			sourceY,
			sourcePosition,
			targetX,
			targetY,
			targetPosition
		})
	);

	let status = $derived((data?.status as string) || 'idle');
	let animated = $derived((data?.animated as boolean) || false);

	const PARTICLE_COUNT = 3;

	// Edge colors using color-mix (matches Next.js pattern)
	let mainStroke = $derived.by(() => {
		if (status === 'running') return 'hsl(48 96% 53%)';
		if (status === 'success') return 'hsl(142 71% 45%)';
		if (status === 'error') return 'hsl(0 84% 60%)';
		if (selected) return 'color-mix(in srgb, var(--primary) 88%, white 12%)';
		return 'color-mix(in srgb, var(--primary) 55%, var(--muted-foreground) 45%)';
	});

	let glowStroke = $derived.by(() => {
		if (status === 'running') return 'hsl(48 96% 53%)';
		if (status === 'success') return 'hsl(142 71% 45%)';
		if (status === 'error') return 'hsl(0 84% 60%)';
		if (selected) return 'color-mix(in srgb, var(--primary) 70%, white 30%)';
		return 'color-mix(in srgb, var(--primary) 40%, transparent 60%)';
	});

	let mainWidth = $derived(selected ? 2.8 : status === 'running' ? 2.4 : 2);
	let glowWidth = $derived(selected ? 7 : 5);
	let glowOpacity = $derived(selected ? 0.3 : 0.15);
</script>

<!-- Glow layer (behind main edge) -->
<path
	d={edgePath}
	fill="none"
	stroke={glowStroke}
	stroke-width={glowWidth}
	opacity={glowOpacity}
	stroke-linecap="round"
	stroke-linejoin="round"
	style="pointer-events: none; filter: drop-shadow(0 0 4px {glowStroke});"
/>

<!-- Main edge -->
<BaseEdge
	{id}
	path={edgePath}
	markerEnd="url(#arrowclosed)"
	style="stroke: {mainStroke}; stroke-width: {mainWidth}; stroke-dasharray: 8 6; stroke-linecap: round; stroke-linejoin: round; animation: dashdraw 0.7s linear infinite;"
	class="wb-edge {selected ? 'wb-edge--selected' : ''} {status !== 'idle' ? `wb-edge--${status}` : ''}"
/>

<!-- Flow particles for running edges -->
{#if status === 'running'}
	{#each { length: PARTICLE_COUNT } as _, i}
		<circle r="3" fill="hsl(48 96% 53%)" class="wb-edge__particle">
			<animateMotion
				dur="1.5s"
				repeatCount="indefinite"
				begin="{(i / PARTICLE_COUNT) * 1.5}s"
				keyPoints="0;1"
				keyTimes="0;1"
				calcMode="linear"
			>
				<mpath href="#{id}" />
			</animateMotion>
		</circle>
	{/each}
{/if}

<!-- Success: trace glow that fades -->
{#if status === 'success'}
	<path
		d={edgePath}
		fill="none"
		stroke="hsl(142 71% 45%)"
		stroke-width="4"
		opacity="0.5"
		stroke-linecap="round"
		class="wb-edge__success-glow"
	/>
{/if}

<EdgeReconnectAnchor type="source" />
<EdgeReconnectAnchor type="target" />

<style>
	/* Running edge: override dash to faster animation */
	:global(.wb-edge--running path) {
		stroke-dasharray: 8 4 !important;
		animation: wb-edge-dash 0.6s linear infinite !important;
	}

	@keyframes wb-edge-dash {
		to {
			stroke-dashoffset: -24;
		}
	}

	/* Flow particles glow */
	:global(.wb-edge__particle) {
		filter: drop-shadow(0 0 4px hsl(48 96% 53%));
	}

	/* Success glow fade */
	:global(.wb-edge__success-glow) {
		animation: wb-edge-glow-fade 1.5s ease-out forwards;
	}

	@keyframes wb-edge-glow-fade {
		0% {
			opacity: 0.6;
			stroke-width: 5;
		}
		100% {
			opacity: 0;
			stroke-width: 1;
		}
	}

	/* Error edge pulse */
	:global(.wb-edge--error path) {
		animation: wb-edge-error-pulse 1s ease-in-out 2 !important;
	}

	@keyframes wb-edge-error-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.5; }
	}
</style>
