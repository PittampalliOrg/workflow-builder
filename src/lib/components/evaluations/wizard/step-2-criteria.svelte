<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Plus, Trash2 } from '@lucide/svelte';
	import GraderPickerDialog from './grader-picker-dialog.svelte';
	import StringCheckForm from './string-check-form.svelte';
	import TextSimilarityForm from './text-similarity-form.svelte';
	import ModelLabelerForm from './model-labeler-form.svelte';
	import ModelScorerForm from './model-scorer-form.svelte';
	import PythonGraderForm from './python-grader-form.svelte';
	import EndpointGraderForm from './endpoint-grader-form.svelte';
	import {
		getWizardState,
		addCriterion,
		removeCriterion,
		type GraderType,
		type WizardGrader
	} from './wizard-store.svelte';

	const wiz = getWizardState();
	let dialogOpen = $state(false);

	function defaultConfigFor(type: GraderType, mode?: 'labeler' | 'scorer'): Record<string, unknown> {
		if (type === 'string_check')
			return {
				operation: 'equals',
				targetPath: 'generatedOutput',
				referencePath: 'expectedOutput'
			};
		if (type === 'text_similarity')
			return { method: 'jaccard', threshold: 0.8, targetPath: 'generatedOutput', referencePath: 'expectedOutput' };
		if (type === 'score_model' && mode === 'scorer')
			return {
				mode: 'scorer',
				model: 'evaluator-default',
				systemTemplate: '',
				userTemplate: '',
				range: { min: 0, max: 1 },
				passThreshold: 0.5
			};
		if (type === 'score_model')
			return {
				mode: 'labeler',
				model: 'evaluator-default',
				systemTemplate: '',
				userTemplate: '',
				labels: [
					{ label: 'Pass', passing: true },
					{ label: 'Fail', passing: false }
				],
				passingLabels: ['Pass']
			};
		if (type === 'python')
			return { source: 'def grade(sample, item) -> float:\n    return 1.0', passThreshold: 0.5 };
		if (type === 'endpoint')
			return { url: '', headers: {}, scorePath: 'score', passThreshold: 0.5 };
		return {};
	}

	function defaultName(type: GraderType, mode?: 'labeler' | 'scorer'): string {
		if (type === 'string_check') return 'String check grader';
		if (type === 'text_similarity') return 'Text similarity';
		if (type === 'score_model') return mode === 'scorer' ? 'Model scorer' : 'Model labeler';
		if (type === 'python') return 'Python grader';
		if (type === 'endpoint') return 'Endpoint grader';
		return 'Grader';
	}

	function onPick(type: GraderType, mode?: 'labeler' | 'scorer') {
		const id = `grader_${Date.now().toString(36)}`;
		addCriterion({
			id,
			name: defaultName(type, mode),
			type,
			config: defaultConfigFor(type, mode),
			passThreshold: 1,
			weight: 1,
			enabled: true
		});
	}

	function patchCriterion(next: WizardGrader) {
		wiz.criteria = wiz.criteria.map((c) => (c.id === next.id ? next : c));
	}

	function typeLabel(t: GraderType): string {
		switch (t) {
			case 'string_check':
				return 'String check';
			case 'text_similarity':
				return 'Text similarity';
			case 'score_model':
				return 'Model grader';
			case 'python':
				return 'Python';
			case 'endpoint':
				return 'Endpoint';
			default:
				return t;
		}
	}
</script>

<div class="flex flex-col gap-6">
	<div class="flex items-baseline justify-between">
		<div>
			<h2 class="text-base font-semibold">Create test criteria</h2>
			<p class="text-sm text-muted-foreground mt-0.5">
				Choose what you want to evaluate — factuality, sentiment, exact match, and more.
			</p>
		</div>
		<Button onclick={() => (dialogOpen = true)}>
			<Plus class="size-3.5 mr-1" /> Add
		</Button>
	</div>

	{#if wiz.criteria.length === 0}
		<div class="border rounded-md p-8 text-center text-sm text-muted-foreground">
			No criteria yet. Click <strong>Add</strong> to choose a grader.
		</div>
	{:else}
		<div class="flex flex-col gap-4">
			{#each wiz.criteria as c (c.id)}
				<div class="border rounded-md p-4 flex flex-col gap-3">
					<div class="flex items-center justify-between gap-2">
						<div class="flex items-center gap-2">
							<Badge variant="secondary" class="font-normal">{typeLabel(c.type)}</Badge>
							<span class="text-sm font-medium">{c.name}</span>
						</div>
						<button
							type="button"
							aria-label="Remove criterion"
							onclick={() => removeCriterion(c.id)}
							class="text-muted-foreground hover:text-destructive"
						>
							<Trash2 class="size-3.5" />
						</button>
					</div>
					{#if c.type === 'string_check'}
						<StringCheckForm grader={c} onChange={patchCriterion} />
					{:else if c.type === 'text_similarity'}
						<TextSimilarityForm grader={c} onChange={patchCriterion} />
					{:else if c.type === 'score_model' && c.config.mode === 'scorer'}
						<ModelScorerForm grader={c} onChange={patchCriterion} />
					{:else if c.type === 'score_model'}
						<ModelLabelerForm grader={c} onChange={patchCriterion} />
					{:else if c.type === 'python'}
						<PythonGraderForm grader={c} onChange={patchCriterion} />
					{:else if c.type === 'endpoint'}
						<EndpointGraderForm grader={c} onChange={patchCriterion} />
					{:else}
						<p class="text-xs text-muted-foreground italic">
							{typeLabel(c.type)} form coming soon — saved with default config.
						</p>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<GraderPickerDialog open={dialogOpen} onOpenChange={(o) => (dialogOpen = o)} onSelect={onPick} />
