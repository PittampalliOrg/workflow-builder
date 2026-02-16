export type LayoutNode = { id: string; kind: string };

export type LayoutEdge = {
	source: string;
	target: string;
	sourceHandle?: string | null;
};

export function layoutDagPositions(input: {
	nodes: LayoutNode[];
	edges: LayoutEdge[];
	startId: string;
}): Record<string, { x: number; y: number }> {
	const { nodes, edges, startId } = input;
	const ids = new Set(nodes.map((n) => n.id));

	const outgoing = new Map<string, string[]>();
	const incomingCount = new Map<string, number>();

	for (const id of ids) {
		outgoing.set(id, []);
		incomingCount.set(id, 0);
	}

	for (const e of edges) {
		if (!ids.has(e.source) || !ids.has(e.target)) continue;
		outgoing.get(e.source)?.push(e.target);
		incomingCount.set(e.target, (incomingCount.get(e.target) || 0) + 1);
	}

	// Kahn topo order (stable by id).
	const queue = Array.from(ids)
		.filter((id) => (incomingCount.get(id) || 0) === 0)
		.sort((a, b) => a.localeCompare(b));

	const topo: string[] = [];
	while (queue.length > 0) {
		const id = queue.shift()!;
		topo.push(id);
		const neighbors = outgoing.get(id) || [];
		for (const n of neighbors) {
			const next = (incomingCount.get(n) || 0) - 1;
			incomingCount.set(n, next);
			if (next === 0) {
				queue.push(n);
				queue.sort((a, b) => a.localeCompare(b));
			}
		}
	}

	// Longest-path depth from start (DAG expected).
	const depth = new Map<string, number>();
	for (const id of topo) {
		if (id === startId) {
			depth.set(id, 0);
			continue;
		}
		const preds: string[] = [];
		for (const e of edges) {
			if (e.target === id && ids.has(e.source)) preds.push(e.source);
		}
		const best = preds.reduce((acc, p) => {
			const d = depth.get(p);
			return d === undefined ? acc : Math.max(acc, d + 1);
		}, 0);
		depth.set(id, best);
	}

	const byDepth = new Map<number, string[]>();
	for (const n of nodes) {
		const d = depth.get(n.id) ?? 0;
		const list = byDepth.get(d) || [];
		list.push(n.id);
		byDepth.set(d, list);
	}

	for (const [d, list] of byDepth) {
		list.sort((a, b) => a.localeCompare(b));
		byDepth.set(d, list);
	}

	const positions: Record<string, { x: number; y: number }> = {};
	const X_STEP = 320;
	const Y_STEP = 220;

	for (const [d, list] of Array.from(byDepth.entries()).sort(
		(a, b) => a[0] - b[0],
	)) {
		for (let i = 0; i < list.length; i += 1) {
			const id = list[i]!;
			positions[id] = { x: d * X_STEP, y: i * Y_STEP };
		}
	}

	// Ensure start is visible-ish.
	if (positions[startId] == null) {
		positions[startId] = { x: 0, y: 0 };
	}

	return positions;
}
