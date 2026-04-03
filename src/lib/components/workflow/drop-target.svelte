<script lang="ts">
	import { useSvelteFlow } from '@xyflow/svelte';
	import { getContext } from 'svelte';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import type { WorkflowNodeType } from '$lib/stores/workflow.svelte';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');
	const { screenToFlowPosition } = useSvelteFlow();

	function onDragOver(event: DragEvent) {
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}
	}

	function onDrop(event: DragEvent) {
		event.preventDefault();
		const type = event.dataTransfer?.getData('application/svelteflow-nodetype');
		if (!type) return;

		const position = screenToFlowPosition({
			x: event.clientX,
			y: event.clientY
		});

		store.addNode(type as WorkflowNodeType, position);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="absolute inset-0"
	ondragover={onDragOver}
	ondrop={onDrop}
	style="pointer-events: none;"
>
	<!-- Invisible overlay that handles drop events; pointer-events are re-enabled on dragover by the browser -->
</div>
