<script lang="ts">
	import {
		BaseEdge,
		getBezierPath,
		EdgeLabel,
		MarkerType,
		type EdgeProps
	} from '@xyflow/svelte';
	import { Plus } from '@lucide/svelte';

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

	let [edgePath, labelX, labelY] = $derived(
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
	let label = $derived((data?.label as string) || '');

	let strokeStyle = $derived.by(() => {
		if (selected) return 'stroke: var(--primary); stroke-width: 2;';
		if (status === 'error') return 'stroke: var(--destructive); stroke-width: 1.5;';
		if (status === 'running')
			return 'stroke: var(--primary); stroke-width: 1.5; stroke-dasharray: 8 4;';
		return 'stroke: var(--muted-foreground); opacity: 0.4;';
	});

	function onInsertClick(event: MouseEvent) {
		event.stopPropagation();
		const detail = { edgeId: id, position: { x: labelX, y: labelY } };
		window.dispatchEvent(new CustomEvent('workflow:insert-on-edge', { detail }));
	}
</script>

<BaseEdge
	{id}
	path={edgePath}
	markerEnd="url(#arrowclosed)"
	style="{style || ''}{strokeStyle}"
	class={status === 'running' ? 'animated-edge-dash' : ''}
/>

{#if label || true}
	<EdgeLabel x={labelX} y={labelY}>
		{#if label}
			<span class="edge-label-text">{label}</span>
		{/if}
		<button
			class="edge-insert-btn nodrag nopan"
			onclick={onInsertClick}
			aria-label="Insert node"
		>
			<Plus size={14} />
		</button>
	</EdgeLabel>
{/if}

<style>
	:global(.edge-label-text) {
		font-size: 11px;
		color: var(--muted-foreground);
		background: var(--background);
		padding: 1px 6px;
		border-radius: 4px;
		border: 1px solid var(--border);
		margin-right: 4px;
	}

	:global(.edge-insert-btn) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		border: 1px solid var(--border);
		background: var(--background);
		color: var(--muted-foreground);
		cursor: pointer;
		opacity: 0;
		transition: opacity 0.15s ease;
	}

	:global(.edge-insert-btn:hover) {
		background: var(--primary);
		color: var(--primary-foreground);
		border-color: var(--primary);
		opacity: 1;
	}

	:global(.svelte-flow__edge:hover .edge-insert-btn) {
		opacity: 1;
	}

	@keyframes dash-animation {
		to {
			stroke-dashoffset: -24;
		}
	}

	:global(.animated-edge-dash path) {
		animation: dash-animation 0.6s linear infinite;
	}
</style>
