<script lang="ts">
	import { getContext } from 'svelte';
	import { NodeToolbar, Position } from '@xyflow/svelte';
	import { Settings, Copy, Trash2, GitFork } from '@lucide/svelte';
	import { createWorkflowStore } from '$lib/stores/workflow.svelte';

	interface Props {
		nodeId: string;
		position?: Position;
	}

	let { nodeId, position = Position.Top }: Props = $props();

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');
	// Offer "Fork from here" whenever a run is overlaid + this is a real node; the
	// canvas handler enforces the run-must-be-terminal gate (and toasts otherwise).
	const canFork = $derived(
		!!store.selectedExecutionId && nodeId !== '__start__' && nodeId !== '__end__'
	);

	function handleConfigure() {
		store.selectedNodeId = nodeId;
	}

	function handleDuplicate() {
		store.duplicateNode(nodeId);
	}

	function handleDelete() {
		store.removeNode(nodeId);
	}

	function handleFork() {
		window.dispatchEvent(new CustomEvent('workflow:fork-from-node', { detail: { nodeId } }));
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
		{#if canFork}
			<button
				class="rounded p-1.5 text-primary hover:bg-primary/10"
				onclick={handleFork}
				title="Fork the selected run from this node"
			>
				<GitFork size={14} />
			</button>
		{/if}
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
