/**
 * Canvas performance configuration.
 * These values should be applied as props to <SvelteFlow>:
 * - onlyRenderVisibleElements: true (for large workflows 50+ nodes)
 * - nodesDraggable: true (default)
 * - elementsSelectable: true (default)
 */
export const CANVAS_PERFORMANCE_CONFIG = {
	onlyRenderVisibleElements: true,
	nodeExtent: [
		[-Infinity, -Infinity],
		[Infinity, Infinity]
	] as [[number, number], [number, number]]
} as const;
