import type { ClusterQueueSnapshot } from '$lib/server/kueueviz';
import { createKueueVizStream, type KueueVizStream } from './shared.svelte';

export function createClusterQueueStream(): KueueVizStream<ClusterQueueSnapshot[]> {
	return createKueueVizStream<ClusterQueueSnapshot[]>({
		endpoint: 'cluster-queues',
		initial: [],
		parse: (raw) => (Array.isArray(raw) ? (raw as ClusterQueueSnapshot[]) : []),
	});
}
