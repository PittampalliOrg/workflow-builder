<script lang="ts">
	import { getContext } from 'svelte';
	import { Trash2, Copy, Unplug, Settings } from 'lucide-svelte';
	import { Button } from '$lib/components/ui/button';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');

	interface Props {
		x: number;
		y: number;
		nodeId: string | null;
		onClose: () => void;
	}

	let { x, y, nodeId, onClose }: Props = $props();

	function deleteNode() {
		if (nodeId) store.removeNode(nodeId);
		onClose();
	}

	function duplicateNode() {
		if (!nodeId) return;
		const node = store.nodes.find((n) => n.id === nodeId);
		if (!node) return;
		store.addNode(
			node.type as any,
			{ x: node.position.x + 50, y: node.position.y + 50 },
			(node.data as { label?: string }).label
		);
		onClose();
	}

	function disconnectNode() {
		if (!nodeId) return;
		store.pushHistory();
		store.edges = store.edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
		store.isDirty = true;
		onClose();
	}

	function configureNode() {
		if (nodeId) {
			store.selectedNodeId = nodeId;
		}
		onClose();
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-50" onclick={onClose} oncontextmenu={(e) => { e.preventDefault(); onClose(); }}>
	<div
		class="absolute z-50 min-w-[160px] rounded-md border border-border bg-popover p-1 shadow-md"
		style="left: {x}px; top: {y}px;"
	>
		<Button
			variant="ghost"
			size="sm"
			onclick={configureNode}
			class="flex w-full items-center justify-start gap-2 rounded-sm px-2 py-1.5 text-popover-foreground"
		>
			<Settings size={14} />
			Configure
		</Button>
		<Button
			variant="ghost"
			size="sm"
			onclick={duplicateNode}
			class="flex w-full items-center justify-start gap-2 rounded-sm px-2 py-1.5 text-popover-foreground"
		>
			<Copy size={14} />
			Duplicate
		</Button>
		<Button
			variant="ghost"
			size="sm"
			onclick={disconnectNode}
			class="flex w-full items-center justify-start gap-2 rounded-sm px-2 py-1.5 text-popover-foreground"
		>
			<Unplug size={14} />
			Disconnect
		</Button>
		<div class="my-1 h-px bg-border"></div>
		<Button
			variant="ghost"
			size="sm"
			onclick={deleteNode}
			class="flex w-full items-center justify-start gap-2 rounded-sm px-2 py-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
		>
			<Trash2 size={14} />
			Delete
		</Button>
	</div>
</div>
