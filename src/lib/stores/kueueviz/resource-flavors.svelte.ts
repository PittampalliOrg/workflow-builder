import type { ResourceFlavorSnapshot } from '$lib/server/kueueviz';
import { createKueueVizStream, type KueueVizStream } from './shared.svelte';

export function createResourceFlavorStream(): KueueVizStream<ResourceFlavorSnapshot[]> {
	return createKueueVizStream<ResourceFlavorSnapshot[]>({
		endpoint: 'resource-flavors',
		initial: [],
		parse: (raw) => (Array.isArray(raw) ? (raw as ResourceFlavorSnapshot[]) : []),
	});
}
