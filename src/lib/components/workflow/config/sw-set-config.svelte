<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';

	interface Props {
		data: Record<string, unknown>;
		onUpdate: (key: string, value: unknown) => void;
	}

	let { data, onUpdate }: Props = $props();

	let taskConfig = $derived((data.taskConfig as Record<string, unknown>) || {});
	let setMap = $derived((taskConfig.set as Record<string, unknown>) || {});
	let entries = $derived(Object.entries(setMap));

	function updateSet(newMap: Record<string, unknown>) {
		onUpdate('taskConfig', { ...taskConfig, set: newMap });
	}

	function setEntry(oldKey: string, newKey: string, value: string) {
		const m = { ...setMap };
		if (oldKey !== newKey) delete m[oldKey];
		// Try to parse as JSON, fall back to string
		try {
			m[newKey] = JSON.parse(value);
		} catch {
			m[newKey] = value;
		}
		updateSet(m);
	}

	function removeEntry(key: string) {
		const m = { ...setMap };
		delete m[key];
		updateSet(m);
	}

	function addEntry() {
		updateSet({ ...setMap, '': '' });
	}
</script>

<div class="space-y-3">
	<div class="flex items-center justify-between">
		<Label>Variable Assignments</Label>
		<Button variant="ghost" size="sm" onclick={addEntry}>+ Add</Button>
	</div>

	{#if entries.length === 0}
		<p class="text-xs text-muted-foreground italic">No variables set. Click "+ Add" to create one.</p>
	{/if}

	<div class="space-y-2">
		{#each entries as [key, value], i}
			<div class="flex gap-1">
				<Input
					type="text"
					value={key}
					placeholder="Variable name"
					onchange={(e) => setEntry(key, e.currentTarget.value, typeof value === 'string' ? value : JSON.stringify(value))}
				/>
				<span class="flex items-center text-xs text-muted-foreground">=</span>
				<Input
					type="text"
					value={typeof value === 'string' ? value : JSON.stringify(value)}
					placeholder="Value (JSON or string)"
					oninput={(e) => setEntry(key, key, e.currentTarget.value)}
				/>
				<Button
					variant="ghost"
					size="icon-xs"
					class="text-destructive hover:bg-destructive/10"
					onclick={() => removeEntry(key)}
				>
					x
				</Button>
			</div>
		{/each}
	</div>
</div>
