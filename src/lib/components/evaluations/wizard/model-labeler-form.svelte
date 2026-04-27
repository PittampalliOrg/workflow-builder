<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Plus, Trash2 } from 'lucide-svelte';
	import type { WizardGrader } from './wizard-store.svelte';

	interface Props {
		grader: WizardGrader;
		onChange: (next: WizardGrader) => void;
	}

	let { grader, onChange }: Props = $props();

	type LabelRow = { label: string; passing: boolean };

	const presets = {
		'criteria-match': {
			systemTemplate:
				"You are an evaluator. Decide whether the assistant's final response satisfies the user's criteria. Respond ONLY with JSON: {\"label\": \"Pass\" | \"Fail\", \"reasoning\": string}.",
			userTemplate:
				'**User input**\n\n{{item.input}}\n\n**Response to evaluate**\n\n{{sample.output_text}}\n\n**Criteria**\n\n{{item.ground_truth}}',
			labels: [
				{ label: 'Pass', passing: true },
				{ label: 'Fail', passing: false }
			] as LabelRow[]
		},
		sentiment: {
			systemTemplate:
				'Classify the sentiment of the response. Respond ONLY with JSON: {"label": "Positive" | "Neutral" | "Negative", "reasoning": string}.',
			userTemplate: '{{sample.output_text}}',
			labels: [
				{ label: 'Positive', passing: true },
				{ label: 'Neutral', passing: true },
				{ label: 'Negative', passing: false }
			] as LabelRow[]
		},
		custom: { systemTemplate: '', userTemplate: '', labels: [] as LabelRow[] }
	} as const;

	type PresetKey = keyof typeof presets;

	const mode = $derived((grader.config.mode as string) ?? 'labeler');
	const model = $derived((grader.config.model as string) ?? 'evaluator-default');
	const systemTemplate = $derived((grader.config.systemTemplate as string) ?? '');
	const userTemplate = $derived((grader.config.userTemplate as string) ?? '');
	const labels = $derived((grader.config.labels as LabelRow[]) ?? []);
	const passingLabels = $derived((grader.config.passingLabels as string[]) ?? []);

	function patch(next: Partial<typeof grader.config>) {
		onChange({ ...grader, config: { ...grader.config, ...next, mode: 'labeler' } });
	}

	function applyPreset(key: PresetKey) {
		const p = presets[key];
		patch({
			systemTemplate: p.systemTemplate,
			userTemplate: p.userTemplate,
			labels: p.labels,
			passingLabels: p.labels.filter((l) => l.passing).map((l) => l.label)
		});
	}

	function setLabels(next: LabelRow[]) {
		patch({
			labels: next,
			passingLabels: next.filter((l) => l.passing).map((l) => l.label)
		});
	}
</script>

<div class="flex flex-col gap-3">
	<div class="flex flex-col gap-1.5">
		<Label class="text-xs">Name</Label>
		<Input
			value={grader.name}
			oninput={(e) => onChange({ ...grader, name: (e.target as HTMLInputElement).value })}
			class="text-sm"
		/>
	</div>

	<div class="flex flex-wrap items-center gap-2">
		<Label class="text-xs">Presets</Label>
		<Button size="sm" variant="outline" onclick={() => applyPreset('criteria-match')}>
			Criteria match
		</Button>
		<Button size="sm" variant="outline" onclick={() => applyPreset('sentiment')}>
			Sentiment
		</Button>
		<Button size="sm" variant="outline" onclick={() => applyPreset('custom')}>Custom</Button>
	</div>

	<div class="flex flex-col gap-1.5">
		<Label class="text-xs">Model (agent slug)</Label>
		<Input
			value={model}
			oninput={(e) => patch({ model: (e.target as HTMLInputElement).value })}
			class="text-sm font-mono"
			placeholder="evaluator-default"
		/>
		<p class="text-[11px] text-muted-foreground">
			Slug of a published Dapr agent that returns JSON when prompted with a rubric.
		</p>
	</div>

	<div class="flex flex-col gap-1.5">
		<Label class="text-xs">System</Label>
		<Textarea
			value={systemTemplate}
			oninput={(e) => patch({ systemTemplate: (e.target as HTMLTextAreaElement).value })}
			rows={5}
			class="font-mono text-xs"
		/>
	</div>

	<div class="flex flex-col gap-1.5">
		<Label class="text-xs">User</Label>
		<Textarea
			value={userTemplate}
			oninput={(e) => patch({ userTemplate: (e.target as HTMLTextAreaElement).value })}
			rows={6}
			class="font-mono text-xs"
		/>
		<p class="text-[11px] text-muted-foreground">
			Variables: <code>{'{{item.input}}'}</code>, <code>{'{{item.ground_truth}}'}</code>,
			<code>{'{{sample.output_text}}'}</code>.
		</p>
	</div>

	<div class="flex flex-col gap-2">
		<div class="flex items-baseline justify-between">
			<Label class="text-xs">Labels</Label>
			<Button
				size="sm"
				variant="outline"
				onclick={() => setLabels([...labels, { label: '', passing: false }])}
			>
				<Plus class="size-3 mr-1" /> Add label
			</Button>
		</div>
		{#each labels as row, i (i)}
			<div class="grid grid-cols-[1fr_auto_auto] gap-2 items-center">
				<Input
					value={row.label}
					oninput={(e) => {
						const next = [...labels];
						next[i] = { ...next[i], label: (e.target as HTMLInputElement).value };
						setLabels(next);
					}}
					class="text-sm"
					placeholder="Pass"
				/>
				<label class="flex items-center gap-1 text-xs">
					<input
						type="checkbox"
						checked={row.passing}
						onchange={(e) => {
							const next = [...labels];
							next[i] = { ...next[i], passing: (e.target as HTMLInputElement).checked };
							setLabels(next);
						}}
					/>
					Counts as pass
				</label>
				<button
					type="button"
					aria-label="Remove label"
					onclick={() => setLabels(labels.filter((_, j) => j !== i))}
					class="text-muted-foreground hover:text-destructive"
				>
					<Trash2 class="size-3.5" />
				</button>
			</div>
		{/each}
	</div>

	<p class="text-[11px] text-muted-foreground">
		Passing labels: <span class="font-mono">{passingLabels.join(', ') || '—'}</span>
	</p>
</div>
