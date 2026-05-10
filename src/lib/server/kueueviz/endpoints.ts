/**
 * Allowlist of upstream KueueViz endpoints exposed via the BFF.
 *
 * Anything not declared here is rejected by the SSE dispatcher with 404.
 * Keep parameter shapes typed so the dispatcher fails fast on bad input.
 *
 * Upstream paths (from cmd/kueueviz/backend/handlers/handlers.go):
 *   /ws/cluster-queues
 *   /ws/workloads?namespace=<optional>
 *   /ws/resource-flavors
 *   /ws/local-queues
 *   /ws/cohorts
 *   /ws/cluster-queue/:cluster_queue_name
 *   /ws/local-queue/:namespace/:queue_name
 *   /ws/local-queue/:namespace/:queue_name/workloads
 *   /ws/workload/:namespace/:workload_name
 *   /ws/workload/:namespace/:workload_name/events
 *   /ws/cohort/:cohort_name
 *   /ws/resource-flavor/:flavor_name
 *   /ws/namespaces
 *   /ws/workloads/dashboard?namespace=<optional>
 *
 * v1 only registers the four most useful ones — overview + workloads list
 * fits the v1 page surface, plus ResourceFlavors for the strip view.
 */

export type EndpointKey =
	| 'cluster-queues'
	| 'workloads'
	| 'workload'
	| 'workload-events'
	| 'resource-flavors'
	| 'local-queues'
	| 'cohorts';

export type EndpointDescriptor = {
	key: EndpointKey;
	/**
	 * Upstream path template. `{name}` placeholders are replaced with
	 * matching `pathParams` values when the BFF dials upstream.
	 */
	path: string;
	/**
	 * Positional path parameters (in order, all required when present).
	 * `cluster-queues` has none; `workload` has `[namespace, name]`.
	 */
	pathParams: ReadonlyArray<string>;
	/** Optional query params to forward (currently just `namespace`). */
	query: ReadonlyArray<'namespace'>;
};

export const ENDPOINTS: Record<EndpointKey, EndpointDescriptor> = {
	'cluster-queues': {
		key: 'cluster-queues',
		path: '/ws/cluster-queues',
		pathParams: [],
		query: [],
	},
	workloads: {
		key: 'workloads',
		path: '/ws/workloads',
		pathParams: [],
		query: ['namespace'],
	},
	workload: {
		key: 'workload',
		path: '/ws/workload/{namespace}/{name}',
		pathParams: ['namespace', 'name'],
		query: [],
	},
	'workload-events': {
		key: 'workload-events',
		path: '/ws/workload/{namespace}/{name}/events',
		pathParams: ['namespace', 'name'],
		query: [],
	},
	'resource-flavors': {
		key: 'resource-flavors',
		path: '/ws/resource-flavors',
		pathParams: [],
		query: [],
	},
	'local-queues': {
		key: 'local-queues',
		path: '/ws/local-queues',
		pathParams: [],
		query: [],
	},
	cohorts: {
		key: 'cohorts',
		path: '/ws/cohorts',
		pathParams: [],
		query: [],
	},
};

/** Substitute `{name}` placeholders in a path template using `params`. */
export function resolveUpstreamPath(
	endpoint: EndpointKey,
	params: Record<string, string>,
): string {
	const desc = ENDPOINTS[endpoint];
	let out = desc.path;
	for (const key of desc.pathParams) {
		const v = params[key];
		if (!v) {
			throw new Error(`missing required path parameter "${key}" for ${endpoint}`);
		}
		out = out.replace(`{${key}}`, encodeURIComponent(v));
	}
	return out;
}

export function isEndpointKey(value: string): value is EndpointKey {
	return value in ENDPOINTS;
}

/**
 * Build the cache key for the singleton pool. Same (path, sorted-params)
 * always maps to the same upstream stream, so two browsers viewing the
 * same workloads-by-namespace filter share one upstream WS.
 */
export function poolCacheKey(
	endpoint: EndpointKey,
	params: Record<string, string>,
): string {
	const desc = ENDPOINTS[endpoint];
	const allowedKeys = new Set<string>([...desc.pathParams, ...desc.query]);
	const entries = Object.entries(params)
		.filter(
			([k, v]) =>
				allowedKeys.has(k) && typeof v === 'string' && v.length > 0,
		)
		.sort(([a], [b]) => a.localeCompare(b));
	if (entries.length === 0) return endpoint;
	const qs = entries.map(([k, v]) => `${k}=${v}`).join('&');
	return `${endpoint}?${qs}`;
}
