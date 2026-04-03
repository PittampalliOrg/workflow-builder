import type { Node, Edge } from '@xyflow/svelte';

export const CLIPBOARD_FORMAT = 'workflow-builder/clipboard';
const CLIPBOARD_VERSION = 1;

interface ClipboardPayload {
	format: string;
	version: number;
	nodes: Node[];
	edges: Edge[];
}

export function collectSelectionForClipboard(
	nodes: Node[],
	edges: Edge[]
): { nodes: Node[]; edges: Edge[] } {
	const selectedNodes = nodes.filter((n) => n.selected && n.type !== 'start');
	const selectedIds = new Set(selectedNodes.map((n) => n.id));

	// Normalize positions relative to selection center
	if (selectedNodes.length === 0) return { nodes: [], edges: [] };

	const centerX =
		selectedNodes.reduce((sum, n) => sum + n.position.x, 0) / selectedNodes.length;
	const centerY =
		selectedNodes.reduce((sum, n) => sum + n.position.y, 0) / selectedNodes.length;

	const normalizedNodes = selectedNodes.map((n) => ({
		...n,
		position: {
			x: n.position.x - centerX,
			y: n.position.y - centerY
		}
	}));

	const selectedEdges = edges.filter(
		(e) => selectedIds.has(e.source) && selectedIds.has(e.target)
	);

	return { nodes: normalizedNodes, edges: selectedEdges };
}

export function serializeClipboard(payload: { nodes: Node[]; edges: Edge[] }): string {
	return JSON.stringify({
		format: CLIPBOARD_FORMAT,
		version: CLIPBOARD_VERSION,
		...payload
	});
}

export function parseClipboard(text: string): ClipboardPayload | null {
	try {
		const parsed = JSON.parse(text);
		if (parsed?.format !== CLIPBOARD_FORMAT) return null;
		if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
		return parsed as ClipboardPayload;
	} catch {
		return null;
	}
}

export function remapForPaste(
	payload: { nodes: Node[]; edges: Edge[] },
	offset = { x: 50, y: 50 }
): { nodes: Node[]; edges: Edge[] } {
	const idMap = new Map<string, string>();

	const nodes = payload.nodes.map((n) => {
		const newId = crypto.randomUUID();
		idMap.set(n.id, newId);
		return {
			...n,
			id: newId,
			position: {
				x: n.position.x + offset.x,
				y: n.position.y + offset.y
			},
			selected: true
		};
	});

	const edges: Edge[] = [];
	for (const e of payload.edges) {
		const newSource = idMap.get(e.source);
		const newTarget = idMap.get(e.target);
		if (!newSource || !newTarget) continue;
		edges.push({
			...e,
			id: `${newSource}-${newTarget}`,
			source: newSource,
			target: newTarget,
			selected: true
		});
	}

	return { nodes, edges };
}
