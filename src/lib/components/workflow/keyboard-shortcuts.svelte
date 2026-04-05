<script lang="ts">
	import { getContext } from 'svelte';
	import { useSvelteFlow, type Node, type Edge } from '@xyflow/svelte';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import {
		collectSelectionForClipboard,
		serializeClipboard,
		parseClipboard,
		remapForPaste
	} from '$lib/utils/workflow-clipboard';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');
	const { fitView } = useSvelteFlow();

	// Helper to safely cast store nodes/edges for clipboard operations
	function getNodes(): Node[] {
		return store.nodes as Node[];
	}
	function getEdges(): Edge[] {
		return store.edges as Edge[];
	}

	function isEditableTarget(event: KeyboardEvent): boolean {
		const target = event.target as HTMLElement;
		if (!target) return false;
		const tag = target.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
		if (target.isContentEditable) return true;
		return false;
	}

	async function handleCopy() {
		const payload = collectSelectionForClipboard(getNodes(), getEdges());
		if (payload.nodes.length === 0) return;
		const text = serializeClipboard(payload);
		await navigator.clipboard.writeText(text);
	}

	async function handlePaste() {
		try {
			const text = await navigator.clipboard.readText();
			const payload = parseClipboard(text);
			if (!payload) return;
			const { nodes: newNodes, edges: newEdges } = remapForPaste(payload);

			// Deselect existing, add pasted nodes and edges
			store.pushHistory();
			store.nodes = [
				...store.nodes.map((n) => ({ ...n, selected: false })),
				...newNodes
			] as typeof store.nodes;
			store.edges = [
				...store.edges.map((e) => ({ ...e, selected: false })),
				...newEdges
			] as typeof store.edges;
		} catch {
			// Clipboard read may fail due to permissions
		}
	}

	async function handleCut() {
		await handleCopy();
		const selectedIds = new Set(
			store.nodes.filter((n) => n.selected).map((n) => n.id)
		);
		if (selectedIds.size === 0) return;
		store.pushHistory();
		store.edges = store.edges.filter(
			(e) => !selectedIds.has(e.source) && !selectedIds.has(e.target)
		);
		store.nodes = store.nodes.filter((n) => !selectedIds.has(n.id));
	}

	function handleSelectAll() {
		store.nodes = store.nodes.map((n) => ({ ...n, selected: true }));
	}

	function onKeyDown(event: KeyboardEvent) {
		if (isEditableTarget(event)) return;

		const mod = event.metaKey || event.ctrlKey;

		if (mod && event.key === 'c') {
			event.preventDefault();
			handleCopy();
			return;
		}

		if (mod && event.key === 'v') {
			event.preventDefault();
			handlePaste();
			return;
		}

		if (mod && event.key === 'x') {
			event.preventDefault();
			handleCut();
			return;
		}

		if (mod && event.key === 'a') {
			event.preventDefault();
			handleSelectAll();
			return;
		}

		if (mod && event.key === 'z') {
			event.preventDefault();
			if (event.shiftKey) {
				store.redo();
			} else {
				store.undo();
			}
			return;
		}

		if (mod && event.key === 'y') {
			event.preventDefault();
			store.redo();
			return;
		}

		if (mod && event.key === '/') {
			event.preventDefault();
			// Fit to selection if nodes are selected, otherwise fit all
			const selectedNodes = store.nodes.filter((n) => n.selected);
			if (selectedNodes.length > 0) {
				fitView({
					nodes: selectedNodes,
					padding: 0.5,
					maxZoom: 1.5,
					duration: 300
				});
			} else {
				// Fit all with a reasonable minimum zoom
				fitView({ padding: 0.3, maxZoom: 1, minZoom: 0.4, duration: 300 });
			}
			return;
		}

		// "0" key (no modifier) = zoom to fit all at comfortable level
		if (event.key === '0' && mod) {
			event.preventDefault();
			fitView({ padding: 0.3, maxZoom: 1, minZoom: 0.4, duration: 300 });
			return;
		}

		// "1" key = zoom to 100%
		if (event.key === '1' && !mod) {
			// Only if not typing in an input
			return;
		}

		// Cmd/Ctrl+K = Open command palette
		if (mod && event.key === 'k') {
			event.preventDefault();
			window.dispatchEvent(new CustomEvent('workflow:command-palette'));
			return;
		}

		if (event.key === 'Escape') {
			store.selectedNodeId = null;
			store.selectedEdgeId = null;
		}
	}
</script>

<svelte:window onkeydown={onKeyDown} />
