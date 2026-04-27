<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Badge } from '$lib/components/ui/badge';
	import { getWizardState } from './wizard-store.svelte';
	import SubjectPicker from './subject-picker.svelte';

	const wiz = getWizardState();
</script>

<div class="flex flex-col gap-6">
	<div>
		<h2 class="text-base font-semibold">Review evaluation</h2>
		<p class="text-sm text-muted-foreground mt-0.5">Name, choose a subject, and launch the run.</p>
	</div>

	<section class="flex flex-col gap-1.5">
		<Label class="text-xs">Name</Label>
		<Input
			bind:value={wiz.name}
			placeholder="my-eval"
			class="text-sm"
			required
		/>
	</section>

	<section class="flex flex-col gap-1.5">
		<Label class="text-xs">Description (optional)</Label>
		<Textarea bind:value={wiz.description} rows={2} class="text-sm" />
	</section>

	<section class="flex flex-col gap-2">
		<Label class="text-xs uppercase tracking-wide text-muted-foreground">Subject</Label>
		<SubjectPicker />
	</section>

	<section class="grid grid-cols-2 gap-4">
		<div class="flex flex-col gap-1.5">
			<Label class="text-xs">Concurrency</Label>
			<Input
				type="number"
				min={1}
				max={32}
				value={wiz.concurrency}
				oninput={(e) => (wiz.concurrency = Number((e.target as HTMLInputElement).value || 1))}
				class="text-sm"
			/>
		</div>
		<div class="flex flex-col gap-1.5">
			<Label class="text-xs">Timeout (seconds)</Label>
			<Input
				type="number"
				min={60}
				value={wiz.timeoutSeconds}
				oninput={(e) =>
					(wiz.timeoutSeconds = Number((e.target as HTMLInputElement).value || 7200))}
				class="text-sm"
			/>
		</div>
	</section>

	<section class="flex flex-col gap-2 border rounded-md p-4 bg-card">
		<h3 class="text-xs uppercase tracking-wide text-muted-foreground">Summary</h3>
		<div class="text-xs flex items-center gap-2">
			<span class="font-medium">Data:</span>
			<Badge variant="secondary" class="font-normal">
				{wiz.dataSource === 'manual' ? `${wiz.rows.length} manual rows` : 'Uploaded file'}
			</Badge>
		</div>
		<div class="text-xs flex items-center gap-2 flex-wrap">
			<span class="font-medium">Criteria:</span>
			{#if wiz.criteria.length === 0}
				<span class="text-muted-foreground">No criteria</span>
			{:else}
				{#each wiz.criteria as c (c.id)}
					<Badge variant="secondary" class="font-normal">{c.name}</Badge>
				{/each}
			{/if}
		</div>
	</section>
</div>
