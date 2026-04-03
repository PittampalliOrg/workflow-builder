<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';

	interface Props {
		data: Record<string, unknown>;
		onUpdate: (key: string, value: unknown) => void;
	}

	let { data, onUpdate }: Props = $props();

	let taskConfig = $derived((data.taskConfig as Record<string, unknown>) || {});
	let jsonText = $state('');
	let parseError = $state('');

	// Sync from taskConfig (effect is correct here — jsonText is also edited by user,
	// so $derived would cause cursor jumps during typing. Effect only runs when
	// taskConfig changes from outside, e.g., undo/redo)
	$effect(() => {
		jsonText = JSON.stringify(taskConfig, null, 2);
		parseError = '';
	});

	function handleInput(value: string) {
		jsonText = value;
		try {
			const parsed = JSON.parse(value);
			parseError = '';
			onUpdate('taskConfig', parsed);
		} catch (e) {
			parseError = (e as Error).message;
		}
	}
</script>

<div class="space-y-3">
	<div class="flex items-center justify-between">
		<Label>Task Configuration (JSON)</Label>
		{#if parseError}
			<span class="text-[10px] text-destructive">Invalid JSON</span>
		{/if}
	</div>

	<Textarea
		value={jsonText}
		oninput={(e) => handleInput(e.currentTarget.value)}
		rows={12}
		class="w-full font-mono text-xs leading-relaxed {parseError ? 'border-destructive' : ''}"
		spellcheck={false}
	></Textarea>

	{#if parseError}
		<p class="text-[10px] text-destructive">{parseError}</p>
	{/if}

	<p class="text-[10px] text-muted-foreground">
		Edit the raw taskConfig JSON for this <code class="rounded bg-muted px-1">{data.type}</code> node.
	</p>
</div>
