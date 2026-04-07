<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import type {
		ObservabilityAgentDecisionDiagramEdge,
		ObservabilityAgentDecisionDiagramNode,
		ObservabilityAgentDecisionTurn,
		ObservabilityInvestigationPayload,
		ObservabilityLogEntry,
		ObservabilityTraceSpan
	} from '$lib/types/observability';
	import AgentDecisionTimeline from '$lib/components/observability/agent-decision-timeline.svelte';
	import AgentStateDiagram from '$lib/components/observability/agent-state-diagram.svelte';
	import MetricsStrip from '$lib/components/observability/metrics-strip.svelte';
	import TraceConsole from '$lib/components/observability/trace-console.svelte';
	import CorrelatedLogPane from '$lib/components/observability/correlated-log-pane.svelte';
	import SpanEvidencePanel from '$lib/components/observability/span-evidence-panel.svelte';
	import { AlertTriangle, Bot, ChevronDown, ChevronRight, ExternalLink, RefreshCcw, Wrench } from 'lucide-svelte';

	type SignalFilter = 'all' | 'errors' | 'llm' | 'tools';
	type LogPaneMode = 'session' | 'span';

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

	let signalFilter = $state<SignalFilter>('all');
	let serviceFilter = $state('all');
	let traceFilter = $state('all');
	let logMode = $state<LogPaneMode>('session');
	let selectedSpanRef = $state<{ traceId: string; spanId: string } | null>(null);
	let selectedLogKey = $state<string | null>(null);
	let selectedDecisionId = $state<string | null>(null);
	let selectedDiagramNodeId = $state<string | null>(null);
	let selectedDiagramEdgeId = $state<string | null>(null);
	let collapsedTraceIds = $state<Set<string>>(new Set());
	let showSummary = $state(false);
	let collapsedPanels = $state({
		decisions: false,
		traceConsole: false,
		logs: false
	});

	function formatDuration(value: number): string {
		if (!Number.isFinite(value) || value <= 0) return '0ms';
		if (value < 1000) return `${Math.round(value)}ms`;
		return `${(value / 1000).toFixed(2)}s`;
	}

	function formatTimeWindow(start: string | null, end: string | null): string | null {
		if (!start) return null;
		const startLabel = new Date(start).toLocaleTimeString(undefined, {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
		if (!end) return startLabel;
		const endLabel = new Date(end).toLocaleTimeString(undefined, {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
		return `${startLabel} -> ${endLabel}`;
	}

	function rowKey(span: Pick<ObservabilityTraceSpan, 'traceId' | 'spanId'>): string {
		return `${span.traceId}:${span.spanId}`;
	}

	function logKey(log: ObservabilityLogEntry, index: number): string {
		return `${log.timestamp}:${log.traceId}:${log.spanId}:${index}`;
	}

	function isErrorLog(log: ObservabilityLogEntry): boolean {
		const severity = log.severityText.toLowerCase();
		return severity.includes('error') || severity.includes('fatal') || severity.includes('warn');
	}

	function recordContains(record: Record<string, unknown>, terms: string[]): boolean {
		return Object.entries(record).some(([key, value]) => {
			const normalized = `${key} ${typeof value === 'string' ? value : JSON.stringify(value)}`.toLowerCase();
			return terms.some((term) => normalized.includes(term));
		});
	}

	function isLlmRelatedLog(log: ObservabilityLogEntry): boolean {
		const terms = ['llm', 'gen_ai', 'openai', 'anthropic', 'model', 'callllm', 'openinference'];
		if (terms.some((term) => `${log.serviceName} ${log.body}`.toLowerCase().includes(term))) return true;
		return recordContains(log.logAttributes ?? {}, terms) || recordContains(log.resourceAttributes ?? {}, terms);
	}

	function isToolRelatedLog(log: ObservabilityLogEntry): boolean {
		const terms = ['tool', 'execute_command', 'run_shell_command', 'tool_call', 'tool result'];
		if (terms.some((term) => `${log.serviceName} ${log.body}`.toLowerCase().includes(term))) return true;
		return recordContains(log.logAttributes ?? {}, terms) || recordContains(log.resourceAttributes ?? {}, terms);
	}

	const allTraceSpans = $derived(payload?.traceSpans ?? []);
	const allLogs = $derived(payload?.logs ?? []);
	const allLlmSpans = $derived(payload?.llmSpans ?? []);
	const allToolSpans = $derived(payload?.toolSpans ?? []);
	const allAgentDecisions = $derived(payload?.agentDecisions ?? []);

	const llmCounts = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const span of allLlmSpans) {
			const key = rowKey(span);
			counts[key] = (counts[key] ?? 0) + 1;
		}
		return counts;
	});

	const toolCounts = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const span of allToolSpans) {
			const key = rowKey(span);
			counts[key] = (counts[key] ?? 0) + 1;
		}
		return counts;
	});

	const logCounts = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const log of allLogs) {
			if (!log.traceId || !log.spanId) continue;
			const key = `${log.traceId}:${log.spanId}`;
			counts[key] = (counts[key] ?? 0) + 1;
		}
		return counts;
	});

	function spanMatches(span: ObservabilityTraceSpan): boolean {
		if (traceFilter !== 'all' && span.traceId !== traceFilter) return false;
		if (serviceFilter !== 'all' && span.serviceName !== serviceFilter) return false;
		if (signalFilter === 'errors') return span.status === 'error';
		if (signalFilter === 'llm') return (llmCounts[rowKey(span)] ?? 0) > 0;
		if (signalFilter === 'tools') return (toolCounts[rowKey(span)] ?? 0) > 0;
		return true;
	}

	const visibleTraceSpans = $derived(
		allTraceSpans.filter((span) => spanMatches(span))
	);

	const visibleTraceIds = $derived(
		[...new Set(visibleTraceSpans.map((span) => span.traceId))]
	);

	const traceGroups = $derived.by(() => {
		const groups = new Map<
			string,
			{
				traceId: string;
				label: string;
				serviceName: string;
				startTime: string;
				durationMs: number;
				spanCount: number;
				errorCount: number;
				spans: ObservabilityTraceSpan[];
			}
		>();

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
				groups.set(span.traceId, {
					traceId: span.traceId,
					label: span.operationName,
					serviceName: span.serviceName,
					startTime: span.startTime,
					durationMs: span.duration,
					spanCount: 1,
					errorCount: span.status === 'error' ? 1 : 0,
					spans: [span]
				});
			}
		}

		return [...groups.values()]
			.map((group) => ({
				...group,
				spans: [...group.spans].sort((a, b) => {
					const time = new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
					if (time !== 0) return time;
					if (a.depth !== b.depth) return a.depth - b.depth;
					return a.operationName.localeCompare(b.operationName);
				})
			}))
			.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
	});

	const globalStartMs = $derived(
		traceGroups.length > 0
			? Math.min(...traceGroups.map((group) => new Date(group.startTime).getTime()))
			: 0
	);

	const globalDurationMs = $derived(
		traceGroups.length > 0
			? Math.max(
					...traceGroups.map((group) => new Date(group.startTime).getTime() + group.durationMs)
				) - globalStartMs
			: 1
	);

	const selectedSpan = $derived.by(() => {
		if (!selectedSpanRef) return null;
		return allTraceSpans.find(
			(span) => span.traceId === selectedSpanRef?.traceId && span.spanId === selectedSpanRef?.spanId
		) ?? null;
	});

	const filteredAgentDecisions = $derived.by(() => {
		let next = allAgentDecisions;
		if (traceFilter !== 'all') next = next.filter((decision) => decision.traceId === traceFilter);
		if (serviceFilter !== 'all') next = next.filter((decision) => decision.serviceName === serviceFilter);
		if (signalFilter === 'errors') next = next.filter((decision) => decision.decisionType === 'error');
		if (signalFilter === 'tools') next = next.filter((decision) => decision.decisionType === 'tool_call');
		if (selectedDiagramEdgeId && payload?.agentDecisionDiagram) {
			const edge = payload.agentDecisionDiagram.edges.find((candidate) => candidate.id === selectedDiagramEdgeId);
			if (edge) next = next.filter((decision) => edge.turnIds.includes(decision.id));
		} else if (
			selectedDiagramNodeId &&
			['tool_call', 'assistant_message', 'wait_or_approval', 'stop', 'error'].includes(selectedDiagramNodeId)
		) {
			next = next.filter((decision) => decision.decisionType === selectedDiagramNodeId);
		}
		return next;
	});

	const selectedDecision = $derived.by(() => {
		if (!selectedDecisionId) return null;
		return allAgentDecisions.find((decision) => decision.id === selectedDecisionId) ?? null;
	});

	$effect(() => {
		if (visibleTraceSpans.length === 0) {
			selectedSpanRef = null;
			return;
		}
		const selectedVisible = selectedSpanRef
			? visibleTraceSpans.some(
					(span) =>
						span.traceId === selectedSpanRef?.traceId && span.spanId === selectedSpanRef?.spanId
					)
			: false;
		if (!selectedVisible) {
			const next = visibleTraceSpans[0];
			selectedSpanRef = { traceId: next.traceId, spanId: next.spanId };
			selectedLogKey = null;
		}
	});

	$effect(() => {
		if (filteredAgentDecisions.length === 0) {
			selectedDecisionId = null;
			return;
		}
		if (!selectedDecisionId || !filteredAgentDecisions.some((decision) => decision.id === selectedDecisionId)) {
			selectedDecisionId = filteredAgentDecisions[0].id;
		}
	});

	$effect(() => {
		if (!selectedDecision) return;
		if (
			selectedSpanRef?.traceId !== selectedDecision.traceId ||
			selectedSpanRef?.spanId !== selectedDecision.spanId
		) {
			selectedSpanRef = { traceId: selectedDecision.traceId, spanId: selectedDecision.spanId };
		}
	});

	const serviceOptions = $derived(
		[...new Set(allTraceSpans.map((span) => span.serviceName).filter(Boolean))].sort()
	);

	const traceOptions = $derived(
		[...new Set(allTraceSpans.map((span) => span.traceId).filter(Boolean))]
	);

	const visibleLogs = $derived.by(() => {
		let next = allLogs;
		if (traceFilter !== 'all') next = next.filter((log) => log.traceId === traceFilter);
		if (serviceFilter !== 'all') next = next.filter((log) => log.serviceName === serviceFilter);
		if (signalFilter === 'errors') next = next.filter(isErrorLog);
		if (signalFilter === 'llm') next = next.filter(isLlmRelatedLog);
		if (signalFilter === 'tools') next = next.filter(isToolRelatedLog);
		if (logMode === 'span' && selectedSpanRef) {
			next = next.filter(
				(log) => log.traceId === selectedSpanRef?.traceId && log.spanId === selectedSpanRef?.spanId
			);
		}
		return next;
	});

	const selectedLog = $derived.by(() => {
		if (!selectedLogKey) return null;
		const logs = visibleLogs;
		for (const [index, log] of logs.entries()) {
			if (logKey(log, index) === selectedLogKey) return log;
		}
		return null;
	});

	const relatedLogs = $derived.by(() => {
		if (!selectedSpanRef) return [];
		return allLogs.filter(
			(log) => log.traceId === selectedSpanRef?.traceId && log.spanId === selectedSpanRef?.spanId
		);
	});

	const relatedLlmSpans = $derived.by(() => {
		if (!selectedSpanRef) return [];
		return allLlmSpans.filter(
			(span) => span.traceId === selectedSpanRef?.traceId && span.spanId === selectedSpanRef?.spanId
		);
	});

	const relatedToolSpans = $derived.by(() => {
		if (!selectedSpanRef) return [];
		return allToolSpans.filter(
			(span) => span.traceId === selectedSpanRef?.traceId && span.spanId === selectedSpanRef?.spanId
		);
	});

	const topServices = $derived.by(() => {
		const stats = new Map<string, { name: string; durationMs: number; errors: number }>();
		for (const span of visibleTraceSpans) {
			const existing = stats.get(span.serviceName) ?? {
				name: span.serviceName,
				durationMs: 0,
				errors: 0
			};
			existing.durationMs += span.duration;
			if (span.status === 'error') existing.errors += 1;
			stats.set(span.serviceName, existing);
		}
		return [...stats.values()].sort((a, b) => b.durationMs - a.durationMs).slice(0, 3);
	});

	const slowestVisibleSpan = $derived.by(() => {
		return [...visibleTraceSpans].sort((a, b) => b.duration - a.duration)[0] ?? null;
	});

	const metricItems = $derived.by(() => [
		{
			label: 'status',
			value: payload?.summary.status ?? 'unknown',
			meta: payload?.summary.scope === 'session' ? 'workflow session' : 'trace scope'
		},
		{
			label: 'duration',
			value: formatDuration(payload?.summary.totalDurationMs ?? 0),
			meta: `${visibleTraceIds.length} visible traces`
		},
		{
			label: 'spans',
			value: `${visibleTraceSpans.length}/${payload?.summary.spanCount ?? 0}`,
			meta: `${payload?.summary.serviceCount ?? 0} services`
		},
		{
			label: 'logs',
			value: `${visibleLogs.length}/${payload?.summary.logCount ?? 0}`,
			meta: logMode === 'span' && selectedSpan ? `scoped to ${selectedSpan.operationName}` : 'session scope',
			tone: 'log' as const
		},
		{
			label: 'llm',
			value: `${allLlmSpans.length}`,
			meta: `${payload?.summary.totalTokens ?? 0} tokens`,
			tone: 'llm' as const
		},
		{
			label: 'tools',
			value: `${allToolSpans.length}`,
			meta: `${payload?.summary.workflowStepCount ?? 0} workflow steps`,
			tone: 'tool' as const
		},
		{
			label: 'turns',
			value: `${allAgentDecisions.length}`,
			meta: payload?.agentDecisionSummary?.stopReason ?? 'decision model',
			tone: 'llm' as const
		},
		{
			label: 'errors',
			value: `${payload?.summary.errorCount ?? 0}`,
			meta: payload?.summary.firstFailureEventId ? 'notable failures present' : 'no failures',
			tone: (payload?.summary.errorCount ?? 0) > 0 ? ('error' as const) : ('default' as const)
		},
		{
			label: 'selected',
			value: selectedSpan ? formatDuration(selectedSpan.duration) : 'n/a',
			meta: selectedSpan ? selectedSpan.serviceName : 'pick a span'
		}
	]);

	function selectSpan(span: ObservabilityTraceSpan) {
		selectedSpanRef = { traceId: span.traceId, spanId: span.spanId };
		selectedLogKey = null;
		const matchingDecision = filteredAgentDecisions.find(
			(decision) => decision.traceId === span.traceId && decision.spanId === span.spanId
		);
		if (matchingDecision) selectedDecisionId = matchingDecision.id;
	}

	function selectDecision(decision: ObservabilityAgentDecisionTurn) {
		selectedDecisionId = decision.id;
		selectedSpanRef = { traceId: decision.traceId, spanId: decision.spanId };
		selectedLogKey = null;
	}

	function toggleTrace(traceId: string) {
		const next = new Set(collapsedTraceIds);
		if (next.has(traceId)) next.delete(traceId);
		else next.add(traceId);
		collapsedTraceIds = next;
	}

	function selectLog(log: ObservabilityLogEntry, key: string) {
		selectedLogKey = key;
		if (log.traceId && log.spanId) {
			selectedSpanRef = { traceId: log.traceId, spanId: log.spanId };
		}
	}

	function selectDiagramNode(node: ObservabilityAgentDecisionDiagramNode) {
		selectedDiagramEdgeId = null;
		selectedDiagramNodeId = selectedDiagramNodeId === node.id ? null : node.id;
	}

	function selectDiagramEdge(edge: ObservabilityAgentDecisionDiagramEdge) {
		selectedDiagramNodeId = null;
		selectedDiagramEdgeId = selectedDiagramEdgeId === edge.id ? null : edge.id;
	}

	function togglePanel(name: keyof typeof collapsedPanels) {
		collapsedPanels = { ...collapsedPanels, [name]: !collapsedPanels[name] };
	}

	function clearFilters() {
		signalFilter = 'all';
		serviceFilter = 'all';
		traceFilter = 'all';
		logMode = 'session';
		selectedDiagramNodeId = null;
		selectedDiagramEdgeId = null;
	}
</script>

{#if isLoading}
	<div class="rounded-[26px] border border-white/10 bg-black/40 p-10 text-center text-sm text-zinc-500">
		Loading trace console…
	</div>
{:else if error}
	<div class="rounded-[26px] border border-red-500/20 bg-red-500/10 p-6 text-sm text-red-100">
		{error}
	</div>
{:else if payload}
	<div class="space-y-4">
		{#if showSummary}
			<MetricsStrip
				title={payload.summary.scope === 'session' ? 'Workflow Trace Console' : 'Trace Console'}
				subtitle="Waterfall-first investigation with click-through evidence."
				metrics={metricItems}
				topServices={topServices}
				slowestSpanLabel={slowestVisibleSpan?.operationName ?? null}
				slowestSpanDuration={slowestVisibleSpan ? formatDuration(slowestVisibleSpan.duration) : null}
				timeWindowLabel={formatTimeWindow(payload.summary.startedAt, payload.summary.completedAt)}
			/>
		{/if}

		<section class="rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(14,14,18,0.98),rgba(8,8,11,0.98))] px-4 py-3 shadow-[0_14px_34px_rgba(0,0,0,0.2)]">
			<div class="flex flex-wrap items-center gap-3">
				<div class="flex items-center rounded-xl border border-white/10 bg-white/5 p-1">
					<button
						class={`rounded-lg px-3 py-1.5 text-xs transition-colors ${signalFilter === 'all' ? 'bg-white/10 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'}`}
						onclick={() => (signalFilter = 'all')}
					>
						All
					</button>
					<button
						class={`rounded-lg px-3 py-1.5 text-xs transition-colors ${signalFilter === 'errors' ? 'bg-red-500/15 text-red-100' : 'text-zinc-400 hover:text-zinc-200'}`}
						onclick={() => (signalFilter = 'errors')}
					>
						<AlertTriangle size={12} class="mr-1 inline" />
						Errors
					</button>
					<button
						class={`rounded-lg px-3 py-1.5 text-xs transition-colors ${signalFilter === 'llm' ? 'bg-cyan-500/15 text-cyan-100' : 'text-zinc-400 hover:text-zinc-200'}`}
						onclick={() => (signalFilter = 'llm')}
					>
						<Bot size={12} class="mr-1 inline" />
						LLM
					</button>
					<button
						class={`rounded-lg px-3 py-1.5 text-xs transition-colors ${signalFilter === 'tools' ? 'bg-emerald-500/15 text-emerald-100' : 'text-zinc-400 hover:text-zinc-200'}`}
						onclick={() => (signalFilter = 'tools')}
					>
						<Wrench size={12} class="mr-1 inline" />
						Tools
					</button>
				</div>

				<select class="h-9 rounded-xl border border-white/10 bg-black/30 px-3 text-xs text-zinc-200" bind:value={traceFilter}>
					<option value="all">All traces</option>
					{#each traceOptions as traceId}
						<option value={traceId}>{traceId.slice(0, 14)}</option>
					{/each}
				</select>

				<select class="h-9 rounded-xl border border-white/10 bg-black/30 px-3 text-xs text-zinc-200" bind:value={serviceFilter}>
					<option value="all">All services</option>
					{#each serviceOptions as service}
						<option value={service}>{service}</option>
					{/each}
				</select>

				<div class="ml-auto flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
					<button
						class="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] text-zinc-300 transition-colors hover:bg-white/10"
						onclick={() => (showSummary = !showSummary)}
					>
						{showSummary ? 'Hide summary' : 'Show summary'}
					</button>
					<button
						class="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] text-zinc-300 transition-colors hover:bg-white/10"
						onclick={clearFilters}
					>
						Clear filters
					</button>
					<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-[10px] text-zinc-300">
						{visibleTraceSpans.length} spans
					</Badge>
					<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-[10px] text-zinc-300">
						{visibleLogs.length} logs
					</Badge>
					<button
						class="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 transition-colors hover:bg-white/10"
						onclick={() => onRefresh()}
					>
						<RefreshCcw size={14} />
						Refresh
					</button>
					{#if fullTraceHref}
						<a
							href={fullTraceHref}
							class="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 transition-colors hover:bg-white/10"
						>
							<ExternalLink size={14} />
							Trace page
						</a>
					{/if}
					{#if phoenixHref}
						<a
							href={phoenixHref}
							target="_blank"
							rel="noopener noreferrer"
							class="inline-flex items-center gap-2 rounded-xl border border-orange-400/20 bg-orange-400/10 px-3 py-2 text-xs text-orange-100 transition-colors hover:bg-orange-400/15"
						>
							<ExternalLink size={14} />
							Phoenix
						</a>
					{/if}
				</div>
			</div>
		</section>

		<div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1.2fr)_420px]">
			<div class="min-w-0 space-y-4">
				<section class="rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(14,14,18,0.98),rgba(8,8,11,0.98))] shadow-[0_14px_34px_rgba(0,0,0,0.2)]">
					<button class="flex w-full items-center justify-between px-4 py-3 text-left" onclick={() => togglePanel('decisions')}>
						<div>
							<p class="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Agent decisions</p>
							<p class="mt-1 text-sm text-zinc-300">Decision timeline and observed loop states derived from the durable-agent turns.</p>
						</div>
						{#if collapsedPanels.decisions}
							<ChevronRight size={16} class="text-zinc-400" />
						{:else}
							<ChevronDown size={16} class="text-zinc-400" />
						{/if}
					</button>
					{#if !collapsedPanels.decisions}
						<div class="border-t border-white/10 p-4">
							{#if payload?.agentDecisionSummary && filteredAgentDecisions.length > 0}
								<div class="mb-4 flex flex-wrap gap-2">
									<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-[10px] text-zinc-300">
										{payload.agentDecisionSummary.totalTurns} turns
									</Badge>
									<Badge variant="outline" class="border-emerald-500/20 bg-emerald-500/10 font-mono text-[10px] text-emerald-100">
										{payload.agentDecisionSummary.totalToolCalls} tool calls
									</Badge>
									<Badge variant="outline" class="border-cyan-500/20 bg-cyan-500/10 font-mono text-[10px] text-cyan-100">
										{payload.agentDecisionSummary.totalTokens} tokens
									</Badge>
									<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-[10px] text-zinc-300">
										avg {formatDuration(payload.agentDecisionSummary.averageTurnLatencyMs)}
									</Badge>
									{#if payload.agentDecisionSummary.stopReason}
										<Badge variant="outline" class="border-white/10 bg-white/5 text-[10px] text-zinc-300">
											stop: {payload.agentDecisionSummary.stopReason}
										</Badge>
									{/if}
								</div>
								<div class="space-y-4">
									<div class="space-y-3">
										<p class="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Decision timeline</p>
										<AgentDecisionTimeline
											decisions={filteredAgentDecisions}
											{selectedDecisionId}
											onSelectDecision={selectDecision}
										/>
									</div>
									<div class="space-y-3">
										<p class="text-[11px] uppercase tracking-[0.22em] text-zinc-500">State diagram</p>
										<AgentStateDiagram
											diagram={payload.agentDecisionDiagram}
											selectedNodeId={selectedDiagramNodeId}
											selectedEdgeId={selectedDiagramEdgeId}
											onSelectNode={selectDiagramNode}
											onSelectEdge={selectDiagramEdge}
										/>
									</div>
								</div>
							{:else}
								<div class="rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-10 text-center text-sm text-zinc-500">
									No durable-agent decisions were inferred for this execution.
								</div>
							{/if}
						</div>
					{/if}
				</section>

				<section class="rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(14,14,18,0.98),rgba(8,8,11,0.98))] shadow-[0_14px_34px_rgba(0,0,0,0.2)]">
					<button class="flex w-full items-center justify-between px-4 py-3 text-left" onclick={() => togglePanel('traceConsole')}>
						<div>
							<p class="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Trace console</p>
							<p class="mt-1 text-sm text-zinc-300">Waterfall-first investigation. Click any span to load full detail on the right.</p>
						</div>
						{#if collapsedPanels.traceConsole}
							<ChevronRight size={16} class="text-zinc-400" />
						{:else}
							<ChevronDown size={16} class="text-zinc-400" />
						{/if}
					</button>
					{#if !collapsedPanels.traceConsole}
						<div class="border-t border-white/10 p-4">
							<TraceConsole
								groups={traceGroups}
								selectedSpan={selectedSpanRef}
								llmCounts={llmCounts}
								toolCounts={toolCounts}
								logCounts={logCounts}
								{globalStartMs}
								{globalDurationMs}
								{collapsedTraceIds}
								onToggleTrace={toggleTrace}
								onSelectSpan={selectSpan}
							/>
						</div>
					{/if}
				</section>

				<section class="rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(14,14,18,0.98),rgba(8,8,11,0.98))] shadow-[0_14px_34px_rgba(0,0,0,0.2)]">
					<button class="flex w-full items-center justify-between px-4 py-3 text-left" onclick={() => togglePanel('logs')}>
						<div>
							<p class="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Log analytics</p>
							<p class="mt-1 text-sm text-zinc-300">Compact OTEL log report linked back to the selected trace span.</p>
						</div>
						{#if collapsedPanels.logs}
							<ChevronRight size={16} class="text-zinc-400" />
						{:else}
							<ChevronDown size={16} class="text-zinc-400" />
						{/if}
					</button>
					{#if !collapsedPanels.logs}
						<div class="border-t border-white/10 p-4">
							<CorrelatedLogPane
								logs={visibleLogs}
								totalCount={payload.logs.length}
								mode={logMode}
								selectedSpan={selectedSpan ? { traceId: selectedSpan.traceId, spanId: selectedSpan.spanId, label: selectedSpan.operationName } : null}
								{selectedLogKey}
								onModeChange={(mode) => (logMode = mode)}
								onSelectLog={selectLog}
							/>
						</div>
					{/if}
				</section>
			</div>

			<div class="min-w-0 xl:sticky xl:top-4 xl:self-start">
				<SpanEvidencePanel
					span={selectedSpan}
					selectedDecision={selectedDecision}
					{selectedLog}
					logs={relatedLogs}
					llmSpans={relatedLlmSpans}
					toolSpans={relatedToolSpans}
				/>
			</div>
		</div>
	</div>
{:else}
	<div class="rounded-[26px] border border-dashed border-white/10 bg-black/20 p-10 text-center text-sm text-zinc-500">
		No observability data available.
	</div>
{/if}
