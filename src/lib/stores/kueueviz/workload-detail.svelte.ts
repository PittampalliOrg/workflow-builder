import type {
	WorkloadDetailSnapshot,
	WorkloadEventSnapshot,
} from '$lib/server/kueueviz';
import { createKueueVizStream, type KueueVizStream } from './shared.svelte';

export function createWorkloadDetailStream(
	namespace: string,
	name: string,
): KueueVizStream<WorkloadDetailSnapshot | null> {
	return createKueueVizStream<WorkloadDetailSnapshot | null>({
		// `[...endpoint]/+server.ts` translates `workload/<ns>/<name>` into
		// the typed endpoint key + path-parameter shape; this is just the
		// public URL convention.
		endpoint: `workload/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
		initial: null,
		parse: (raw) => (raw && typeof raw === 'object' ? (raw as WorkloadDetailSnapshot) : null),
	});
}

export function createWorkloadEventsStream(
	namespace: string,
	name: string,
): KueueVizStream<WorkloadEventSnapshot[]> {
	return createKueueVizStream<WorkloadEventSnapshot[]>({
		endpoint: `workload/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/events`,
		initial: [],
		parse: (raw) => (Array.isArray(raw) ? (raw as WorkloadEventSnapshot[]) : []),
	});
}
