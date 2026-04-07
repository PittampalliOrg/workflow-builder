<script lang="ts">
	import { getContext } from 'svelte';
	import { NodeToolbar, Position } from '@xyflow/svelte';
	import { Settings, Copy, Trash2 } from 'lucide-svelte';
	import { createWorkflowStore } from '$lib/stores/workflow.svelte';

	interface Props {
		nodeId: string;
		position?: Position;
	}

	let { nodeId, position = Position.Top }: Props = $props();

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');

	function handleConfigure() {
		store.selectedNodeId = nodeId;
	}

	function handleDuplicate() {
		store.duplicateNode(nodeId);
	}

	function handleDelete() {
		store.removeNode(nodeId);
	}
</script>

<NodeToolbar {nodeId} {position}>
	<div class="nodrag nopan flex items-center gap-1 rounded-md border bg-card p-1 shadow">
		<button
			class="rounded p-1.5 hover:bg-accent"
			onclick={handleConfigure}
			title="Configure"
		>
			<Settings size={14} />
		</button>
		<button
			class="rounded p-1.5 hover:bg-accent"
			onclick={handleDuplicate}
			title="Duplicate"
		>
			<Copy size={14} />
		</button>
		<button
			class="rounded p-1.5 hover:bg-accent text-destructive"
			onclick={handleDelete}
			title="Delete"
		>
			<Trash2 size={14} />
		</button>
	</div>
</NodeToolbar>
