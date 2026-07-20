<script lang="ts">
	import { Tabs, TabsList, TabsTrigger, TabsContent } from '$lib/components/ui/tabs';
	import { Activity, Sparkles, Wrench, Globe, FileText, AlertTriangle, Loader2, ListTree } from '@lucide/svelte';
	import type { ObservabilityInvestigationPayload } from '$lib/types/observability';
	import type { NodeInsight, RedMetrics } from '$lib/types/service-graph';
	import { categorizeSpan } from '$lib/utils/span-presentation';
	import DrilldownSummary from './drilldown-summary.svelte';
	import DrilldownWaterfall from './drilldown-waterfall.svelte';
	import DrilldownLlm from './drilldown-llm.svelte';
	import DrilldownTools from './drilldown-tools.svelte';
	import DrilldownRequests from './drilldown-requests.svelte';
	import DrilldownLogs from './drilldown-logs.svelte';
	import DrilldownWorkflowTimeline from './drilldown-workflow-timeline.svelte';

	let {
		payload,
		insight = null,
		red = null,
		isLoading = false,
		error = null
	}: {
		payload: ObservabilityInvestigationPayload | null;
		insight?: NodeInsight | null;
		red?: RedMetrics | null;
		isLoading?: boolean;
		error?: string | null;
	} = $props();

	let spans = $derived(payload?.traceSpans ?? []);
	// Tabs are driven by span CATEGORY (the trace spans carry the real content via
	// input.value/output.value); obs.llm_spans/tool_spans are fallbacks only.
	let llmSpansCat = $derived(spans.filter((s) => categorizeSpan(s) === 'llm'));
	let toolSpansCat = $derived(spans.filter((s) => categorizeSpan(s) === 'tool'));
	let requestCount = $derived(
		spans.filter((s) => {
			const c = categorizeSpan(s);
			return c === 'http' || c === 'rpc';
		}).length
	);
	let llmCount = $derived(llmSpansCat.length);
	let toolCount = $derived(toolSpansCat.length);
	let logCount = $derived(payload?.logs?.length ?? 0);
	let workflowTimelineCount = $derived(payload?.workflowTimeline?.length ?? 0);
	let traceWarnings = $derived(
		(payload?.issues ?? []).filter((issue) => issue.id.startsWith('issue-trace-backend-'))
	);

	type TabId = 'workflow' | 'timeline' | 'llm' | 'tools' | 'requests' | 'logs';
	let tabs = $derived.by(() => {
		const t: { id: TabId; label: string; icon: typeof Activity; count: number }[] = [];
		if (workflowTimelineCount) t.push({ id: 'workflow', label: 'Workflow', icon: ListTree, count: workflowTimelineCount });
		t.push({ id: 'timeline', label: 'Timeline', icon: Activity, count: spans.length });
		if (llmCount) t.push({ id: 'llm', label: 'LLM', icon: Sparkles, count: llmCount });
		if (toolCount) t.push({ id: 'tools', label: 'Tools', icon: Wrench, count: toolCount });
		if (requestCount) t.push({ id: 'requests', label: 'Requests', icon: Globe, count: requestCount });
		if (logCount) t.push({ id: 'logs', label: 'Logs', icon: FileText, count: logCount });
		return t;
	});

	let activeTab = $state<TabId>('workflow');
	// Reset to a valid tab when the payload (and thus available tabs) changes.
	$effect(() => {
		if (!tabs.some((t) => t.id === activeTab)) activeTab = 'timeline';
	});
</script>

{#if !error && traceWarnings.length > 0}
	<div class="flex items-start gap-2 border-b border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-200" role="status">
		<AlertTriangle size={14} class="mt-0.5 shrink-0" />
		<div class="min-w-0 space-y-0.5">
			{#each traceWarnings as warning (warning.id)}
				<p class="break-words">{warning.label}</p>
			{/each}
		</div>
	</div>
{/if}

{#if error}
	<div class="m-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
		<AlertTriangle size={14} class="mt-0.5 shrink-0" />
		<span>{error}</span>
	</div>
{:else if isLoading && !payload}
	<div class="space-y-2 p-3">
		<div class="grid grid-cols-4 gap-2">
			{#each Array(4) as _, i (i)}
				<div class="h-12 animate-pulse rounded-md border bg-muted/50"></div>
			{/each}
		</div>
		<div class="h-6 animate-pulse rounded-md border bg-muted/50"></div>
		<div class="flex items-center justify-center gap-2 pt-6 text-xs text-muted-foreground">
			<Loader2 size={14} class="animate-spin" /> Loading execution detail…
		</div>
	</div>
{:else if !payload || spans.length === 0}
	<div class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
		<Activity size={20} class="opacity-50" />
		<p>No telemetry captured for this selection.</p>
	</div>
{:else}
	<div class="flex h-full min-h-0 flex-col">
		<DrilldownSummary
			summary={payload.summary}
			{insight}
			{red}
			{spans}
			onSeeTimeline={() => (activeTab = 'timeline')}
		/>
		<div class="min-h-0 flex-1 px-3 pb-3 pt-2.5">
			<Tabs bind:value={activeTab} class="flex h-full flex-col">
				<TabsList class="h-8 w-full justify-start gap-0.5 overflow-x-auto">
					{#each tabs as tab (tab.id)}
						{@const Icon = tab.icon}
						<TabsTrigger value={tab.id} class="gap-1 px-2 text-xs">
							<Icon size={12} />
							{tab.label}
							<span class="text-[10px] text-muted-foreground">{tab.count}</span>
						</TabsTrigger>
					{/each}
				</TabsList>
				<div class="min-h-0 flex-1 overflow-hidden">
					{#if workflowTimelineCount}
						<TabsContent value="workflow" class="h-full data-[state=inactive]:hidden">
							<DrilldownWorkflowTimeline items={payload.workflowTimeline} {spans} />
						</TabsContent>
					{/if}
					<TabsContent value="timeline" class="h-full data-[state=inactive]:hidden">
						<DrilldownWaterfall {spans} />
					</TabsContent>
					{#if llmCount}
						<TabsContent value="llm" class="h-full overflow-auto data-[state=inactive]:hidden">
							<DrilldownLlm spans={llmSpansCat} fallback={payload.llmSpans} />
						</TabsContent>
					{/if}
					{#if toolCount}
						<TabsContent value="tools" class="h-full overflow-auto data-[state=inactive]:hidden">
							<DrilldownTools spans={toolSpansCat} fallback={payload.toolSpans} />
						</TabsContent>
					{/if}
					{#if requestCount}
						<TabsContent value="requests" class="h-full overflow-auto data-[state=inactive]:hidden">
							<DrilldownRequests {spans} />
						</TabsContent>
					{/if}
					{#if logCount}
						<TabsContent value="logs" class="h-full overflow-auto data-[state=inactive]:hidden">
							<DrilldownLogs logs={payload.logs} />
						</TabsContent>
					{/if}
				</div>
			</Tabs>
		</div>
	</div>
{/if}
