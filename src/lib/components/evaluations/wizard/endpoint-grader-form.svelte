<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Plus, Trash2 } from 'lucide-svelte';
	import type { WizardGrader } from './wizard-store.svelte';

	interface Props {
		grader: WizardGrader;
		onChange: (next: WizardGrader) => void;
	}

	let { grader, onChange }: Props = $props();

	type HeaderRow = { key: string; value: string };

	const url = $derived((grader.config.url as string) ?? '');
	const headersObj = $derived(
		(grader.config.headers as Record<string, string>) ?? {}
	);
	const headerRows = $derived(
		Object.entries(headersObj).map(([key, value]) => ({ key, value }) as HeaderRow)
	);
	const scorePath = $derived((grader.config.scorePath as string) ?? 'score');
	const passThreshold = $derived(
		typeof grader.config.passThreshold === 'number' ? grader.config.passThreshold : 0.5
	);
	const maxRps = $derived(
		typeof grader.config.maxRps === 'number' ? grader.config.maxRps : null
	);

	function patch(next: Partial<typeof grader.config>) {
		onChange({ ...grader, config: { ...grader.config, ...next } });
	}

	function setHeaders(rows: HeaderRow[]) {
		const obj: Record<string, string> = {};
		for (const r of rows) {
			if (r.key.trim()) obj[r.key.trim()] = r.value;
		}
		patch({ headers: obj });
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
		<Label class="text-xs">Endpoint URL</Label>
		<Input
			value={url}
			oninput={(e) => patch({ url: (e.target as HTMLInputElement).value })}
			placeholder="https://your-grader.example.com/score"
			class="text-sm font-mono"
		/>
	</div>
	<div class="flex flex-col gap-1.5">
		<div class="flex items-baseline justify-between">
			<Label class="text-xs">Headers (optional)</Label>
			<Button
				size="sm"
				variant="outline"
				onclick={() => setHeaders([...headerRows, { key: '', value: '' }])}
			>
				<Plus class="size-3 mr-1" /> Add header
			</Button>
		</div>
		{#each headerRows as row, i (i)}
			<div class="grid grid-cols-[1fr_2fr_auto] gap-2 items-center">
				<Input
					value={row.key}
					oninput={(e) => {
						const next = [...headerRows];
						next[i] = { ...next[i], key: (e.target as HTMLInputElement).value };
						setHeaders(next);
					}}
					placeholder="Authorization"
					class="text-xs font-mono"
				/>
				<Input
					value={row.value}
					oninput={(e) => {
						const next = [...headerRows];
						next[i] = { ...next[i], value: (e.target as HTMLInputElement).value };
						setHeaders(next);
					}}
					placeholder="Bearer …"
					class="text-xs font-mono"
				/>
				<button
					type="button"
					aria-label="Remove header"
					onclick={() => setHeaders(headerRows.filter((_, j) => j !== i))}
					class="text-muted-foreground hover:text-destructive"
				>
					<Trash2 class="size-3.5" />
				</button>
			</div>
		{/each}
	</div>
	<div class="grid grid-cols-3 gap-2">
		<div class="flex flex-col gap-1">
			<Label class="text-xs">Score path</Label>
			<Input
				value={scorePath}
				oninput={(e) => patch({ scorePath: (e.target as HTMLInputElement).value })}
				class="text-xs font-mono"
			/>
		</div>
		<div class="flex flex-col gap-1">
			<Label class="text-xs">Pass threshold</Label>
			<Input
				type="number"
				min={0}
				max={1}
				step={0.05}
				value={passThreshold}
				oninput={(e) => patch({ passThreshold: Number((e.target as HTMLInputElement).value) })}
				class="text-xs"
			/>
		</div>
		<div class="flex flex-col gap-1">
			<Label class="text-xs">Max RPS</Label>
			<Input
				type="number"
				min={0}
				step={1}
				value={maxRps ?? ''}
				oninput={(e) =>
					patch({
						maxRps: (e.target as HTMLInputElement).value
							? Number((e.target as HTMLInputElement).value)
							: undefined
					})}
				class="text-xs"
				placeholder="—"
			/>
		</div>
	</div>
	<p class="text-xs text-muted-foreground">
		Each item POSTs <code>{`{ sample, item }`}</code> to your URL. Response body is read at
		<code>scorePath</code>; numeric values ≥ pass threshold count as Pass.
		<span class="italic">Runner ships with model graders.</span>
	</p>
</div>
