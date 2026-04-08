/**
 * Centralized selection/hover state for the observability tracing UI.
 *
 * All child components read and write through this store (via context)
 * instead of maintaining their own local selection state.
 *
 * Cross-filter sync: selecting a turn highlights its spans in the waterfall;
 * selecting a span auto-selects the matching turn.
 */
import type {
	ObservabilityAgentDecisionTurn,
	ObservabilityInvestigationPayload
} from '$lib/types/observability';

export type SignalFilter = 'all' | 'errors' | 'llm' | 'tools';
export type LogPaneMode = 'session' | 'span';
export type DetailTab = 'overview' | 'conversation' | 'llm' | 'tools' | 'logs' | 'raw';

export function createObservabilitySelectionStore() {
	// --- Primary selection state ---
	let selectedSpanRef = $state<{ traceId: string; spanId: string } | null>(null);
	let selectedDecisionId = $state<string | null>(null);
	let selectedLogKey = $state<string | null>(null);

	// --- Hover state ---
	let hoveredSpanRef = $state<{ traceId: string; spanId: string } | null>(null);
	let hoveredDecisionId = $state<string | null>(null);

	// --- Filter state ---
	let signalFilter = $state<SignalFilter>('all');
	let serviceFilter = $state('all');
	let traceFilter = $state('all');
	let logMode = $state<LogPaneMode>('session');

	// --- Panel state ---
	let detailTab = $state<DetailTab>('overview');
	let detailPanelWidth = $state(420);
	let logDockHeight = $state(200);
	let logDockCollapsed = $state(true);

	// --- Diagram interaction ---
	let selectedDiagramNodeId = $state<string | null>(null);
	let selectedDiagramEdgeId = $state<string | null>(null);

	// --- Data binding (set by the parent) ---
	let payload = $state<ObservabilityInvestigationPayload | null>(null);

	// --- Derived: related elements for cross-filtering ---
	const selectedDecision = $derived.by(() => {
		if (!selectedDecisionId || !payload) return null;
		return payload.agentDecisions.find((d) => d.id === selectedDecisionId) ?? null;
	});

	const relatedSpanKeys = $derived.by(() => {
		const keys = new Set<string>();
		if (!selectedDecision) return keys;
		const ev = selectedDecision.evidence;
		if (ev.traceId && ev.spanId) {
			keys.add(`${ev.traceId}:${ev.spanId}`);
		}
		for (const toolSpanId of ev.toolSpanIds) {
			// Tool spans may be under a different traceId; search payload
			const toolSpan = payload?.toolSpans.find((t) => t.spanId === toolSpanId);
			if (toolSpan) keys.add(`${toolSpan.traceId}:${toolSpan.spanId}`);
		}
		return keys;
	});

	const relatedLogKeys = $derived.by(() => {
		const keys = new Set<string>();
		if (!selectedDecision) return keys;
		for (const logId of selectedDecision.evidence.logIds) {
			keys.add(logId);
		}
		return keys;
	});

	// --- Actions ---

	function selectSpan(ref: { traceId: string; spanId: string } | null, opts?: { autoSwitchTab?: boolean }) {
		selectedSpanRef = ref;
		if (!ref || !payload) return;

		// Auto-select matching decision (reverse cross-filter)
		const spanKey = `${ref.traceId}:${ref.spanId}`;
		const matchingDecision = payload.agentDecisions.find((d) => {
			const ev = d.evidence;
			if (`${ev.traceId}:${ev.spanId}` === spanKey) return true;
			return ev.toolSpanIds.some((tsId) => {
				const ts = payload!.toolSpans.find((t) => t.spanId === tsId);
				return ts && `${ts.traceId}:${ts.spanId}` === spanKey;
			});
		});
		if (matchingDecision) {
			selectedDecisionId = matchingDecision.id;
		}

		// Auto-switch detail tab based on span content (only on explicit user action)
		if (opts?.autoSwitchTab !== false) {
			const hasLlm = payload.llmSpans.some(
				(l) => l.traceId === ref.traceId && l.spanId === ref.spanId
			);
			const hasTool = payload.toolSpans.some(
				(t) => t.traceId === ref.traceId && t.spanId === ref.spanId
			);
			if (hasLlm) detailTab = 'llm';
			else if (hasTool) detailTab = 'tools';
			else detailTab = 'overview';
		}
	}

	function selectDecision(id: string | null) {
		selectedDecisionId = id;
		if (!id || !payload) return;

		const decision = payload.agentDecisions.find((d) => d.id === id);
		if (decision?.evidence.traceId && decision.evidence.spanId) {
			selectedSpanRef = {
				traceId: decision.evidence.traceId,
				spanId: decision.evidence.spanId
			};
		}
		detailTab = 'conversation';
	}

	function selectLog(key: string | null) {
		selectedLogKey = key;
	}

	function selectDiagramNode(nodeId: string | null) {
		selectedDiagramNodeId = nodeId;
		selectedDiagramEdgeId = null;
	}

	function selectDiagramEdge(edgeId: string | null) {
		selectedDiagramEdgeId = edgeId;
		selectedDiagramNodeId = null;
	}

	function hoverSpan(ref: { traceId: string; spanId: string } | null) {
		hoveredSpanRef = ref;
	}

	function hoverDecision(id: string | null) {
		hoveredDecisionId = id;
	}

	function setSignalFilter(filter: SignalFilter) {
		signalFilter = filter;
	}

	function setServiceFilter(filter: string) {
		serviceFilter = filter;
	}

	function setTraceFilter(filter: string) {
		traceFilter = filter;
	}

	function setLogMode(mode: LogPaneMode) {
		logMode = mode;
	}

	function setDetailTab(tab: DetailTab) {
		detailTab = tab;
	}

	function setDetailPanelWidth(width: number) {
		detailPanelWidth = Math.max(320, Math.min(width, 900));
	}

	function toggleLogDock() {
		logDockCollapsed = !logDockCollapsed;
	}

	function setPayload(p: ObservabilityInvestigationPayload | null) {
		payload = p;
	}

	function clearSelection() {
		selectedSpanRef = null;
		selectedDecisionId = null;
		selectedLogKey = null;
		hoveredSpanRef = null;
		hoveredDecisionId = null;
		selectedDiagramNodeId = null;
		selectedDiagramEdgeId = null;
	}

	return {
		// Read-only state
		get selectedSpanRef() { return selectedSpanRef; },
		get selectedDecisionId() { return selectedDecisionId; },
		get selectedLogKey() { return selectedLogKey; },
		get hoveredSpanRef() { return hoveredSpanRef; },
		get hoveredDecisionId() { return hoveredDecisionId; },
		get signalFilter() { return signalFilter; },
		get serviceFilter() { return serviceFilter; },
		get traceFilter() { return traceFilter; },
		get logMode() { return logMode; },
		get detailTab() { return detailTab; },
		get detailPanelWidth() { return detailPanelWidth; },
		get logDockHeight() { return logDockHeight; },
		get logDockCollapsed() { return logDockCollapsed; },
		get selectedDiagramNodeId() { return selectedDiagramNodeId; },
		get selectedDiagramEdgeId() { return selectedDiagramEdgeId; },
		get payload() { return payload; },

		// Derived
		get selectedDecision() { return selectedDecision; },
		get relatedSpanKeys() { return relatedSpanKeys; },
		get relatedLogKeys() { return relatedLogKeys; },

		// Actions
		selectSpan,
		selectDecision,
		selectLog,
		selectDiagramNode,
		selectDiagramEdge,
		hoverSpan,
		hoverDecision,
		setSignalFilter,
		setServiceFilter,
		setTraceFilter,
		setLogMode,
		setDetailTab,
		setDetailPanelWidth,
		toggleLogDock,
		setPayload,
		clearSelection,
	};
}

export type ObservabilitySelectionStore = ReturnType<typeof createObservabilitySelectionStore>;
