<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { GitFork } from '@lucide/svelte';
	import RunStatusBadge from './run-status-badge.svelte';
	import { suiteShortLabel, formatRelative } from './run-status-helpers';
	import type { RunConfigSummary } from '$lib/server/benchmarks/comparison';

	type Props = {
		runs: RunConfigSummary[];
		workspaceSlug: string;
		onFork?: (run: RunConfigSummary) => void;
	};

	const { runs, workspaceSlug, onFork }: Props = $props();

	const baseline = $derived(runs[0]?.resolvedRate ?? 0);

	function deltaText(rate: number, base: number): string {
		const diff = (rate - base) * 100;
		if (Math.abs(diff) < 0.1) return '—';
		const sign = diff > 0 ? '+' : '';
		return `${sign}${diff.toFixed(1)}pp`;
	}

	function deltaClass(rate: number, base: number): string {
		const diff = rate - base;
		if (Math.abs(diff) < 0.001) return 'text-muted-foreground';
		return diff > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
	}
</script>

<div class="grid gap-3" style:grid-template-columns="repeat({runs.length}, minmax(0, 1fr))">
	{#each runs as run, idx (run.runId)}
		<div
			class="relative rounded-md border border-border bg-background p-4 transition-colors hover:border-primary/40 hover:bg-muted/30 {idx === 0 ? 'border-primary/30 ring-1 ring-primary/10' : ''}"
		>
			<a
				href={`/workspaces/${workspaceSlug}/benchmarks/runs/${run.runId}`}
				class="block"
			>
				<div class="flex items-center justify-between gap-2">
					<div class="flex items-center gap-1.5">
						<span class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
							Run #{idx + 1}{idx === 0 ? ' · baseline' : ''}
						</span>
						<Badge variant="secondary" class="text-[10px]">{suiteShortLabel(run.suiteSlug)}</Badge>
					</div>
					<RunStatusBadge status={run.status} />
				</div>

				<div class="mt-2 flex items-baseline gap-2">
					<span class="text-3xl font-semibold tabular-nums">{Math.round(run.resolvedRate * 100)}%</span>
					{#if idx > 0}
						<span class="text-xs font-medium tabular-nums {deltaClass(run.resolvedRate, baseline)}">
							{deltaText(run.resolvedRate, baseline)}
						</span>
					{/if}
				</div>
				<div class="mt-1 text-[11px] text-muted-foreground tabular-nums">
					{run.resolved}/{run.total} resolved
				</div>

				<div class="mt-3 space-y-0.5 text-[11px]">
					<div class="flex items-center justify-between gap-2">
						<span class="text-muted-foreground">Agent</span>
						<span class="truncate font-medium">{run.agent.name}</span>
					</div>
					<div class="flex items-center justify-between gap-2">
						<span class="text-muted-foreground">Model</span>
						<span class="truncate font-mono">{run.model}</span>
					</div>
					{#if run.modelLabel}
						<div class="flex items-center justify-between gap-2">
							<span class="text-muted-foreground">Label</span>
							<Badge variant="outline" class="text-[10px]">{run.modelLabel}</Badge>
						</div>
					{/if}
					<div class="flex items-center justify-between gap-2">
						<span class="text-muted-foreground">Started</span>
						<span class="text-muted-foreground">{formatRelative(run.createdAt)}</span>
					</div>
				</div>
			</a>

			{#if onFork}
				<Button
					variant="outline"
					size="sm"
					class="mt-3 h-7 w-full text-[11px]"
					onclick={() => onFork(run)}
					title="Re-run with this configuration on the same instance set"
				>
					<GitFork class="mr-1 h-3 w-3" />
					Fork — re-run
				</Button>
			{/if}
		</div>
	{/each}
</div>
