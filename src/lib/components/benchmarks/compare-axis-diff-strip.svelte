<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { GitCompare } from '@lucide/svelte';
	import type { AxisDiff, AxisName, RunConfigSummary } from '$lib/types/benchmark-compare';

	type Props = {
		axisDiff: AxisDiff;
		runs: RunConfigSummary[];
	};

	const { axisDiff, runs }: Props = $props();

	const AXIS_LABELS: Record<AxisName, string> = {
		agent: 'Agent',
		agentVersion: 'Agent version',
		model: 'Model',
		modelLabel: 'Label',
		mcpServerNames: 'MCP servers',
		skillNames: 'Skills',
		hookNames: 'Hooks',
		pluginNames: 'Plugins',
		maxTurns: 'Max turns',
		concurrency: 'Concurrency',
		evaluationConcurrency: 'Eval concurrency',
		evaluatorResourceClass: 'Evaluator class'
	};

	const differingAxes = $derived(
		(Object.entries(axisDiff) as Array<[AxisName, AxisDiff[AxisName]]>).filter(
			([, diff]) => diff.differs
		)
	);

	const sharedAxes = $derived(
		(Object.entries(axisDiff) as Array<[AxisName, AxisDiff[AxisName]]>).filter(
			([, diff]) => !diff.differs
		)
	);

	function formatValue(value: unknown, axisName?: AxisName): string {
		// maxTurns=null means "use the agent's default", not "missing data".
		// Render explicitly so the diff strip reads clearly.
		if (value == null && axisName === 'maxTurns') return 'default';
		if (value == null || value === '') return '—';
		if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '—';
		return String(value);
	}
</script>

<div class="rounded-md border border-border bg-background p-4">
	<div class="mb-2 flex items-center gap-2">
		<GitCompare class="h-3.5 w-3.5 text-muted-foreground" />
		<h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
			Configuration diff
		</h3>
		{#if differingAxes.length === 0}
			<Badge variant="secondary" class="ml-1 text-[10px]">Identical configs</Badge>
		{:else}
			<span class="text-xs text-muted-foreground">
				These runs differ on
				<span class="font-medium text-foreground">
					{differingAxes.map(([name]) => AXIS_LABELS[name]).join(', ')}.
				</span>
			</span>
		{/if}
	</div>

	{#if differingAxes.length > 0}
		<div class="space-y-1.5">
			{#each differingAxes as [axisName, diff] (axisName)}
				<div class="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-3 border-t border-border pt-1.5 first:border-t-0 first:pt-0">
					<span class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
						{AXIS_LABELS[axisName]}
					</span>
					<div class="flex flex-wrap gap-1.5">
						{#each diff.values as value, idx (idx)}
							<Badge
								variant="outline"
								class="font-mono text-[10px] {idx === 0 ? 'border-primary/40 bg-primary/5' : ''}"
								title={`Run ${idx + 1}: ${runs[idx]?.modelLabel ?? runs[idx]?.runId.slice(0, 8)}`}
							>
								<span class="mr-1 text-[9px] tabular-nums text-muted-foreground">
									#{idx + 1}
								</span>
								{formatValue(value, axisName)}
							</Badge>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	{/if}

	{#if sharedAxes.length > 0 && differingAxes.length > 0}
		<details class="mt-3 border-t border-border pt-2">
			<summary class="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
				Shared across all runs ({sharedAxes.length})
			</summary>
			<div class="mt-2 space-y-1 text-[11px] text-muted-foreground">
				{#each sharedAxes as [axisName, diff] (axisName)}
					<div class="grid grid-cols-[140px_minmax(0,1fr)] gap-3">
						<span class="text-muted-foreground">{AXIS_LABELS[axisName]}</span>
						<span class="font-mono">{formatValue(diff.values[0], axisName)}</span>
					</div>
				{/each}
			</div>
		</details>
	{/if}
</div>
