/**
 * Map raw KueueViz upstream payloads → projected snapshots the UI
 * actually needs. ~10× shrink at medium-cluster scale.
 *
 * Defensive: upstream payloads carry full Kubernetes CRD shapes which
 * change across Kueue versions. We pull only the fields we know about
 * and never throw — a partial projection is better than dropping a
 * snapshot for the whole UI.
 */

import type {
	ClusterQueueSnapshot,
	CohortSnapshot,
	FlavorUsageLite,
	LocalQueueSnapshot,
	ResourceFlavorSnapshot,
	ResourceQuantityLite,
	WorkloadAdmission,
	WorkloadAdmissionAssignment,
	WorkloadConditionLite,
	WorkloadDetailSnapshot,
	WorkloadEventSnapshot,
	WorkloadPodSetSummary,
	WorkloadSnapshot,
	WorkloadStatus,
} from './types';

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Json)
		: null;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback: number | null = null): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '') {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return fallback;
}

/**
 * Kubernetes resource quantities arrive as either decimal strings ("100m",
 * "10Gi") or as raw numbers (Kueue's protobuf encoding emits ints for the
 * nominalQuota / total / borrowed fields). Always return a string so the
 * downstream quantity parser has one shape to deal with.
 */
function asQuantity(value: unknown, fallback = '0'): string {
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	if (typeof value === 'string' && value.length > 0) return value;
	return fallback;
}

const KNOWN_LABEL_KEYS = new Set([
	'app',
	'agent-app-id',
	'benchmark-run-id',
	'benchmark-instance-id',
	'kueue.x-k8s.io/queue-name',
	'kueue.x-k8s.io/priority-class',
	'workflow-builder.cnoe.io/environment-key',
	'workflow-builder.cnoe.io/session-id',
]);

function projectLabels(value: unknown): Record<string, string> {
	const obj = asObject(value);
	if (!obj) return {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (KNOWN_LABEL_KEYS.has(k) && typeof v === 'string') {
			out[k] = v;
		}
	}
	return out;
}

function projectConditions(value: unknown): WorkloadConditionLite[] {
	const out: WorkloadConditionLite[] = [];
	for (const entry of asArray(value)) {
		const obj = asObject(entry);
		if (!obj) continue;
		const type = asString(obj.type);
		const status = asString(obj.status);
		if (!type || !status) continue;
		const condition: WorkloadConditionLite = { type, status };
		const reason = asString(obj.reason);
		if (reason) condition.reason = reason;
		const message = asString(obj.message);
		if (message) condition.message = message;
		const lastTransitionTime = asString(obj.lastTransitionTime);
		if (lastTransitionTime) condition.lastTransitionTime = lastTransitionTime;
		out.push(condition);
	}
	return out;
}

/**
 * Status computation mirrors cmd/kueueviz/backend/handlers/workloads.go's
 * `computeStatus` — keep the priority order in sync if upstream changes.
 */
function computeWorkloadStatus(
	conditions: WorkloadConditionLite[],
	hasAdmission: boolean,
): WorkloadStatus {
	const cond = (type: string) =>
		conditions.find((c) => c.type === type && c.status === 'True');

	if (cond('Finished')) return 'finished';
	if (cond('Failed')) return 'failed';
	if (cond('Evicted')) return 'evicted';
	if (cond('Admitted')) return 'admitted';
	if (cond('QuotaReserved')) return 'reserving';
	if (hasAdmission) return 'admitted';
	return 'pending';
}

export function projectWorkload(raw: unknown): WorkloadSnapshot | null {
	const obj = asObject(raw);
	if (!obj) return null;
	const metadata = asObject(obj.metadata);
	const spec = asObject(obj.spec);
	const status = asObject(obj.status);
	if (!metadata) return null;

	const podSetsRaw = asArray(spec?.podSets);
	let totalPods = 0;
	for (const ps of podSetsRaw) {
		totalPods += asNumber(asObject(ps)?.count, 0) ?? 0;
	}

	const conditions = projectConditions(status?.conditions);
	const admission = asObject(status?.admission);
	const hasAdmission = admission !== null && Object.keys(admission).length > 0;

	const computed = computeWorkloadStatus(conditions, hasAdmission);
	const active =
		computed === 'admitted' || computed === 'reserving' || computed === 'pending';

	const clusterQueueName =
		asString(admission?.clusterQueue, '') || null;

	// Cross-feature join keys (`agent-app-id`, `benchmark-run-id`,
	// `benchmark-instance-id`) live on the **pod template**, not the
	// Workload's own metadata. Kueue's `kueue.x-k8s.io/job-uid` is the only
	// useful label propagated up. Merge pod-set template labels — pod-set
	// labels take priority since that's where our join keys actually sit.
	const podTemplateLabels: Record<string, string> = {};
	for (const ps of podSetsRaw) {
		const psObj = asObject(ps);
		const tmplLabels = asObject(asObject(asObject(psObj?.template)?.metadata)?.labels);
		if (!tmplLabels) continue;
		for (const [k, v] of Object.entries(tmplLabels)) {
			if (typeof v === 'string') podTemplateLabels[k] = v;
		}
	}
	const filteredPodLabels = projectLabels(podTemplateLabels);
	const filteredMetaLabels = projectLabels(metadata.labels);
	const labels = { ...filteredMetaLabels, ...filteredPodLabels };

	return {
		uid: asString(metadata.uid),
		name: asString(metadata.name),
		namespace: asString(metadata.namespace),
		queueName: asString(spec?.queueName),
		clusterQueueName,
		priority: asNumber(spec?.priority),
		priorityClassName: asString(spec?.priorityClassName) || null,
		creationTimestamp: asString(metadata.creationTimestamp),
		status: computed,
		active,
		conditions,
		podSetCount: podSetsRaw.length,
		totalPods,
		labels,
	};
}

export function projectWorkloadList(raw: unknown): WorkloadSnapshot[] {
	// Upstream wraps as `{ workloads: { items: [...] } }` for /ws/workloads.
	const root = asObject(raw);
	if (!root) return [];
	const wrapper = asObject(root.workloads);
	const items = asArray(wrapper?.items);
	return items
		.map((entry) => projectWorkload(entry))
		.filter((w): w is WorkloadSnapshot => w !== null);
}

function projectFlavorUsage(value: unknown): FlavorUsageLite[] {
	const out: FlavorUsageLite[] = [];
	for (const entry of asArray(value)) {
		const obj = asObject(entry);
		if (!obj) continue;
		const name = asString(obj.name);
		if (!name) continue;
		const resources: ResourceQuantityLite[] = [];
		for (const r of asArray(obj.resources)) {
			const robj = asObject(r);
			if (!robj) continue;
			const resource = asString(robj.name);
			if (!resource) continue;
			resources.push({
				resource,
				nominal: '',
				borrowingLimit: null,
				lendingLimit: null,
				used: asQuantity(robj.total ?? robj.used),
				reserved: asQuantity(robj.borrowed ?? robj.reserved),
			});
		}
		out.push({ flavor: name, resources });
	}
	return out;
}

/**
 * Merge nominal quotas (from spec.resourceGroups) into the per-flavor
 * usage map. ClusterQueueList items carry both flavorsUsage (live) and
 * resourceGroups (declared) — the UI wants them aligned per-flavor so
 * a single progress bar renders without two-pass joins on the client.
 */
function mergeNominalQuotas(
	usage: FlavorUsageLite[],
	resourceGroups: unknown,
	flavorsReservation: unknown,
): FlavorUsageLite[] {
	const reservedByFlavor = new Map<string, Map<string, string>>();
	for (const entry of projectFlavorUsage(flavorsReservation)) {
		const inner = new Map<string, string>();
		for (const r of entry.resources) inner.set(r.resource, r.used);
		reservedByFlavor.set(entry.flavor, inner);
	}

	const nominalByFlavor = new Map<string, Map<string, ResourceQuantityLite>>();
	for (const group of asArray(resourceGroups)) {
		const flavors = asArray(asObject(group)?.flavors);
		for (const flavor of flavors) {
			const fobj = asObject(flavor);
			const flavorName = asString(fobj?.name);
			if (!flavorName) continue;
			const inner = nominalByFlavor.get(flavorName) ?? new Map();
			for (const r of asArray(fobj?.resources)) {
				const robj = asObject(r);
				if (!robj) continue;
				const resource = asString(robj.name);
				if (!resource) continue;
				const borrowing = asQuantity(robj.borrowingLimit, '');
				const lending = asQuantity(robj.lendingLimit, '');
				inner.set(resource, {
					resource,
					nominal: asQuantity(robj.nominalQuota),
					borrowingLimit: borrowing || null,
					lendingLimit: lending || null,
					used: '0',
					reserved: '0',
				});
			}
			nominalByFlavor.set(flavorName, inner);
		}
	}

	// Merge usage values into the nominal map; keep flavors that exist in
	// either source.
	for (const entry of usage) {
		const inner = nominalByFlavor.get(entry.flavor) ?? new Map();
		for (const r of entry.resources) {
			const existing = inner.get(r.resource);
			if (existing) {
				existing.used = r.used;
			} else {
				inner.set(r.resource, {
					...r,
					nominal: '0',
				});
			}
			const reserved = reservedByFlavor.get(entry.flavor)?.get(r.resource);
			if (reserved !== undefined) {
				const target = inner.get(r.resource);
				if (target) target.reserved = reserved;
			}
		}
		nominalByFlavor.set(entry.flavor, inner);
	}

	const out: FlavorUsageLite[] = [];
	for (const [flavor, resources] of nominalByFlavor) {
		out.push({ flavor, resources: Array.from(resources.values()) });
	}
	return out;
}

export function projectClusterQueueList(raw: unknown): ClusterQueueSnapshot[] {
	const out: ClusterQueueSnapshot[] = [];
	for (const entry of asArray(raw)) {
		const obj = asObject(entry);
		if (!obj) continue;
		const name = asString(obj.name);
		if (!name) continue;
		const flavorsUsage = projectFlavorUsage(obj.flavorsUsage);
		const merged = mergeNominalQuotas(
			flavorsUsage,
			obj.resourceGroups,
			obj.flavorsReservation,
		);
		out.push({
			name,
			cohort: asString(obj.cohort) || null,
			queueingStrategy: asString(obj.queueingStrategy) || null,
			stopPolicy: asString(obj.stopPolicy) || null,
			admittedWorkloads: asNumber(obj.admittedWorkloads, 0) ?? 0,
			pendingWorkloads: asNumber(obj.pendingWorkloads, 0) ?? 0,
			reservingWorkloads: asNumber(obj.reservingWorkloads, 0) ?? 0,
			flavorsUsage: merged,
			conditions: projectConditions(obj.conditions),
		});
	}
	return out;
}

export function projectLocalQueueList(raw: unknown): LocalQueueSnapshot[] {
	const out: LocalQueueSnapshot[] = [];
	for (const entry of asArray(raw)) {
		const obj = asObject(entry);
		if (!obj) continue;
		const name = asString(obj.name);
		const namespace = asString(obj.namespace);
		if (!name || !namespace) continue;
		const spec = asObject(obj.spec);
		const status = asObject(obj.status);
		out.push({
			name,
			namespace,
			clusterQueue: asString(spec?.clusterQueue),
			admittedWorkloads: asNumber(status?.admittedWorkloads, 0) ?? 0,
			pendingWorkloads: asNumber(status?.pendingWorkloads, 0) ?? 0,
			reservingWorkloads: asNumber(status?.reservingWorkloads, 0) ?? 0,
		});
	}
	return out;
}

export function projectResourceFlavorList(raw: unknown): ResourceFlavorSnapshot[] {
	const out: ResourceFlavorSnapshot[] = [];
	for (const entry of asArray(raw)) {
		const obj = asObject(entry);
		if (!obj) continue;
		// Upstream returns the raw `kueueapi.ResourceFlavor` CRD here (kind +
		// apiVersion + metadata + spec), but the older "details" wrapper was
		// observed in some Kueue versions — handle both.
		const detailsObj = asObject(obj.details) ?? obj;
		const metadata = asObject(detailsObj.metadata);
		const name = asString(metadata?.name) || asString(detailsObj.name) || asString(obj.name);
		if (!name) continue;
		const spec = asObject(detailsObj.spec) ?? detailsObj;
		const labels = asObject(spec.nodeLabels) ?? {};
		const nodeLabels: Record<string, string> = {};
		for (const [k, v] of Object.entries(labels)) {
			if (typeof v === 'string') nodeLabels[k] = v;
		}

		const nodeTaints: ResourceFlavorSnapshot['nodeTaints'] = [];
		for (const t of asArray(spec.nodeTaints)) {
			const tobj = asObject(t);
			if (!tobj) continue;
			const key = asString(tobj.key);
			if (!key) continue;
			const taint: { key: string; value?: string; effect: string } = {
				key,
				effect: asString(tobj.effect),
			};
			const value = asString(tobj.value);
			if (value) taint.value = value;
			nodeTaints.push(taint);
		}

		const tolerations: ResourceFlavorSnapshot['tolerations'] = [];
		for (const t of asArray(spec.tolerations)) {
			const tobj = asObject(t);
			if (!tobj) continue;
			const tol: { key?: string; operator?: string; value?: string; effect?: string } = {};
			const key = asString(tobj.key);
			if (key) tol.key = key;
			const operator = asString(tobj.operator);
			if (operator) tol.operator = operator;
			const value = asString(tobj.value);
			if (value) tol.value = value;
			const effect = asString(tobj.effect);
			if (effect) tol.effect = effect;
			tolerations.push(tol);
		}

		out.push({ name, nodeLabels, nodeTaints, tolerations });
	}
	return out;
}

export function projectCohortList(raw: unknown): CohortSnapshot[] {
	const out: CohortSnapshot[] = [];
	for (const entry of asArray(raw)) {
		const obj = asObject(entry);
		if (!obj) continue;
		const name = asString(obj.name);
		if (!name) continue;
		const clusterQueues: string[] = [];
		for (const cq of asArray(obj.clusterQueues)) {
			if (typeof cq === 'string' && cq) clusterQueues.push(cq);
			else {
				const cqName = asString(asObject(cq)?.name);
				if (cqName) clusterQueues.push(cqName);
			}
		}
		out.push({
			name,
			parentName: asString(obj.parentName) || null,
			clusterQueues,
		});
	}
	return out;
}

function projectPodSets(value: unknown): WorkloadPodSetSummary[] {
	const out: WorkloadPodSetSummary[] = [];
	for (const entry of asArray(value)) {
		const obj = asObject(entry);
		if (!obj) continue;
		const name = asString(obj.name);
		if (!name) continue;
		const template = asObject(obj.template);
		const podSpec = asObject(template?.spec);
		const containers = asArray(podSpec?.containers);
		const requests: Record<string, string> = {};
		for (const c of containers) {
			const cobj = asObject(c);
			const reqs = asObject(asObject(cobj?.resources)?.requests) ?? {};
			for (const [resource, raw] of Object.entries(reqs)) {
				const q = asQuantity(raw, '');
				if (!q) continue;
				// Sum across containers when the same resource appears multiple times.
				const prev = requests[resource];
				if (!prev) requests[resource] = q;
				else if (prev === q) continue;
				else requests[resource] = `${prev}+${q}`;
			}
		}
		out.push({
			name,
			count: asNumber(obj.count, 0) ?? 0,
			requests,
		});
	}
	return out;
}

function projectAdmission(value: unknown): WorkloadAdmission | null {
	const admission = asObject(value);
	if (!admission) return null;
	const cq = asString(admission.clusterQueue);
	const podSetAssignments = asArray(admission.podSetAssignments);
	if (!cq && podSetAssignments.length === 0) return null;
	const assignments: WorkloadAdmissionAssignment[] = [];
	for (const ps of podSetAssignments) {
		const psObj = asObject(ps);
		if (!psObj) continue;
		const podSetName = asString(psObj.name);
		const flavorsObj = asObject(psObj.flavors);
		const resourceAssignmentsObj = asObject(psObj.resourceUsage) ?? {};
		// Upstream emits one entry per resource (`cpu: dev-benchmark, memory:
		// dev-benchmark, ...`) — the practical info is the deduped set.
		const flavorsSet = new Set<string>();
		if (flavorsObj) {
			for (const [, v] of Object.entries(flavorsObj)) {
				if (typeof v === 'string' && v) flavorsSet.add(v);
			}
		}
		const flavors = Array.from(flavorsSet);
		const resourceAssignments: Record<string, string> = {};
		for (const [r, q] of Object.entries(resourceAssignmentsObj)) {
			const value = asQuantity(q, '');
			if (value) resourceAssignments[r] = value;
		}
		assignments.push({
			podSetName,
			flavor: flavors.length > 0 ? flavors.join(', ') : '',
			resourceAssignments,
		});
	}
	return { clusterQueue: cq, assignments };
}

export function projectWorkloadDetail(raw: unknown): WorkloadDetailSnapshot | null {
	// Upstream `/ws/workload/:ns/:name` returns the bare CRD even though the
	// handler builds a richer envelope and discards it (a known upstream
	// bug). Project from the raw CRD shape.
	const base = projectWorkload(raw);
	if (!base) return null;
	const obj = asObject(raw);
	const metadata = obj ? asObject(obj.metadata) : null;
	const spec = obj ? asObject(obj.spec) : null;
	const status = obj ? asObject(obj.status) : null;

	const annotationsRaw = asObject(metadata?.annotations) ?? {};
	const annotations: Record<string, string> = {};
	for (const [k, v] of Object.entries(annotationsRaw)) {
		if (typeof v === 'string') annotations[k] = v;
	}

	return {
		...base,
		podSets: projectPodSets(spec?.podSets),
		admission: projectAdmission(status?.admission),
		annotations,
	};
}

const KNOWN_EVENT_FIELDS = new Set(['lastTimestamp', 'firstTimestamp', 'eventTime']);

export function projectWorkloadEvents(raw: unknown): WorkloadEventSnapshot[] {
	const out: WorkloadEventSnapshot[] = [];
	for (const entry of asArray(raw)) {
		const obj = asObject(entry);
		if (!obj) continue;
		const reason = asString(obj.reason);
		const message = asString(obj.message);
		if (!reason && !message) continue;
		const source = asObject(obj.source);
		const sourceText = source
			? [asString(source.component), asString(source.host)].filter(Boolean).join(' / ')
			: null;
		// Different Kubernetes versions populate different timestamp fields;
		// pick the freshest available so the UI can sort consistently.
		let lastTimestamp: string | null = null;
		for (const k of KNOWN_EVENT_FIELDS) {
			const v = asString(obj[k]);
			if (!v) continue;
			if (!lastTimestamp || v > lastTimestamp) lastTimestamp = v;
		}
		const firstTimestamp = asString(obj.firstTimestamp) || null;
		out.push({
			type: asString(obj.type) || 'Normal',
			reason,
			message,
			count: asNumber(obj.count, 1) ?? 1,
			firstTimestamp,
			lastTimestamp,
			source: sourceText && sourceText.trim() ? sourceText : null,
		});
	}
	out.sort((a, b) => {
		const ta = a.lastTimestamp ?? '';
		const tb = b.lastTimestamp ?? '';
		return tb.localeCompare(ta);
	});
	return out;
}

/**
 * Top-level projector — picks the right shape based on endpoint key.
 * Anything unrecognized passes through unchanged so the dispatcher can
 * still ship it (even if the shape isn't known yet).
 */
export function projectByEndpoint(endpoint: string, raw: unknown): unknown {
	switch (endpoint) {
		case 'cluster-queues':
			return projectClusterQueueList(raw);
		case 'workloads':
			return projectWorkloadList(raw);
		case 'workload':
			return projectWorkloadDetail(raw);
		case 'workload-events':
			return projectWorkloadEvents(raw);
		case 'resource-flavors':
			return projectResourceFlavorList(raw);
		case 'local-queues':
			return projectLocalQueueList(raw);
		case 'cohorts':
			return projectCohortList(raw);
		default:
			return raw;
	}
}
