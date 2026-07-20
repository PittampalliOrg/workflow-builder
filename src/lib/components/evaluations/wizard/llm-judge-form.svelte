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

	const model = 'kimi-k3';
	const prompt = $derived((grader.config.prompt as string) ?? '');
	const passThreshold = $derived(
		typeof grader.passThreshold === 'number'
			? grader.passThreshold
			: typeof grader.config.passThreshold === 'number'
				? grader.config.passThreshold
				: 0.5
	);

	function patchConfig(next: Partial<typeof grader.config>) {
		onChange({
			...grader,
			config: { ...grader.config, ...next, model }
		});
	}

	function setPassThreshold(value: number) {
		const threshold = Math.min(1, Math.max(0, value));
		onChange({
			...grader,
			passThreshold: threshold,
			config: { ...grader.config, model, passThreshold: threshold }
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

	<div class="flex flex-col gap-1.5">
		<Label class="text-xs" for={`judge-model-${grader.id}`}>Model</Label>
		<select
			id={`judge-model-${grader.id}`}
			value={model}
			disabled
			class="h-9 rounded-md border bg-muted px-3 text-sm font-mono disabled:cursor-not-allowed disabled:opacity-100"
		>
			<option value="kimi-k3">Kimi K3</option>
		</select>
	</div>

	<div class="flex flex-col gap-1.5">
		<Label class="text-xs" for={`judge-prompt-${grader.id}`}>Prompt</Label>
		<Textarea
			id={`judge-prompt-${grader.id}`}
			value={prompt}
			oninput={(e) => patchConfig({ prompt: (e.target as HTMLTextAreaElement).value })}
			rows={10}
			class="font-mono text-xs"
		/>
	</div>

	<div class="flex flex-col gap-1.5 max-w-[220px]">
		<Label class="text-xs" for={`judge-threshold-${grader.id}`}>Pass threshold</Label>
		<Input
			id={`judge-threshold-${grader.id}`}
			type="number"
			min={0}
			max={1}
			step={0.05}
			value={passThreshold}
			oninput={(e) => setPassThreshold(Number((e.target as HTMLInputElement).value))}
			class="text-sm"
		/>
	</div>
</div>
