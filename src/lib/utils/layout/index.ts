export { layoutWorkflowNodes, type DagreLayoutOptions } from './dagre-layout';
export { layoutElkWorkflowNodes, type ElkLayoutOptions } from './elk-layout';

export type LayoutAlgorithm = 'elk' | 'dagre';

export const LAYOUT_ALGORITHMS: { id: LayoutAlgorithm; label: string; description: string }[] = [
	{ id: 'elk', label: 'ELK', description: 'Best for branching workflows — orthogonal edges, crossing minimization' },
	{ id: 'dagre', label: 'Dagre', description: 'Fast, lightweight layout for simple linear workflows' }
];
