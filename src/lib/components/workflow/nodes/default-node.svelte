<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';
	import { Circle } from 'lucide-svelte';
	import type { WorkflowNodeData } from '$lib/stores/workflow.svelte';

	interface Props {
		data: WorkflowNodeData;
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	let statusColor = $derived(
		data.status === 'running'
			? 'border-yellow-500'
			: data.status === 'success'
				? 'border-green-500'
				: data.status === 'error'
					? 'border-red-500'
					: 'border-border'
	);
</script>

<div
	class="rounded-lg border-2 bg-card px-4 py-3 shadow-sm transition-colors {statusColor} {selected
		? 'ring-2 ring-ring'
		: ''}"
>
	<Handle type="target" position={Position.Top} />

	<div class="flex items-center gap-2">
		<div class="rounded-md bg-gray-100 p-1.5 dark:bg-gray-800">
			<Circle size={14} class="text-gray-600 dark:text-gray-400" />
		</div>
		<div>
			<div class="text-xs font-medium text-card-foreground">{data.label}</div>
			{#if data.description}
				<div class="text-xs text-muted-foreground">{data.description}</div>
			{/if}
		</div>
	</div>

	<Handle type="source" position={Position.Bottom} />
</div>
