<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { ThumbsUp, ThumbsDown, Loader2, Check } from '@lucide/svelte';

	/**
	 * Phase 3b widget — thumbs-up / thumbs-down on a workflow run's
	 * MLflow trace.
	 *
	 * Calls POST /api/observability/mlflow/executions/[executionId]/feedback
	 * which resolves the executionId → trace_id and emits the feedback
	 * via the orchestrator's /api/v2/observability/feedback endpoint
	 * (wraps mlflow.log_feedback).
	 *
	 * After submit, MLflow's Trace Detail view's Assessments tab shows
	 * the recorded user_rating with the user as source_id.
	 */
	let { executionId, disabled = false }: {
		executionId: string;
		disabled?: boolean;
	} = $props();

	let phase: 'idle' | 'submitting' | 'submitted' | 'error' = $state('idle');
	let lastValue: 1 | 0 | null = $state(null);
	let errorText: string | null = $state(null);

	async function submit(value: 1 | 0) {
		phase = 'submitting';
		errorText = null;
		try {
			const res = await fetch(
				`/api/observability/mlflow/executions/${encodeURIComponent(executionId)}/feedback`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						value,
						name: 'user_rating'
					})
				}
			);
			if (!res.ok) {
				const text = await res.text().catch(() => '');
				errorText = text || `HTTP ${res.status}`;
				phase = 'error';
				return;
			}
			lastValue = value;
			phase = 'submitted';
		} catch (err) {
			errorText = err instanceof Error ? err.message : 'Network error';
			phase = 'error';
		}
	}
</script>

<div class="flex items-center gap-2 text-sm">
	<span class="text-muted-foreground">Rate this run:</span>
	<Button
		variant={lastValue === 1 ? 'default' : 'outline'}
		size="icon-sm"
		title="Rate run as good"
		disabled={disabled || phase === 'submitting'}
		onclick={() => submit(1)}
	>
		{#if phase === 'submitting' && lastValue !== 0}
			<Loader2 class="animate-spin" />
		{:else if phase === 'submitted' && lastValue === 1}
			<Check />
		{:else}
			<ThumbsUp />
		{/if}
	</Button>
	<Button
		variant={lastValue === 0 ? 'destructive' : 'outline'}
		size="icon-sm"
		title="Rate run as bad"
		disabled={disabled || phase === 'submitting'}
		onclick={() => submit(0)}
	>
		{#if phase === 'submitting' && lastValue !== 1}
			<Loader2 class="animate-spin" />
		{:else if phase === 'submitted' && lastValue === 0}
			<Check />
		{:else}
			<ThumbsDown />
		{/if}
	</Button>
	{#if phase === 'error' && errorText}
		<span class="text-destructive text-xs">{errorText}</span>
	{:else if phase === 'submitted'}
		<span class="text-muted-foreground text-xs">Saved to MLflow</span>
	{/if}
</div>
