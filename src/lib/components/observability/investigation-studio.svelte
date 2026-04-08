<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { setContext } from 'svelte';
	import type {
		ObservabilityAgentDecisionDiagramEdge,
		ObservabilityAgentDecisionDiagramNode,
		ObservabilityAgentDecisionTurn,
		ObservabilityInvestigationPayload,
		ObservabilityLogEntry,
		ObservabilityTraceSpan
	} from '$lib/types/observability';
	import { createObservabilitySelectionStore } from '$lib/stores/observability-selection.svelte';
	import ObservabilityLayout from './observability-layout.svelte';
	import TurnNavigator from './turn-navigator.svelte';
	import AgentConversationView from './agent-conversation-view.svelte';
	import AgentStateDiagram from '$lib/components/observability/agent-state-diagram.svelte';
	import MetricsStrip from '$lib/components/observability/metrics-strip.svelte';
	import TraceConsole from '$lib/components/observability/trace-console.svelte';
	import CorrelatedLogPane from '$lib/components/observability/correlated-log-pane.svelte';
	import SpanEvidencePanel from '$lib/components/observability/span-evidence-panel.svelte';
	import { AlertTriangle, Bot, ChevronDown, ChevronRight, ExternalLink, RefreshCcw, Wrench } from 'lucide-svelte';

	interface Props {
		payload: ObservabilityInvestigationPayload | null;
		isLoading?: boolean;
		error?: string | null;
		phoenixHref?: string | null;
		fullTraceHref?: string | null;
		onRefresh?: () => void;
	}

	let {
		payload,
		isLoading = false,
		error = null,
		phoenixHref = null,
		fullTraceHref = null,
		onRefresh = () => {}
	}: Props = $props();

	// --- Store ---
	const store = createObservabilitySelectionStore();
	setContext('observability-selection', store);

	// Sync payload to store
	$effect(() => { store.setPayload(payload); });

	// --- Local UI state ---
	let collapsedTraceIds = $state<Set<string>>(new Set());
	let showDiagram = $state(false);
	let mainViewTab = $state<'turns' | 'waterfall'>('turns');

	// --- Helpers ---
	function formatDuration(value: number): string {
		if (!Number.isFinite(value) || value <= 0) return '0ms';
		if (value < 1000) return `${Math.round(value)}ms`;
		return `${(value / 1000).toFixed(2)}s`;
	}

	function formatTimeWindow(start: string | null, end: string | null): string | null {
		if (!start) return null;
		const fmt = (d: string) => new Date(d).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
		return end ? `${fmt(start)} -> ${fmt(end)}` : fmt(start);
	}

	function rowKey(span: Pick<ObservabilityTraceSpan, 'traceId' | 'spanId'>): string {
		return `${span.traceId}:${span.spanId}`;
	}

	function logKey(log: ObservabilityLogEntry, index: number): string {
		return `${log.timestamp}:${log.traceId}:${log.spanId}:${index}`;
	}

	function isErrorLog(log: ObservabilityLogEntry): boolean {
		const s = log.severityText.toLowerCase();
		return s.includes('error') || s.includes('fatal') || s.includes('warn');
	}

	function recordContains(record: Record<string, unknown>, terms: string[]): boolean {
		return Object.entries(record).some(([key, value]) => {
			const n = `${key} ${typeof value === 'string' ? value : JSON.stringify(value)}`.toLowerCase();
			return terms.some((t) => n.includes(t));
		});
	}

	function isLlmRelatedLog(log: ObservabilityLogEntry): boolean {
		const terms = ['llm', 'gen_ai', 'openai', 'anthropic', 'model', 'callllm', 'openinference'];
		if (terms.some((t) => `${log.serviceName} ${log.body}`.toLowerCase().includes(t))) return true;
		return recordContains(log.logAttributes ?? {}, terms) || recordContains(log.resourceAttributes ?? {}, terms);
	}

	function isToolRelatedLog(log: ObservabilityLogEntry): boolean {
		const terms = ['tool', 'execute_command', 'run_shell_command', 'tool_call', 'tool result'];
		if (terms.some((t) => `${log.serviceName} ${log.body}`.toLowerCase().includes(t))) return true;
		return recordContains(log.logAttributes ?? {}, terms) || recordContains(log.resourceAttributes ?? {}, terms);
	}

	// --- Derived data ---
	const allTraceSpans = $derived(payload?.traceSpans ?? []);
	const allLogs = $derived(payload?.logs ?? []);
	const allLlmSpans = $derived(payload?.llmSpans ?? []);
	const allToolSpans = $derived(payload?.toolSpans ?? []);
	const allAgentDecisions = $derived(payload?.agentDecisions ?? []);

	const llmCounts = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const span of allLlmSpans) counts[rowKey(span)] = (counts[rowKey(span)] ?? 0) + 1;
		return counts;
	});

	const toolCounts = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const span of allToolSpans) counts[rowKey(span)] = (counts[rowKey(span)] ?? 0) + 1;
		return counts;
	});

	const logCounts = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const log of allLogs) {
			if (!log.traceId || !log.spanId) continue;
			counts[`${log.traceId}:${log.spanId}`] = (counts[`${log.traceId}:${log.spanId}`] ?? 0) + 1;
		}
		return counts;
	});

	function spanMatches(span: ObservabilityTraceSpan): boolean {
		if (store.traceFilter !== 'all' && span.traceId !== store.traceFilter) return false;
		if (store.serviceFilter !== 'all' && span.serviceName !== store.serviceFilter) return false;
		if (store.signalFilter === 'errors') return span.status === 'error';
		if (store.signalFilter === 'llm') return (llmCounts[rowKey(span)] ?? 0) > 0;
		if (store.signalFilter === 'tools') return (toolCounts[rowKey(span)] ?? 0) > 0;
		return true;
	}

	const visibleTraceSpans = $derived(allTraceSpans.filter(spanMatches));
	const visibleTraceIds = $derived([...new Set(visibleTraceSpans.map((s) => s.traceId))]);

	const traceGroups = $derived.by(() => {
		const groups = new Map<string, { traceId: string; label: string; serviceName: string; startTime: string; durationMs: number; spanCount: number; errorCount: number; spans: ObservabilityTraceSpan[] }>();
		for (const span of visibleTraceSpans) {
			const existing = groups.get(span.traceId);
			if (existing) {
				existing.spans.push(span);
				existing.spanCount += 1;
				existing.errorCount += span.status === 'error' ? 1 : 0;
				const end = new Date(span.startTime).getTime() + span.duration;
				const existingEnd = new Date(existing.startTime).getTime() + existing.durationMs;
				const start = Math.min(new Date(existing.startTime).getTime(), new Date(span.startTime).getTime());
				const finish = Math.max(existingEnd, end);
				existing.startTime = new Date(start).toISOString();
				existing.durationMs = finish - start;
			} else {
				groups.set(span.traceId, { traceId: span.traceId, label: span.operationName, serviceName: span.serviceName, startTime: span.startTime, durationMs: span.duration, spanCount: 1, errorCount: span.status === 'error' ? 1 : 0, spans: [span] });
			}
		}
		return [...groups.values()]
			.map((g) => ({ ...g, spans: [...g.spans].sort((a, b) => { const t = new Date(a.startTime).getTime() - new Date(b.startTime).getTime(); return t !== 0 ? t : a.depth !== b.depth ? a.depth - b.depth : a.operationName.localeCompare(b.operationName); }) }))
			.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
	});

	const globalStartMs = $derived(traceGroups.length > 0 ? Math.min(...traceGroups.map((g) => new Date(g.startTime).getTime())) : 0);
	const globalDurationMs = $derived(traceGroups.length > 0 ? Math.max(...traceGroups.map((g) => new Date(g.startTime).getTime() + g.durationMs)) - globalStartMs : 1);

	const activeDetailTab = $derived(store.detailTab);
	const activeSelectedSpanRef = $derived(store.selectedSpanRef);
	const activeRelatedSpanKeys = $derived(store.relatedSpanKeys);
	const activeSelectedLogKey = $derived(store.selectedLogKey);
	const activeLogMode = $derived(store.logMode);
	const activeSignalFilter = $derived(store.signalFilter);
	const activeServiceFilter = $derived(store.serviceFilter);
	const activeTraceFilter = $derived(store.traceFilter);
	const activeSelectedDecision = $derived(store.selectedDecision);

	const selectedSpan = $derived.by(() => {
		if (!store.selectedSpanRef) return null;
		return allTraceSpans.find((s) => s.traceId === store.selectedSpanRef?.traceId && s.spanId === store.selectedSpanRef?.spanId) ?? null;
	});

	const filteredAgentDecisions = $derived.by(() => {
		let next = allAgentDecisions;
		if (store.traceFilter !== 'all') next = next.filter((d) => d.traceId === store.traceFilter);
		if (store.serviceFilter !== 'all') next = next.filter((d) => d.serviceName === store.serviceFilter);
		if (store.signalFilter === 'errors') next = next.filter((d) => d.decisionType === 'error');
		if (store.signalFilter === 'tools') next = next.filter((d) => d.decisionType === 'tool_call');
		if (store.selectedDiagramEdgeId && payload?.agentDecisionDiagram) {
			const edge = payload.agentDecisionDiagram.edges.find((e) => e.id === store.selectedDiagramEdgeId);
			if (edge) next = next.filter((d) => edge.turnIds.includes(d.id));
		} else if (store.selectedDiagramNodeId && ['tool_call', 'assistant_message', 'wait_or_approval', 'stop', 'error'].includes(store.selectedDiagramNodeId)) {
			next = next.filter((d) => d.decisionType === store.selectedDiagramNodeId);
		}
		return next;
	});

	// Auto-select first visible span (don't switch tabs on auto-select)
	$effect(() => {
		if (visibleTraceSpans.length === 0) { store.selectSpan(null); return; }
		const selected = store.selectedSpanRef;
		const visible = selected ? visibleTraceSpans.some((s) => s.traceId === selected.traceId && s.spanId === selected.spanId) : false;
		if (!visible) {
			const first = visibleTraceSpans[0];
			store.selectSpan({ traceId: first.traceId, spanId: first.spanId }, { autoSwitchTab: false });
		}
	});

	const serviceOptions = $derived([...new Set(allTraceSpans.map((s) => s.serviceName).filter(Boolean))].sort());
	const traceOptions = $derived([...new Set(allTraceSpans.map((s) => s.traceId).filter(Boolean))]);

	const visibleLogs = $derived.by(() => {
		let next = allLogs;
		if (store.traceFilter !== 'all') next = next.filter((l) => l.traceId === store.traceFilter);
		if (store.serviceFilter !== 'all') next = next.filter((l) => l.serviceName === store.serviceFilter);
		if (store.signalFilter === 'errors') next = next.filter(isErrorLog);
		if (store.signalFilter === 'llm') next = next.filter(isLlmRelatedLog);
		if (store.signalFilter === 'tools') next = next.filter(isToolRelatedLog);
		if (store.logMode === 'span' && store.selectedSpanRef) {
			next = next.filter((l) => l.traceId === store.selectedSpanRef?.traceId && l.spanId === store.selectedSpanRef?.spanId);
		}
		return next;
	});

	const selectedLog = $derived.by(() => {
		if (!store.selectedLogKey) return null;
		for (const [i, log] of visibleLogs.entries()) { if (logKey(log, i) === store.selectedLogKey) return log; }
		return null;
	});

	const relatedLogs = $derived.by(() => {
		if (!store.selectedSpanRef) return [];
		return allLogs.filter((l) => l.traceId === store.selectedSpanRef?.traceId && l.spanId === store.selectedSpanRef?.spanId);
	});

	const relatedLlmSpans = $derived.by(() => {
		if (!store.selectedSpanRef) return [];
		return allLlmSpans.filter((s) => s.traceId === store.selectedSpanRef?.traceId && s.spanId === store.selectedSpanRef?.spanId);
	});

	const relatedToolSpans = $derived.by(() => {
		if (!store.selectedSpanRef) return [];
		return allToolSpans.filter((s) => s.traceId === store.selectedSpanRef?.traceId && s.spanId === store.selectedSpanRef?.spanId);
	});

	const topServices = $derived.by(() => {
		const stats = new Map<string, { name: string; durationMs: number; errors: number }>();
		for (const span of visibleTraceSpans) {
			const e = stats.get(span.serviceName) ?? { name: span.serviceName, durationMs: 0, errors: 0 };
			e.durationMs += span.duration;
			if (span.status === 'error') e.errors += 1;
			stats.set(span.serviceName, e);
		}
		return [...stats.values()].sort((a, b) => b.durationMs - a.durationMs).slice(0, 3);
	});

	const slowestVisibleSpan = $derived([...visibleTraceSpans].sort((a, b) => b.duration - a.duration)[0] ?? null);

	const metricItems = $derived([
		{ label: 'status', value: payload?.summary.status ?? 'unknown', meta: payload?.summary.scope === 'session' ? 'workflow session' : 'trace scope' },
		{ label: 'duration', value: formatDuration(payload?.summary.totalDurationMs ?? 0), meta: `${visibleTraceIds.length} visible traces` },
		{ label: 'spans', value: `${visibleTraceSpans.length}/${payload?.summary.spanCount ?? 0}`, meta: `${payload?.summary.serviceCount ?? 0} services` },
		{ label: 'llm', value: `${allLlmSpans.length}`, meta: `${payload?.summary.totalTokens ?? 0} tokens`, tone: 'llm' as const },
		{ label: 'tools', value: `${allToolSpans.length}`, meta: `${allAgentDecisions.filter((d) => d.decisionType === 'tool_call').length} tool turns`, tone: 'tool' as const },
		{ label: 'turns', value: `${allAgentDecisions.length}`, meta: payload?.agentDecisionSummary?.stopReason ?? 'agent loop', tone: 'llm' as const },
		{ label: 'errors', value: `${payload?.summary.errorCount ?? 0}`, meta: (payload?.summary.errorCount ?? 0) > 0 ? 'failures present' : 'clean', tone: (payload?.summary.errorCount ?? 0) > 0 ? 'error' as const : 'default' as const },
	]);

	// --- Actions ---
	function selectSpan(span: ObservabilityTraceSpan) {
		store.selectSpan({ traceId: span.traceId, spanId: span.spanId });
	}

	function toggleTrace(traceId: string) {
		const next = new Set(collapsedTraceIds);
		if (next.has(traceId)) next.delete(traceId); else next.add(traceId);
		collapsedTraceIds = next;
	}

	function selectLog(log: ObservabilityLogEntry, key: string) {
		store.selectLog(key);
		if (log.traceId && log.spanId) store.selectSpan({ traceId: log.traceId, spanId: log.spanId });
	}

	function selectDiagramNode(node: ObservabilityAgentDecisionDiagramNode) {
		store.selectDiagramNode(store.selectedDiagramNodeId === node.id ? null : node.id);
	}

	function selectDiagramEdge(edge: ObservabilityAgentDecisionDiagramEdge) {
		store.selectDiagramEdge(store.selectedDiagramEdgeId === edge.id ? null : edge.id);
	}

	function clearFilters() {
		store.setSignalFilter('all');
		store.setServiceFilter('all');
		store.setTraceFilter('all');
		store.setLogMode('session');
		store.selectDiagramNode(null);
		store.selectDiagramEdge(null);
	}
</script>

{#if isLoading}
	<div class="flex items-center justify-center h-full text-sm text-zinc-500">
		Loading trace data...
	</div>
{:else if error}
	<div class="m-4 rounded-xl border border-red-500/20 bg-red-500/10 p-6 text-sm text-red-100">
		{error}
	</div>
{:else if payload}
	<ObservabilityLayout>
		{#snippet mainToolbar()}
			<div class="flex flex-wrap items-center gap-2">
				<!-- Main view tabs: Turns / Waterfall -->
				<div class="flex items-center rounded-lg border border-zinc-700 bg-zinc-900 p-0.5">
					<button class="rounded px-2.5 py-1 text-[11px] transition-colors {mainViewTab === 'turns' ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'}"
						onclick={() => mainViewTab = 'turns'}>
						<Bot size={10} class="mr-1 inline" />Turns</button>
					<button class="rounded px-2.5 py-1 text-[11px] transition-colors {mainViewTab === 'waterfall' ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'}"
						onclick={() => mainViewTab = 'waterfall'}>
						<Wrench size={10} class="mr-1 inline" />Waterfall</button>
				</div>

				<!-- Metric pills -->
				<div class="flex items-center gap-1.5 text-[10px]">
					<Badge variant="outline" class="border-white/10 bg-white/5 text-zinc-300">
						{payload.summary.status ?? 'unknown'}
					</Badge>
					<Badge variant="outline" class="border-white/10 bg-white/5 text-zinc-400 font-mono">
						{formatDuration(payload.summary.totalDurationMs ?? 0)}
					</Badge>
					<Badge variant="outline" class="border-cyan-500/20 bg-cyan-500/5 text-cyan-300 font-mono">
						{allLlmSpans.length} LLM
					</Badge>
					<Badge variant="outline" class="border-emerald-500/20 bg-emerald-500/5 text-emerald-300 font-mono">
						{allToolSpans.length} tools
					</Badge>
					<Badge variant="outline" class="border-white/10 bg-white/5 text-zinc-400 font-mono">
						{allAgentDecisions.length} turns
					</Badge>
					{#if (payload.summary.errorCount ?? 0) > 0}
						<Badge variant="outline" class="border-red-500/20 bg-red-500/5 text-red-300 font-mono">
							{payload.summary.errorCount} errors
						</Badge>
					{/if}
				</div>

				<!-- Filters (shown in waterfall mode) -->
				{#if mainViewTab === 'waterfall'}
					<select class="h-7 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-300"
						value={activeServiceFilter}
						onchange={(e) => store.setServiceFilter((e.target as HTMLSelectElement).value)}>
						<option value="all">All services</option>
						{#each serviceOptions as svc}<option value={svc}>{svc}</option>{/each}
					</select>
				{/if}

				<div class="ml-auto flex items-center gap-2">
					{#if phoenixHref}
						<a href={phoenixHref} target="_blank" rel="noopener noreferrer"
							class="text-[10px] text-orange-400 hover:text-orange-300">
							<ExternalLink size={10} class="mr-0.5 inline" /> Phoenix
						</a>
					{/if}
					<button class="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
						onclick={() => onRefresh()}>
						<RefreshCcw size={12} /> Refresh
					</button>
				</div>
			</div>
		{/snippet}

		{#snippet mainContent()}
			{#if mainViewTab === 'turns'}
				<TurnNavigator decisions={filteredAgentDecisions} />
			{:else}
				<TraceConsole
					groups={traceGroups}
					selectedSpan={activeSelectedSpanRef}
					relatedSpanKeys={activeRelatedSpanKeys}
					{llmCounts}
					{toolCounts}
					{logCounts}
					{globalStartMs}
					{globalDurationMs}
					{collapsedTraceIds}
					onToggleTrace={toggleTrace}
					onSelectSpan={selectSpan}
				/>
			{/if}
		{/snippet}

		{#snippet bottomDock()}
			<CorrelatedLogPane
				logs={visibleLogs}
				totalCount={payload.logs.length}
				mode={activeLogMode}
				selectedSpan={selectedSpan ? { traceId: selectedSpan.traceId, spanId: selectedSpan.spanId, label: selectedSpan.operationName } : null}
				selectedLogKey={activeSelectedLogKey}
				onModeChange={(mode) => store.setLogMode(mode)}
				onSelectLog={selectLog}
			/>
		{/snippet}

		{#snippet rightPanel()}
			<!-- Detail panel tabs -->
				<div class="flex border-b border-zinc-800">
				{#each (['overview', 'conversation', 'llm', 'tools', 'logs', 'raw'] as const) as tab}
					<button
						class="px-3 py-2 text-[11px] transition-colors border-b-2 {activeDetailTab === tab ? 'border-orange-500 text-zinc-200' : 'border-transparent text-zinc-500 hover:text-zinc-300'}"
						onclick={() => store.setDetailTab(tab)}
					>
						{tab === 'llm' ? 'LLM' : tab.charAt(0).toUpperCase() + tab.slice(1)}
					</button>
				{/each}
			</div>

			<div class="overflow-y-auto h-[calc(100%-36px)]">
				{#if activeDetailTab === 'conversation'}
					<AgentConversationView
						decisions={filteredAgentDecisions}
						llmSpans={allLlmSpans}
					/>
				{:else}
					<SpanEvidencePanel
						span={selectedSpan}
						selectedDecision={activeSelectedDecision}
						{selectedLog}
						logs={relatedLogs}
						llmSpans={relatedLlmSpans}
						toolSpans={relatedToolSpans}
						externalTab={activeDetailTab}
					/>
				{/if}
			</div>
		{/snippet}
	</ObservabilityLayout>
{:else}
	<div class="flex items-center justify-center h-full text-sm text-zinc-500">
		No observability data available.
	</div>
{/if}
