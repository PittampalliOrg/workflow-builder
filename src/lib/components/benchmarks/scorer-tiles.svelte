<script lang="ts">
	import type { ByScorerStat } from '$lib/server/benchmarks/stats';

	type Props = {
		data: ByScorerStat[];
	};

	const { data }: Props = $props();

	function fmtScore(v: number | null | undefined): string {
		if (v == null || !Number.isFinite(v)) return '—';
		return v.toFixed(2);
	}

	const SCORER_LABELS: Record<string, string> = {
		patch_files_overlap_gold: 'Files overlap gold',
		edit_minimality: 'Edit minimality',
		ran_tests_locally: 'Ran tests',
		reasoning_quality: 'Reasoning quality'
	};

	const SCORER_DESCRIPTIONS: Record<string, string> = {
		patch_files_overlap_gold: 'Fraction of touched files that match the gold patch',
		edit_minimality: 'LLM-judge: how surgical was the patch (vs sprawling)',
		ran_tests_locally: '1 if the agent ran tests in the trace, else 0',
		reasoning_quality: 'LLM-judge: did the agent show diagnostic reasoning'
	};
</script>

{#if data.length > 0}
	<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
		{#each data as scorer (scorer.scorer)}
			<div class="rounded-md border border-border bg-background p-4">
				<div
					class="text-[10px] uppercase tracking-wider text-muted-foreground"
					title={SCORER_DESCRIPTIONS[scorer.scorer] ?? scorer.scorer}
				>
					{SCORER_LABELS[scorer.scorer] ?? scorer.scorer}
				</div>
				<div class="mt-1 text-xl font-semibold tabular-nums">
					{fmtScore(scorer.mean)}
					<span class="text-xs font-normal text-muted-foreground">mean</span>
				</div>
				<div class="mt-1 text-[11px] text-muted-foreground">
					{scorer.count} scored · P50 {fmtScore(scorer.p50)} · P90 {fmtScore(scorer.p90)}
				</div>
			</div>
		{/each}
	</div>
{/if}
