<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import type { WizardGrader } from './wizard-store.svelte';

	interface Props {
		grader: WizardGrader;
		onChange: (next: WizardGrader) => void;
	}

	let { grader, onChange }: Props = $props();

	const presets = {
		auto: {
			systemTemplate:
				'You are a Universal Evaluator. Assign a numeric quality score to the response within the inclusive range [{{range.min}}, {{range.max}}]. Respond ONLY with JSON: {"score": number, "reasoning": string}.',
			userTemplate:
				'**User input**\n\n{{item.input}}\n\n**Response to evaluate**\n\n{{sample.output_text}}',
			min: 1,
			max: 5,
			passThreshold: 3
		},
		similarity: {
			systemTemplate:
				'Rate semantic similarity between the response and reference answer on [0, 1]. Respond ONLY with JSON: {"score": number, "reasoning": string}.',
			userTemplate:
				'**Reference**\n\n{{item.ground_truth}}\n\n**Response**\n\n{{sample.output_text}}',
			min: 0,
			max: 1,
			passThreshold: 0.7
		},
		custom: { systemTemplate: '', userTemplate: '', min: 0, max: 1, passThreshold: 0.5 }
	} as const;

	type PresetKey = keyof typeof presets;

	const model = $derived((grader.config.model as string) ?? 'evaluator-default');
	const systemTemplate = $derived((grader.config.systemTemplate as string) ?? '');
	const userTemplate = $derived((grader.config.userTemplate as string) ?? '');
	const range = $derived(
		(grader.config.range as { min: number; max: number }) ?? { min: 0, max: 1 }
	);
	const passThreshold = $derived(
		typeof grader.config.passThreshold === 'number' ? grader.config.passThreshold : 0.5
	);

	function patch(next: Partial<typeof grader.config>) {
		onChange({ ...grader, config: { ...grader.config, ...next, mode: 'scorer' } });
	}

	function applyPreset(key: PresetKey) {
		const p = presets[key];
		patch({
			systemTemplate: p.systemTemplate,
			userTemplate: p.userTemplate,
			range: { min: p.min, max: p.max },
			passThreshold: p.passThreshold
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
		<Button size="sm" variant="outline" onclick={() => applyPreset('auto')}>Auto grader</Button>
		<Button size="sm" variant="outline" onclick={() => applyPreset('similarity')}>
			Semantic similarity
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
			rows={5}
			class="font-mono text-xs"
		/>
	</div>

	<div class="grid grid-cols-3 gap-2">
		<div class="flex flex-col gap-1">
			<Label class="text-xs">Min</Label>
			<Input
				type="number"
				value={range.min}
				oninput={(e) =>
					patch({
						range: { ...range, min: Number((e.target as HTMLInputElement).value) }
					})}
				class="text-sm"
			/>
		</div>
		<div class="flex flex-col gap-1">
			<Label class="text-xs">Max</Label>
			<Input
				type="number"
				value={range.max}
				oninput={(e) =>
					patch({
						range: { ...range, max: Number((e.target as HTMLInputElement).value) }
					})}
				class="text-sm"
			/>
		</div>
		<div class="flex flex-col gap-1">
			<Label class="text-xs">Pass threshold</Label>
			<Input
				type="number"
				value={passThreshold}
				oninput={(e) => patch({ passThreshold: Number((e.target as HTMLInputElement).value) })}
				class="text-sm"
			/>
		</div>
	</div>
</div>
