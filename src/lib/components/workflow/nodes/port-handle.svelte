<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';
	import type { PortConfig } from '$lib/types/workflow-handles';

	interface Props {
		port: PortConfig;
		style?: string;
	}

	let { port, style = '' }: Props = $props();

	const positionMap: Record<string, Position> = {
		top: Position.Top,
		bottom: Position.Bottom,
		left: Position.Left,
		right: Position.Right
	};

	let position = $derived(positionMap[port.position]);
</script>

<Handle type={port.type} {position} id={port.id} {style} />
{#if port.label}
	<span
		class="wb-handle-label pointer-events-none absolute text-[9px] text-muted-foreground"
		style={port.position === 'bottom'
			? `bottom: -16px; ${style}`
			: port.position === 'top'
				? `top: -16px; ${style}`
				: ''}
	>
		{port.label}
	</span>
{/if}
