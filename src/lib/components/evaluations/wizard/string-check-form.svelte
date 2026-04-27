<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import type { WizardGrader } from './wizard-store.svelte';

	interface Props {
		grader: WizardGrader;
		onChange: (next: WizardGrader) => void;
	}

	let { grader, onChange }: Props = $props();

	type Op = 'equals' | 'contains' | 'not_contains' | 'starts_with' | 'ends_with' | 'regex';
	const ops: Op[] = ['equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'regex'];

	const operation = $derived((grader.config.operation as Op) ?? 'equals');
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
			placeholder="String check grader"
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
				placeholder="generatedOutput"
			/>
		</div>
		<div class="flex flex-col gap-1">
			<Label class="text-xs">Operation</Label>
			<select
				value={operation}
				onchange={(e) => patch({ operation: (e.target as HTMLSelectElement).value })}
				class="text-xs border rounded px-2 py-2 bg-background h-9"
			>
				{#each ops as op (op)}
					<option value={op}>{op}</option>
				{/each}
			</select>
		</div>
		<div class="flex flex-col gap-1">
			<Label class="text-xs">Reference</Label>
			<Input
				value={referencePath}
				oninput={(e) => patch({ referencePath: (e.target as HTMLInputElement).value })}
				class="text-xs font-mono"
				placeholder="expectedOutput"
			/>
		</div>
	</div>
	<p class="text-xs text-muted-foreground">
		Compares the value at <code>target</code> to the value at <code>reference</code>. Use
		<code>generatedOutput</code> or <code>sample.output_text</code> for the model's output and
		<code>expectedOutput</code> or <code>item.ground_truth</code> for the reference.
	</p>
</div>
