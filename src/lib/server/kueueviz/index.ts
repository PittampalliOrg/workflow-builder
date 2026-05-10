/**
 * Public surface for the BFF KueueViz integration.
 *
 * Routes import from here, not from the underlying modules, so the
 * implementation can change without touching every call site.
 */

export { kueuevizPool } from './pool';
export type { Subscriber } from './pool';
export { ENDPOINTS, isEndpointKey, type EndpointKey } from './endpoints';
export { fetchKueueVizYaml } from './rest';
export type {
	ClusterQueueSnapshot,
	CohortSnapshot,
	FlavorUsageLite,
	LocalQueueSnapshot,
	ResourceFlavorSnapshot,
	ResourceQuantityLite,
	StatusEvent,
	StreamStatus,
	WorkloadAdmission,
	WorkloadAdmissionAssignment,
	WorkloadConditionLite,
	WorkloadDetailSnapshot,
	WorkloadEventSnapshot,
	WorkloadPodSetSummary,
	WorkloadSnapshot,
	WorkloadStatus,
} from './types';
