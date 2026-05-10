import type { WorkloadSnapshot } from '$lib/server/kueueviz';
import { createKueueVizStream, type KueueVizStream } from './shared.svelte';

export function createWorkloadStream(params: {
	namespace?: string;
} = {}): KueueVizStream<WorkloadSnapshot[]> {
	const filter: Record<string, string> = {};
	if (params.namespace) filter.namespace = params.namespace;
	return createKueueVizStream<WorkloadSnapshot[]>({
		endpoint: 'workloads',
		params: filter,
		initial: [],
		parse: (raw) => (Array.isArray(raw) ? (raw as WorkloadSnapshot[]) : []),
	});
}
