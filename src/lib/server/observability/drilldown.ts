/**
 * Scope a full-run ObservabilityInvestigationPayload down to a single service-graph
 * selection (a node or an edge), so the existing investigation studio can render the
 * spans / API requests / LLM turns / tool calls / logs for just that selection.
 *
 * The graph and this filter share the same span→node logic (collapseServiceName,
 * virtualPeer, Client→Server pairing) so a selection here means exactly what the
 * canvas drew.
 */
import type {
	ObservabilityInvestigationPayload,
	ObservabilityTraceSpan
} from '$lib/types/observability';
import type { GraphSelection, ServiceGraphMode } from '$lib/types/service-graph';
import { collapseServiceName, virtualPeer } from '$lib/server/otel/service-graph';

/**
 * The service name(s) whose spans we can fetch up-front from ClickHouse for this
 * selection (pushes the filter into the query instead of fetch-all-then-filter).
 * Returns null when the selection needs the full span tree (step mode, or
 * db/external/user nodes whose calling client spans live in other services).
 */
export function selectionServiceScope(
	selection: GraphSelection,
	mode: ServiceGraphMode
): string[] | null {
	if (mode !== 'service') return null; // step mode needs the full tree (descendants)
	if (selection.kind === 'node') {
		return selection.nodeKind === 'service' ? [selection.id] : null;
	}
	// edge: scope to the real service endpoint(s); user/db/external endpoints don't
	// constrain by ServiceName (their related client spans live elsewhere).
	const isService = (id: string) =>
		id !== 'user' && !id.startsWith('db:') && !id.startsWith('ext:');
	const svcs = [selection.source, selection.target].filter(isService);
	return svcs.length ? svcs : null;
}

const CLIENT_KINDS = new Set(['Client', 'Producer']);
const SERVER_KINDS = new Set(['Server', 'Consumer']);
const NODE_ATTR = 'workflow.node.id';

function nodeAttr(span: ObservabilityTraceSpan): string {
	const v = span.attributes?.[NODE_ATTR];
	return v != null ? String(v) : '';
}

/** Index children by parentSpanId. */
function buildChildIndex(
	spans: ObservabilityTraceSpan[]
): Map<string, ObservabilityTraceSpan[]> {
	const childrenOf = new Map<string, ObservabilityTraceSpan[]>();
	for (const s of spans) {
		if (!s.parentSpanId) continue;
		const list = childrenOf.get(s.parentSpanId);
		if (list) list.push(s);
		else childrenOf.set(s.parentSpanId, [s]);
	}
	return childrenOf;
}

/** BFS from seed span ids over the child index; returns seeds + all descendants. */
function collectDescendants(
	seeds: Set<string>,
	childrenOf: Map<string, ObservabilityTraceSpan[]>
): Set<string> {
	const out = new Set<string>(seeds);
	const queue = [...seeds];
	while (queue.length) {
		const id = queue.shift()!;
		for (const child of childrenOf.get(id) ?? []) {
			if (!out.has(child.spanId)) {
				out.add(child.spanId);
				queue.push(child.spanId);
			}
		}
	}
	return out;
}

interface ScopeResult {
	/** Retained span ids (waterfall + membership for llm/tool/log/evidence). */
	retained: Set<string>;
	/** When a whole service is selected, also keep llm/tool/logs by serviceName. */
	serviceScope: string | null;
	/** Workflow step ids in scope (for workflowSteps + step-keyed events/issues). */
	stepIds: Set<string>;
}

function scopeSpans(
	spans: ObservabilityTraceSpan[],
	selection: GraphSelection
): ScopeResult {
	const byId = new Map(spans.map((s) => [s.spanId, s]));
	const childrenOf = buildChildIndex(spans);
	const isRootServer = (s: ObservabilityTraceSpan) =>
		s.spanKind != null &&
		SERVER_KINDS.has(s.spanKind) &&
		(!s.parentSpanId || !byId.has(s.parentSpanId));

	let serviceScope: string | null = null;
	const stepIds = new Set<string>();
	const seeds = new Set<string>();

	if (selection.kind === 'node') {
		if (selection.nodeKind === 'service') {
			serviceScope = selection.id;
			for (const s of spans)
				if (collapseServiceName(s.serviceName) === selection.id) seeds.add(s.spanId);
		} else if (selection.nodeKind === 'db' || selection.nodeKind === 'external') {
			for (const s of spans) {
				const peer = virtualPeer(s);
				if (peer && peer.id === selection.id) seeds.add(s.spanId);
			}
		} else if (selection.nodeKind === 'user') {
			for (const s of spans) if (isRootServer(s)) seeds.add(s.spanId);
		} else {
			// step node
			stepIds.add(selection.id);
			for (const s of spans) if (nodeAttr(s) === selection.id) seeds.add(s.spanId);
		}
	} else {
		// edge
		const { source, target } = selection;
		const stepLike = spans.some((s) => {
			const v = nodeAttr(s);
			return v === source || v === target;
		});
		if (stepLike) {
			stepIds.add(source);
			stepIds.add(target);
			for (const s of spans) {
				const v = nodeAttr(s);
				if (v === source || v === target) seeds.add(s.spanId);
			}
		} else {
			// service edge: client spans in `source` paired with a server child in `target`
			for (const s of spans) {
				const svc = collapseServiceName(s.serviceName);
				if (s.spanKind && CLIENT_KINDS.has(s.spanKind) && (svc === source || source === 'user')) {
					for (const child of childrenOf.get(s.spanId) ?? []) {
						if (child.spanKind && SERVER_KINDS.has(child.spanKind) && collapseServiceName(child.serviceName) === target) {
							seeds.add(s.spanId);
							seeds.add(child.spanId);
						}
					}
					const peer = virtualPeer(s);
					if (peer && peer.id === target && svc === source) seeds.add(s.spanId);
				}
				// user → service: root server spans of the target
				if (source === 'user' && isRootServer(s) && svc === target) seeds.add(s.spanId);
			}
		}
	}

	return { retained: collectDescendants(seeds, childrenOf), serviceScope, stepIds };
}

export function filterInvestigationToSelection(
	payload: ObservabilityInvestigationPayload,
	selection: GraphSelection
): ObservabilityInvestigationPayload {
	const { retained, serviceScope, stepIds } = scopeSpans(payload.traceSpans, selection);
	const inSet = (spanId?: string | null) => spanId != null && retained.has(spanId);
	const svcMatch = (svc?: string | null) =>
		serviceScope != null && svc != null && collapseServiceName(svc) === serviceScope;
	const stepMatch = (name?: string | null) => name != null && stepIds.has(name);

	const traceSpans = payload.traceSpans.filter((s) => retained.has(s.spanId));
	const llmSpans = payload.llmSpans.filter((s) => inSet(s.spanId) || svcMatch(s.serviceName));
	const toolSpans = payload.toolSpans.filter((s) => inSet(s.spanId) || svcMatch(s.serviceName));
	const logs = payload.logs.filter((l) => inSet(l.spanId) || svcMatch(l.serviceName));

	const workflowSteps = payload.workflowSteps.filter((st) =>
		stepIds.size > 0
			? stepMatch(st.stepName) || stepMatch(st.id)
			: serviceScope != null && svcMatch(st.routedTo)
	);

	const agentDecisions = payload.agentDecisions.filter(
		(d) => inSet(d.evidence?.spanId) || svcMatch(d.serviceName)
	);
	const issues = payload.issues.filter(
		(i) => inSet(i.spanId) || svcMatch(i.serviceName) || stepMatch(i.workflowStepName)
	);
	const events = payload.events.filter(
		(e) => inSet(e.spanId) || svcMatch(e.serviceName) || stepMatch(e.workflowStepName)
	);

	return {
		...payload,
		traceSpans,
		llmSpans,
		toolSpans,
		logs,
		workflowSteps,
		agentDecisions,
		issues,
		events
	};
}
