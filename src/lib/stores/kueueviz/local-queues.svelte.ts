import type { LocalQueueSnapshot } from '$lib/server/kueueviz';
import { createKueueVizStream, type KueueVizStream } from './shared.svelte';

export function createLocalQueueStream(): KueueVizStream<LocalQueueSnapshot[]> {
	return createKueueVizStream<LocalQueueSnapshot[]>({
		endpoint: 'local-queues',
		initial: [],
		parse: (raw) => (Array.isArray(raw) ? (raw as LocalQueueSnapshot[]) : []),
	});
}
