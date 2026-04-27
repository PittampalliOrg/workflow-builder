<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import type { WizardGrader } from './wizard-store.svelte';

	interface Props {
		grader: WizardGrader;
		onChange: (next: WizardGrader) => void;
	}

	let { grader, onChange }: Props = $props();

	type Method = 'jaccard' | 'fuzzy' | 'bleu' | 'rouge' | 'cosine';
	const methods: { value: Method; label: string; live: boolean }[] = [
		{ value: 'jaccard', label: 'Token Jaccard', live: true },
		{ value: 'fuzzy', label: 'Fuzzy match', live: false },
		{ value: 'bleu', label: 'BLEU', live: false },
		{ value: 'rouge', label: 'ROUGE', live: false },
		{ value: 'cosine', label: 'Cosine similarity', live: false }
	];

	const method = $derived((grader.config.method as Method) ?? 'jaccard');
	const threshold = $derived(typeof grader.config.threshold === 'number' ? grader.config.threshold : 0.8);
	const targetPath = $derived((grader.config.targetPath as string) ?? 'generatedOutput');
	const referencePath = $derived((grader.config.referencePath as string) ?? 'expectedOutput');

	function patch(next: Partial<typeof grader.config>) {
		onChange({ ...grader, config: { ...grader.config, ...next } });
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
	<div class="grid grid-cols-3 gap-2 items-end">
		<div class="flex flex-col gap-1">
			<Label class="text-xs">Target</Label>
			<Input
				value={targetPath}
				oninput={(e) => patch({ targetPath: (e.target as HTMLInputElement).value })}
				class="text-xs font-mono"
			/>
		</div>
		<div class="flex flex-col gap-1">
			<Label class="text-xs">Method</Label>
			<select
				value={method}
				onchange={(e) => patch({ method: (e.target as HTMLSelectElement).value })}
				class="text-xs border rounded px-2 py-2 bg-background h-9"
			>
				{#each methods as m (m.value)}
					<option value={m.value} disabled={!m.live}>
						{m.label}{m.live ? '' : ' (soon)'}
					</option>
				{/each}
			</select>
		</div>
		<div class="flex flex-col gap-1">
			<Label class="text-xs">Reference</Label>
			<Input
				value={referencePath}
				oninput={(e) => patch({ referencePath: (e.target as HTMLInputElement).value })}
				class="text-xs font-mono"
			/>
		</div>
	</div>
	<div class="flex flex-col gap-1">
		<Label class="text-xs">Passing grade ({threshold.toFixed(2)})</Label>
		<input
			type="range"
			min="0"
			max="1"
			step="0.05"
			value={threshold}
			oninput={(e) => patch({ threshold: Number((e.target as HTMLInputElement).value) })}
		/>
	</div>
</div>
