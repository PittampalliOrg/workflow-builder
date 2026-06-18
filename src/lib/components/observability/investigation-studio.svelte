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
	import TraceConsole from '$lib/components/observability/trace-console.svelte';
	import GoalFlowTimeline from '$lib/components/observability/goal-flow-timeline.svelte';
	import CorrelatedLogPane from '$lib/components/observability/correlated-log-pane.svelte';
	import SpanEvidencePanel from '$lib/components/observability/span-evidence-panel.svelte';
	import {
		Bot, RefreshCcw, Search, Zap, FoldVertical, UnfoldVertical,
		ArrowUp, ArrowDown, CircleAlert, GitBranch, X, ExternalLink, ShieldCheck
	} from '@lucide/svelte';

	interface Props {
		payload: ObservabilityInvestigationPayload | null;
		isLoading?: boolean;
		error?: string | null;
		mlflowHref?: string | null;
		legacyTraceHref?: string | null;
		fullTraceHref?: string | null;
		onRefresh?: () => void;
	}

	let {
		payload,
		isLoading = false,
		error = null,
		mlflowHref = null,
		legacyTraceHref = null,
		fullTraceHref = null,
		onRefresh = () => {}
	}: Props = $props();

	// --- Store ---
	const store = createObservabilitySelectionStore();
	setContext('observability-selection', store);

	// Sync payload to store
	$effect(() => { store.setPayload(payload); });

	// --- Local UI state ---
	let mainViewTab = $state<'goal' | 'turns' | 'waterfall'>('turns');
	// Default to the Goal view when this trace's session has a goal flow, unless
	// the user has manually picked a view.
	let viewTouched = $state(false);
	$effect(() => {
		if (!viewTouched && payload?.goalFlow) mainViewTab = 'goal';
	});

	// --- Waterfall controls ---
	let colorMode = $state<'kind' | 'service' | 'duration'>('kind');
	let showCriticalPath = $state(false);
	let collapseSignal = $state(0);
	let expandSignal = $state(0);
	let filterQuery = $state('');
	let errorNavIndex = $state(0);

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
	const legacyExternalTraceHref = $derived(legacyTraceHref);

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

	// --- Waterfall: inline metadata maps (model/tokens, tool name) keyed by span ---
	const llmMeta = $derived.by(() => {
		const map: Record<string, { model: string | null; tokens: number | null }> = {};
		for (const l of allLlmSpans) {
			map[`${l.traceId}:${l.spanId}`] = { model: l.modelName, tokens: l.totalTokens };
		}
		return map;
	});
	const toolMeta = $derived.by(() => {
		const map: Record<string, { name: string }> = {};
		for (const t of allToolSpans) map[`${t.traceId}:${t.spanId}`] = { name: t.toolName };
		return map;
	});

	// --- Find-the-needle: filter-in-place match keys ---
	const matchKeys = $derived.by(() => {
		const q = filterQuery.trim().toLowerCase();
		if (!q) return null;
		const set = new Set<string>();
		for (const s of visibleTraceSpans) {
			const hay = `${s.operationName} ${s.serviceName} ${s.spanId} ${JSON.stringify(s.attributes ?? {})}`.toLowerCase();
			if (hay.includes(q)) set.add(rowKey(s));
		}
		return set;
	});
	const matchCount = $derived(matchKeys ? matchKeys.size : 0);

	// --- Error navigator ---
	const errorSpans = $derived(visibleTraceSpans.filter((s) => s.status === 'error'));
	const selectedSpanKey = $derived(activeSelectedSpanRef ? `${activeSelectedSpanRef.traceId}:${activeSelectedSpanRef.spanId}` : null);

	function jumpError(dir: 1 | -1) {
		if (errorSpans.length === 0) return;
		errorNavIndex = (errorNavIndex + dir + errorSpans.length) % errorSpans.length;
		const target = errorSpans[errorNavIndex];
		store.selectSpan({ traceId: target.traceId, spanId: target.spanId });
	}

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
				<!-- Main view tabs: Goal / Conversation / Waterfall -->
				<div class="flex items-center rounded-lg border border-white/10 bg-white/5 p-0.5">
					{#if payload.goalFlow}
						<button class="rounded px-2.5 py-1 text-[11px] transition-colors {mainViewTab === 'goal' ? 'bg-pink-500/20 text-pink-100' : 'text-zinc-400 hover:text-zinc-200'}"
							onclick={() => { mainViewTab = 'goal'; viewTouched = true; }}>
							<ShieldCheck size={10} class="mr-1 inline" />Goal</button>
					{/if}
					<button class="rounded px-2.5 py-1 text-[11px] transition-colors {mainViewTab === 'turns' ? 'bg-cyan-500/20 text-cyan-100' : 'text-zinc-400 hover:text-zinc-200'}"
						onclick={() => { mainViewTab = 'turns'; viewTouched = true; }}>
						<Bot size={10} class="mr-1 inline" />Conversation</button>
					<button class="rounded px-2.5 py-1 text-[11px] transition-colors {mainViewTab === 'waterfall' ? 'bg-cyan-500/20 text-cyan-100' : 'text-zinc-400 hover:text-zinc-200'}"
						onclick={() => { mainViewTab = 'waterfall'; viewTouched = true; }}>
						<GitBranch size={10} class="mr-1 inline" />Waterfall</button>
				</div>

				<!-- Metric pills -->
				<div class="hidden items-center gap-1.5 text-[10px] md:flex">
					<Badge variant="outline" class="border-cyan-500/20 bg-cyan-500/5 font-mono text-cyan-300">{allLlmSpans.length} LLM</Badge>
					<Badge variant="outline" class="border-emerald-500/20 bg-emerald-500/5 font-mono text-emerald-300">{allToolSpans.length} tools</Badge>
					<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-zinc-400">{allAgentDecisions.length} turns</Badge>
					{#if (payload.summary.errorCount ?? 0) > 0}
						<Badge variant="outline" class="border-red-500/20 bg-red-500/5 font-mono text-red-300">{payload.summary.errorCount} err</Badge>
					{/if}
				</div>

				{#if mainViewTab === 'waterfall'}
					<!-- Filter-in-place -->
					<div class="relative">
						<Search size={12} class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500" />
						<input
							bind:value={filterQuery}
							placeholder="Filter spans"
							class="h-7 w-44 rounded-lg border border-white/10 bg-white/5 pl-7 pr-12 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-cyan-500/40 focus:outline-none"
						/>
						{#if filterQuery}
							<span class="absolute right-6 top-1/2 -translate-y-1/2 font-mono text-[9px] text-zinc-500">{matchCount}</span>
							<button class="absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300" onclick={() => (filterQuery = '')} aria-label="Clear filter"><X size={11} /></button>
						{/if}
					</div>

					<!-- Error navigator -->
					{#if errorSpans.length > 0}
						<div class="flex items-center gap-0.5 rounded-lg border border-red-500/25 bg-red-500/10 px-1.5 py-0.5">
							<CircleAlert size={11} class="text-red-300" />
							<span class="font-mono text-[10px] text-red-200">{errorSpans.length}</span>
							<button class="rounded p-0.5 text-red-300 hover:bg-red-500/20" onclick={() => jumpError(-1)} aria-label="Previous error"><ArrowUp size={11} /></button>
							<button class="rounded p-0.5 text-red-300 hover:bg-red-500/20" onclick={() => jumpError(1)} aria-label="Next error"><ArrowDown size={11} /></button>
						</div>
					{/if}

					<!-- Quick pills -->
					<div class="flex items-center gap-1">
						<button
							class="rounded-md border px-2 py-1 text-[10px] transition-colors {activeSignalFilter === 'errors' ? 'border-red-500/40 bg-red-500/15 text-red-200' : 'border-white/10 bg-white/5 text-zinc-400 hover:text-zinc-200'}"
							onclick={() => store.setSignalFilter(activeSignalFilter === 'errors' ? 'all' : 'errors')}
						>Errors</button>
						<button
							class="rounded-md border px-2 py-1 text-[10px] transition-colors {showCriticalPath ? 'border-amber-500/40 bg-amber-500/15 text-amber-200' : 'border-white/10 bg-white/5 text-zinc-400 hover:text-zinc-200'}"
							onclick={() => (showCriticalPath = !showCriticalPath)}
						><Zap size={9} class="mr-0.5 inline" />Critical</button>
						{#if slowestVisibleSpan}
							<button class="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-200"
								onclick={() => slowestVisibleSpan && selectSpan(slowestVisibleSpan)}>Slowest</button>
						{/if}
					</div>

					<!-- Color mode -->
					<select class="h-7 rounded-lg border border-white/10 bg-white/5 px-1.5 text-[10px] text-zinc-300"
						bind:value={colorMode}>
						<option value="kind">Color: kind</option>
						<option value="service">Color: service</option>
						<option value="duration">Color: duration</option>
					</select>

					<!-- Collapse / expand -->
					<div class="flex items-center rounded-lg border border-white/10 bg-white/5">
						<button class="p-1.5 text-zinc-400 hover:text-zinc-100" onclick={() => collapseSignal++} aria-label="Collapse all" title="Collapse all"><FoldVertical size={12} /></button>
						<button class="p-1.5 text-zinc-400 hover:text-zinc-100" onclick={() => expandSignal++} aria-label="Expand all" title="Expand all"><UnfoldVertical size={12} /></button>
					</div>
				{/if}

				<div class="ml-auto flex items-center gap-2">
					{#if mlflowHref}
						<a href={mlflowHref} target="_blank" rel="noopener noreferrer" class="text-[10px] font-medium text-sky-300 hover:text-sky-200">
							<ExternalLink size={10} class="mr-0.5 inline" /> MLflow
						</a>
					{/if}
					{#if legacyExternalTraceHref}
						<a href={legacyExternalTraceHref} target="_blank" rel="noopener noreferrer" class="text-[10px] text-zinc-500 hover:text-zinc-300">
							<ExternalLink size={10} class="mr-0.5 inline" /> Phoenix
						</a>
					{/if}
					<button class="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/10"
						onclick={() => onRefresh()}>
						<RefreshCcw size={12} /> Refresh
					</button>
				</div>
			</div>
		{/snippet}

		{#snippet mainContent()}
			{#if mainViewTab === 'goal' && payload.goalFlow}
				<GoalFlowTimeline
					goalFlow={payload.goalFlow}
					agentDecisions={filteredAgentDecisions}
					onSelectAttempt={(a) => {
						const first = a.relatedSpanIds[0];
						if (first) {
							const span = allTraceSpans.find((s) => s.spanId === first);
							if (span) selectSpan(span);
						}
					}}
				/>
			{:else if mainViewTab === 'turns'}
				<TurnNavigator decisions={filteredAgentDecisions} />
			{:else}
				<TraceConsole
					spans={visibleTraceSpans}
					selectedKey={selectedSpanKey}
					{matchKeys}
					relatedKeys={activeRelatedSpanKeys}
					{llmMeta}
					{toolMeta}
					{logCounts}
					{colorMode}
					{showCriticalPath}
					{globalStartMs}
					{globalDurationMs}
					{collapseSignal}
					{expandSignal}
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
						class="px-3 py-2 text-[11px] transition-colors border-b-2 {activeDetailTab === tab ? 'border-cyan-400 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'}"
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
