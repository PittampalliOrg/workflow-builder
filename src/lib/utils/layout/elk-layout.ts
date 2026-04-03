import ELK, { type ElkNode, type ElkExtendedEdge } from 'elkjs/lib/elk.bundled.js';
import type { Node, Edge } from '@xyflow/svelte';

export type ElkLayoutOptions = {
	direction?: 'LR' | 'TB';
	nodeWidth?: number;
	nodeHeight?: number;
	nodeSep?: number;
	rankSep?: number;
};

type NodeWithMeasurements = Node & {
	width?: number;
	height?: number;
	measured?: { width?: number; height?: number };
};

const elk = new ELK();

function getNodeSize(
	node: Node,
	options: ElkLayoutOptions
): { width: number; height: number } {
	const n = node as NodeWithMeasurements;
	return {
		width: n.measured?.width ?? n.width ?? options.nodeWidth ?? 148,
		height: n.measured?.height ?? n.height ?? options.nodeHeight ?? 148
	};
}

export async function layoutElkWorkflowNodes(
	nodes: Node[],
	edges: Edge[],
	options: ElkLayoutOptions = {}
): Promise<Node[]> {
	if (nodes.length === 0) return nodes;

	const direction = options.direction === 'LR' ? 'RIGHT' : 'DOWN';
	const nodeSep = String(options.nodeSep ?? 80);
	const rankSep = String(options.rankSep ?? 100);

	const children: ElkNode[] = nodes.map((n) => {
		const { width, height } = getNodeSize(n, options);
		return {
			id: n.id,
			width,
			height,
			// Fixed port sides: target on top (NORTH), source on bottom (SOUTH) for TB
			// For LR: target on left (WEST), source on right (EAST)
			ports: [
				{
					id: `${n.id}__target`,
					properties: {
						'port.side': direction === 'DOWN' ? 'NORTH' : 'WEST'
					}
				},
				{
					id: `${n.id}__source`,
					properties: {
						'port.side': direction === 'DOWN' ? 'SOUTH' : 'EAST'
					}
				}
			]
		};
	});

	const nodeIds = new Set(nodes.map((n) => n.id));
	const elkEdges: ElkExtendedEdge[] = edges
		.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target) && e.source !== e.target)
		.map((e, i) => ({
			id: `e${i}`,
			sources: [`${e.source}__source`],
			targets: [`${e.target}__target`]
		}));

	const graph: ElkNode = {
		id: 'root',
		layoutOptions: {
			'elk.algorithm': 'layered',
			'elk.direction': direction,
			// Spacing
			'elk.layered.spacing.nodeNodeBetweenLayers': rankSep,
			'elk.spacing.nodeNode': nodeSep,
			// Orthogonal edge routing — clear right-angle edges for branches
			'elk.edgeRouting': 'ORTHOGONAL',
			// Crossing minimization — reduces visual clutter when branches reconverge
			'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
			// Node placement — minimizes edge length, keeps branches compact
			'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
			// Port constraints — respect handle positions (top=target, bottom=source)
			'elk.portConstraints': 'FIXED_SIDE',
			// Merge edges going to the same target for cleaner reconvergence
			'elk.layered.mergeEdges': 'true',
			// Margin
			'elk.padding': '[top=20,left=20,bottom=20,right=20]'
		},
		children,
		edges: elkEdges
	};

	try {
		const layout = await elk.layout(graph);

		const positions = new Map<string, { x: number; y: number }>();
		for (const child of layout.children ?? []) {
			positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
		}

		return nodes.map((node) => {
			const pos = positions.get(node.id);
			if (!pos) return node;
			return { ...node, position: pos };
		});
	} catch (err) {
		console.error('ELK layout failed:', err);
		return nodes;
	}
}
