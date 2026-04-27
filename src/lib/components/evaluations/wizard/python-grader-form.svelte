<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import type { WizardGrader } from './wizard-store.svelte';

	interface Props {
		grader: WizardGrader;
		onChange: (next: WizardGrader) => void;
	}

	let { grader, onChange }: Props = $props();

	const source = $derived(
		(grader.config.source as string) ??
			'def grade(sample: dict, item: dict) -> float:\n    return 1.0'
	);
	const passThreshold = $derived(
		typeof grader.config.passThreshold === 'number' ? grader.config.passThreshold : 0.5
	);

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
	<div class="grid grid-cols-[1fr_220px] gap-3">
		<div class="flex flex-col gap-1.5">
			<Label class="text-xs">Source code</Label>
			<Textarea
				value={source}
				oninput={(e) => patch({ source: (e.target as HTMLTextAreaElement).value })}
				rows={14}
				class="font-mono text-xs"
				spellcheck="false"
			/>
		</div>
		<div class="flex flex-col gap-2 text-xs">
			<div class="border rounded-md p-3 bg-muted/30">
				<div class="font-semibold mb-1">sample</div>
				<pre class="text-[10px] font-mono">
{`{
  "output_text": "Hardware",
  "output": ...,
  "id": "row_id"
}`}
				</pre>
			</div>
			<div class="border rounded-md p-3 bg-muted/30">
				<div class="font-semibold mb-1">item</div>
				<pre class="text-[10px] font-mono">
{`{
  "input": {...},
  "ground_truth": ...,
  "id": "row_id"
}`}
				</pre>
			</div>
		</div>
	</div>
	<div class="flex flex-col gap-1 max-w-[200px]">
		<Label class="text-xs">Pass threshold</Label>
		<Input
			type="number"
			min={0}
			max={1}
			step={0.05}
			value={passThreshold}
			oninput={(e) => patch({ passThreshold: Number((e.target as HTMLInputElement).value) })}
			class="text-sm"
		/>
	</div>
	<p class="text-[11px] text-muted-foreground">
		Sandboxed by the <code>code-runtime</code> service. Returns a float in [0, 1] which is
		compared to the pass threshold.
	</p>
</div>
