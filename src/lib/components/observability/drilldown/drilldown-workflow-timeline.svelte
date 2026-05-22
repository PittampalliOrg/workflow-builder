<script lang="ts">
	import { Activity, AlertTriangle, Boxes, CheckCircle2, ChevronDown, ChevronRight, GitBranch, Settings2 } from '@lucide/svelte';
	import type {
		ObservabilityTraceSpan,
		ObservabilityWorkflowTimelineItem
	} from '$lib/types/observability';
	import { fmtMs } from '$lib/utils/span-presentation';
	import DrilldownIo from './drilldown-io.svelte';

	let {
		items = [],
		spans = []
	}: {
		items?: ObservabilityWorkflowTimelineItem[];
		spans?: ObservabilityTraceSpan[];
	} = $props();

	let expandedId = $state<string | null>(null);
	let spanById = $derived(new Map(spans.map((span) => [span.spanId, span])));

	function iconFor(item: ObservabilityWorkflowTimelineItem) {
		if (item.kind === 'child_workflow') return GitBranch;
		if (item.kind === 'system') return Settings2;
		if (item.kind === 'dapr_activity') return Boxes;
		if (item.status === 'error') return AlertTriangle;
		return Activity;
	}

	function statusTone(status: ObservabilityWorkflowTimelineItem['status']): string {
		if (status === 'error') return 'text-destructive border-destructive/30 bg-destructive/10';
		if (status === 'success') return 'text-emerald-700 border-emerald-500/30 bg-emerald-500/10 dark:text-emerald-300';
		if (status === 'running') return 'text-blue-700 border-blue-500/30 bg-blue-500/10 dark:text-blue-300';
		if (status === 'pending') return 'text-amber-700 border-amber-500/30 bg-amber-500/10 dark:text-amber-300';
		return 'text-muted-foreground border-border bg-muted/40';
	}

	function kindLabel(kind: ObservabilityWorkflowTimelineItem['kind']): string {
		if (kind === 'workflow_node') return 'Workflow node';
		if (kind === 'dapr_activity') return 'Dapr activity';
		if (kind === 'child_workflow') return 'Child workflow';
		return 'System';
	}

	function primaryInput(item: ObservabilityWorkflowTimelineItem): unknown {
		return item.inputSpanId ? spanById.get(item.inputSpanId)?.attributes?.['input.value'] : undefined;
	}

	function primaryOutput(item: ObservabilityWorkflowTimelineItem): unknown {
		return item.outputSpanId ? spanById.get(item.outputSpanId)?.attributes?.['output.value'] : undefined;
	}

	function shortId(value: string | null): string {
		return value ? `${value.slice(0, 12)}...` : '';
	}

	function sequenceLabel(item: ObservabilityWorkflowTimelineItem, index: number): string {
		if (item.kind === 'workflow_node') return String(index + 1).padStart(2, '0');
		if (item.durableTaskId) return `D${item.durableTaskId}`;
		return String(index + 1).padStart(2, '0');
	}
</script>

{#if items.length === 0}
	<div class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
		<Activity size={20} class="opacity-50" />
		<p>No workflow activity sequence was derived for this selection.</p>
	</div>
{:else}
	<div class="h-full overflow-auto pr-1">
		<div class="space-y-1.5 py-1">
			{#each items as item, index (item.id)}
				{@const expanded = expandedId === item.id}
				{@const Icon = iconFor(item)}
				{@const input = primaryInput(item)}
				{@const output = primaryOutput(item)}
				<div class="wb-timeline-row" class:wb-timeline-row--expanded={expanded}>
					<div class="wb-timeline-row__rail">
						<span class="wb-timeline-row__seq">{sequenceLabel(item, index)}</span>
						<span class="wb-timeline-row__line"></span>
					</div>
					<div class="min-w-0 flex-1">
						<button
							class="wb-timeline-row__head"
							onclick={() => (expandedId = expanded ? null : item.id)}
							aria-expanded={expanded}
						>
							{#if expanded}<ChevronDown size={13} />{:else}<ChevronRight size={13} />{/if}
							<Icon size={14} class={item.status === 'error' ? 'text-destructive shrink-0' : 'text-primary shrink-0'} />
							<span class="min-w-0 flex-1">
								<span class="block truncate text-xs font-semibold">{item.title}</span>
								<span class="block truncate text-[11px] text-muted-foreground">
									{item.subtitle ?? kindLabel(item.kind)}
								</span>
							</span>
							<span class="wb-status {statusTone(item.status)}">
								{#if item.status === 'success'}<CheckCircle2 size={10} />{/if}
								{item.status}
							</span>
							{#if item.durationMs != null}
								<span class="w-14 text-right text-[11px] tabular-nums text-muted-foreground">{fmtMs(item.durationMs)}</span>
							{/if}
						</button>

						{#if expanded}
							<div class="wb-timeline-row__detail">
								<div class="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
									<span class="wb-meta">{kindLabel(item.kind)}</span>
									{#if item.actionType}<span class="wb-meta">{item.actionType}</span>{/if}
									{#if item.serviceName}<span class="wb-meta">{item.serviceName}</span>{/if}
									{#if item.durableTaskId}<span class="wb-meta">Dapr task {item.durableTaskId}</span>{/if}
									{#if item.relatedSpanIds.length}<span class="wb-meta">{item.relatedSpanIds.length} spans</span>{/if}
								</div>
								{#if input !== undefined || output !== undefined}
									<div class="grid gap-2">
										{#if input !== undefined}<DrilldownIo label="Input" value={input} />{/if}
										{#if output !== undefined}<DrilldownIo label="Output" value={output} />{/if}
									</div>
								{/if}
								<div class="grid grid-cols-[88px_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px]">
									{#if item.nodeId}
										<span class="text-muted-foreground">Node</span>
										<span class="truncate font-mono">{item.nodeId}</span>
									{/if}
									{#if item.durableTaskName}
										<span class="text-muted-foreground">Dapr name</span>
										<span class="truncate font-mono">{item.durableTaskName}</span>
									{/if}
									{#if item.traceId}
										<span class="text-muted-foreground">Trace</span>
										<span class="truncate font-mono">{shortId(item.traceId)}</span>
									{/if}
									{#if item.spanId}
										<span class="text-muted-foreground">Primary span</span>
										<span class="truncate font-mono">{shortId(item.spanId)}</span>
									{/if}
								</div>
							</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	</div>
{/if}

<style>
	.wb-timeline-row {
		display: flex;
		gap: 8px;
		border-radius: calc(var(--radius) - 4px);
	}
	.wb-timeline-row--expanded {
		background: color-mix(in oklch, var(--primary) 5%, transparent);
	}
	.wb-timeline-row__rail {
		display: flex;
		width: 34px;
		flex-direction: column;
		align-items: center;
		padding-top: 6px;
	}
	.wb-timeline-row__seq {
		display: grid;
		min-width: 24px;
		height: 18px;
		place-items: center;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--card);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
		color: var(--muted-foreground);
	}
	.wb-timeline-row__line {
		flex: 1;
		width: 1px;
		min-height: 10px;
		background: var(--border);
	}
	.wb-timeline-row__head {
		display: flex;
		width: 100%;
		min-width: 0;
		align-items: center;
		gap: 6px;
		padding: 5px 6px 5px 0;
		text-align: left;
	}
	.wb-timeline-row__detail {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 2px 8px 10px 0;
	}
	.wb-status,
	.wb-meta {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		border: 1px solid;
		border-radius: 999px;
		padding: 1px 6px;
		white-space: nowrap;
	}
	.wb-meta {
		border-color: var(--border);
		background: var(--card);
	}
</style>
