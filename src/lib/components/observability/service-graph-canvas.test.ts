import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const canvasSource = readFileSync(new URL('./service-graph-canvas.svelte', import.meta.url), 'utf8');
const fitSource = readFileSync(new URL('./service-graph-fit-view.svelte', import.meta.url), 'utf8');

describe('service graph viewport fitting', () => {
	it('fits after async layout instead of using the empty initial SvelteFlow fit', () => {
		expect(canvasSource).toContain('<ServiceGraphFitView {fitKey} />');
		expect(canvasSource).not.toContain('\n\t\tfitView\n');
		expect(fitSource).toContain('useNodesInitialized');
		expect(fitSource).toContain('nodesInitialized.current');
		expect(fitSource).toContain('key === lastFitKey');
		expect(fitSource).toContain('minZoom: 0.35');
	});
});
