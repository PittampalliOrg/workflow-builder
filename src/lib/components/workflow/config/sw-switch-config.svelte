<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';

	interface Props {
		data: Record<string, unknown>;
		onUpdate: (key: string, value: unknown) => void;
	}

	let { data, onUpdate }: Props = $props();

	interface SwitchCase {
		name: string;
		when: string;
		then: string;
	}

	let taskConfig = $derived((data.taskConfig as Record<string, unknown>) || {});
	let cases = $derived.by<SwitchCase[]>(() => {
		const raw = taskConfig.cases;
		if (Array.isArray(raw)) {
			return raw.map((c: Record<string, unknown>) => ({
				name: (c.name as string) || '',
				when: (c.when as string) || '',
				then: (c.then as string) || ''
			}));
		}
		return [];
	});

	function updateCases(newCases: SwitchCase[]) {
		onUpdate('taskConfig', { ...taskConfig, cases: newCases });
	}

	function updateCase(index: number, field: keyof SwitchCase, value: string) {
		const updated = [...cases];
		updated[index] = { ...updated[index], [field]: value };
		updateCases(updated);
	}

	function removeCase(index: number) {
		const updated = cases.filter((_: SwitchCase, i: number) => i !== index);
		updateCases(updated);
	}

	function addCase() {
		updateCases([...cases, { name: '', when: '', then: '' }]);
	}
</script>

<div class="space-y-3">
	<div class="flex items-center justify-between">
		<Label>Switch Cases</Label>
		<Button variant="ghost" size="sm" onclick={addCase}>+ Add Case</Button>
	</div>

	{#if cases.length === 0}
		<p class="text-xs text-muted-foreground italic">No cases defined. Click "+ Add Case" to create one.</p>
	{/if}

	<div class="space-y-3">
		{#each cases as caseItem, i}
			<div class="rounded-md border border-border p-3 space-y-2">
				<div class="flex items-center justify-between">
					<span class="text-xs font-semibold text-foreground">Case {i + 1}</span>
					<Button
						variant="ghost"
						size="sm"
						class="text-destructive hover:bg-destructive/10"
						onclick={() => removeCase(i)}
					>
						Remove
					</Button>
				</div>
				<div class="space-y-1.5">
					<Label for="case-name-{i}">Name</Label>
					<Input
						id="case-name-{i}"
						type="text"
						value={caseItem.name}
						oninput={(e) => updateCase(i, 'name', e.currentTarget.value)}
						placeholder="Case name"
					/>
				</div>
				<div class="space-y-1.5">
					<Label for="case-when-{i}">When (condition)</Label>
					<Input
						id="case-when-{i}"
						type="text"
						value={caseItem.when}
						oninput={(e) => updateCase(i, 'when', e.currentTarget.value)}
						placeholder={'${ .status == "active" }'}
					/>
				</div>
				<div class="space-y-1.5">
					<Label for="case-then-{i}">Then (target)</Label>
					<Input
						id="case-then-{i}"
						type="text"
						value={caseItem.then}
						oninput={(e) => updateCase(i, 'then', e.currentTarget.value)}
						placeholder="continue / end / exit"
					/>
				</div>
			</div>
		{/each}
	</div>
</div>
