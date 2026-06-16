import type { Edge, Node } from '@xyflow/svelte';
import { layoutWorkflowNodes, type DagreLayoutOptions } from './dagre-layout';
import { layoutElkWorkflowNodes, type ElkLayoutOptions } from './elk-layout';

export { layoutWorkflowNodes, type DagreLayoutOptions } from './dagre-layout';
export { layoutElkWorkflowNodes, type ElkLayoutOptions } from './elk-layout';

export type LayoutAlgorithm = 'elk' | 'dagre';
export type LayoutPreset = 'flow' | 'compact' | 'branching' | 'review';
export type LayoutDirection = 'TB' | 'LR';
export type LayoutFitMode = 'smart' | 'all' | 'preserve';

export interface WorkflowLayoutConfig {
	preset: LayoutPreset;
	algorithm: LayoutAlgorithm;
	direction: LayoutDirection;
	nodeSpacing: number;
	layerSpacing: number;
	fitMode: LayoutFitMode;
}

export interface WorkflowGraphShape {
	componentCount: number;
	branchingNodeCount: number;
	reconvergingNodeCount: number;
	chainLike: boolean;
}

export interface WorkflowNodeBounds {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
	width: number;
	height: number;
	centerX: number;
	centerY: number;
}

export const LAYOUT_PRESETS: Array<{
	id: LayoutPreset;
	label: string;
	description: string;
	config: WorkflowLayoutConfig;
}> = [
	{
		id: 'flow',
		label: 'Flow',
		description: 'Balanced default for most workflows.',
		config: {
			preset: 'flow',
			algorithm: 'elk',
			direction: 'TB',
			nodeSpacing: 48,
			layerSpacing: 96,
			fitMode: 'smart'
		}
	},
	{
		id: 'compact',
		label: 'Compact',
		description: 'Dense layout for shorter linear workflows.',
		config: {
			preset: 'compact',
			algorithm: 'dagre',
			direction: 'TB',
			nodeSpacing: 28,
			layerSpacing: 72,
			fitMode: 'smart'
		}
	},
	{
		id: 'branching',
		label: 'Branching',
		description: 'More separation for fan-out and fan-in flows.',
		config: {
			preset: 'branching',
			algorithm: 'elk',
			direction: 'TB',
			nodeSpacing: 72,
			layerSpacing: 128,
			fitMode: 'smart'
		}
	},
	{
		id: 'review',
		label: 'Review',
		description: 'Roomier layout for demos and walkthroughs.',
		config: {
			preset: 'review',
			algorithm: 'elk',
			direction: 'TB',
			nodeSpacing: 88,
			layerSpacing: 148,
			fitMode: 'all'
		}
	}
];

export const DEFAULT_LAYOUT_CONFIG: WorkflowLayoutConfig = {
	...LAYOUT_PRESETS[0].config
};

export function getWorkflowNodeBounds(nodes: Node[]): WorkflowNodeBounds | null {
	if (nodes.length === 0) return null;

	const extents = nodes.map((node) => {
		const width = node.measured?.width ?? node.width ?? 148;
		const height = node.measured?.height ?? node.height ?? 148;
		return {
			minX: node.position.x,
			maxX: node.position.x + width,
			minY: node.position.y,
			maxY: node.position.y + height
		};
	});

	const minX = Math.min(...extents.map((extent) => extent.minX));
	const maxX = Math.max(...extents.map((extent) => extent.maxX));
	const minY = Math.min(...extents.map((extent) => extent.minY));
	const maxY = Math.max(...extents.map((extent) => extent.maxY));
	const width = Math.max(maxX - minX, 1);
	const height = Math.max(maxY - minY, 1);

	return {
		minX,
		maxX,
		minY,
		maxY,
		width,
		height,
		centerX: minX + width / 2,
		centerY: minY + height / 2
	};
}

export function createLayoutConfig(
	next: Partial<WorkflowLayoutConfig> = {},
	base: WorkflowLayoutConfig = DEFAULT_LAYOUT_CONFIG
): WorkflowLayoutConfig {
	const presetConfig =
		LAYOUT_PRESETS.find((preset) => preset.id === next.preset)?.config ??
		LAYOUT_PRESETS.find((preset) => preset.id === base.preset)?.config ??
		DEFAULT_LAYOUT_CONFIG;

	return {
		...presetConfig,
		...base,
		...next
	};
}

export function analyzeWorkflowShape(nodes: Node[], edges: Edge[]): WorkflowGraphShape {
	if (nodes.length === 0) {
		return {
			componentCount: 0,
			branchingNodeCount: 0,
			reconvergingNodeCount: 0,
			chainLike: false
		};
	}

	const nodeIds = new Set(nodes.map((node) => node.id));
	const inDegree = new Map<string, number>();
	const outDegree = new Map<string, number>();
	const adjacency = new Map<string, string[]>();

	for (const node of nodes) {
		inDegree.set(node.id, 0);
		outDegree.set(node.id, 0);
		adjacency.set(node.id, []);
	}

	for (const edge of edges) {
		if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target) {
			continue;
		}

		outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
		inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
		adjacency.get(edge.source)?.push(edge.target);
		adjacency.get(edge.target)?.push(edge.source);
	}

	let componentCount = 0;
	const visited = new Set<string>();
	for (const node of nodes) {
		if (visited.has(node.id)) continue;
		componentCount += 1;
		const queue = [node.id];
		visited.add(node.id);
		while (queue.length > 0) {
			const current = queue.shift();
			if (!current) continue;
			for (const neighbor of adjacency.get(current) ?? []) {
				if (visited.has(neighbor)) continue;
				visited.add(neighbor);
				queue.push(neighbor);
			}
		}
	}

	const branchingNodeCount = nodes.filter((node) => (outDegree.get(node.id) ?? 0) > 1).length;
	const reconvergingNodeCount = nodes.filter((node) => (inDegree.get(node.id) ?? 0) > 1).length;
	const chainLike =
		componentCount === 1 &&
		nodes.every((node) => (inDegree.get(node.id) ?? 0) <= 1 && (outDegree.get(node.id) ?? 0) <= 1);

	return {
		componentCount,
		branchingNodeCount,
		reconvergingNodeCount,
		chainLike
	};
}

export function suggestLayoutConfig(
	nodes: Node[],
	edges: Edge[],
	base: WorkflowLayoutConfig = DEFAULT_LAYOUT_CONFIG
): WorkflowLayoutConfig {
	const shape = analyzeWorkflowShape(nodes, edges);

	if (shape.componentCount > 1) {
		return createLayoutConfig({ preset: 'review' }, base);
	}

	if (shape.branchingNodeCount > 0 || shape.reconvergingNodeCount > 0) {
		return createLayoutConfig({ preset: 'branching' }, base);
	}

	if (shape.chainLike && nodes.length <= 8) {
		return createLayoutConfig({ preset: 'compact' }, base);
	}

	return createLayoutConfig({ preset: 'flow' }, base);
}

export async function layoutWorkflowGraph(
	nodes: Node[],
	edges: Edge[],
	config: WorkflowLayoutConfig
): Promise<Node[]> {
	const resolvedConfig = createLayoutConfig(config);

	if (resolvedConfig.algorithm === 'elk') {
		const elkOptions: ElkLayoutOptions = {
			direction: resolvedConfig.direction,
			nodeSep: resolvedConfig.nodeSpacing,
			rankSep: resolvedConfig.layerSpacing
		};
		return layoutElkWorkflowNodes(nodes, edges, elkOptions);
	}

	const dagreOptions: DagreLayoutOptions = {
		direction: resolvedConfig.direction,
		nodeSep: resolvedConfig.nodeSpacing,
		rankSep: resolvedConfig.layerSpacing,
		rowGap: resolvedConfig.layerSpacing,
		columnGap: resolvedConfig.nodeSpacing,
		strategy: resolvedConfig.preset === 'compact' ? 'compact' : 'dagre'
	};
	return layoutWorkflowNodes(nodes, edges, dagreOptions);
}

export function shouldAutoLayoutGraph(nodes: Node[], edges: Edge[]): boolean {
	if (nodes.length < 2) return false;

	const positions = nodes.map((node) => node.position);
	const uniquePositions = new Set(positions.map((position) => `${position.x}:${position.y}`));
	if (uniquePositions.size <= Math.max(2, Math.floor(nodes.length / 4))) {
		return true;
	}

	// Spec-derived graphs arrive as a single vertical column — every node shares
	// one x (the spec→graph adapter's X_CENTER) with evenly stacked y. That is
	// never a real layout: fan-out / fan-in siblings overlap and the column
	// ignores the chosen direction. Treat a uniform-x stack as needs-layout so
	// loading (or rebuilding) a workflow auto-arranges instead of showing a raw
	// column. (A genuinely laid-out pure chain re-layouts to an equivalent
	// result, so this is safe.)
	const uniqueX = new Set(positions.map((position) => position.x));
	if (uniqueX.size === 1) return true;

	const nodeIds = new Set(nodes.map((node) => node.id));
	const connectedEdgeCount = edges.filter(
		(edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.source !== edge.target
	).length;

	return connectedEdgeCount > 0 && positions.every((position) => position.x === 0 && position.y === 0);
}
