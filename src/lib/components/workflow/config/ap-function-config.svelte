<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Badge } from '$lib/components/ui/badge';
	import { Switch } from '$lib/components/ui/switch';
	import { Blocks } from 'lucide-svelte';

	interface Props {
		catalogFunction: { name: string; displayName: string; pieceName: string; actionName: string };
		taskConfig: Record<string, unknown>;
		onUpdate: (key: string, value: unknown) => void;
	}

	let { catalogFunction, taskConfig, onUpdate }: Props = $props();

	let withConfig = $derived((taskConfig.with as Record<string, unknown>) || {});
	let body = $derived((withConfig.body as Record<string, unknown>) || {});
	let inputValues = $derived((body.input as Record<string, unknown>) || {});
	let inputDef = $derived((taskConfig.input as Record<string, unknown>) || {});
	let schemaDef = $derived((inputDef.schema as Record<string, unknown>) || {});
	let schemaDoc = $derived((schemaDef.document as Record<string, unknown>) || {});
	let properties = $derived((schemaDoc.properties as Record<string, { type?: string; description?: string }>) || {});
	let requiredFields = $derived((schemaDoc.required as string[]) || []);

	function pieceDisplayName(name: string): string {
		return name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
	}

	function updateInput(propName: string, value: unknown) {
		const newInput = { ...inputValues, [propName]: value };
		const newBody = { ...body, input: newInput };
		const newWith = { ...withConfig, body: newBody };
		onUpdate('taskConfig', { ...taskConfig, with: newWith });
	}
</script>

<div class="space-y-4">
	<!-- Function header -->
	<div class="rounded-md border border-border/50 bg-muted/30 p-3">
		<div class="flex items-center gap-2 mb-1">
			<Blocks size={14} class="text-violet-500" />
			<span class="text-xs font-semibold">{catalogFunction.displayName}</span>
		</div>
		<div class="flex items-center gap-1.5">
			<Badge variant="secondary" class="text-[9px]">{pieceDisplayName(catalogFunction.pieceName)}</Badge>
			<span class="text-[10px] text-muted-foreground">{catalogFunction.actionName}</span>
		</div>
	</div>

	<!-- Dynamic input fields from schema -->
	{#if Object.keys(properties).length > 0}
		{#each Object.entries(properties) as [propName, prop]}
			{@const isRequired = requiredFields.includes(propName)}
			{@const value = inputValues[propName]}
			<div class="space-y-1.5">
				<Label for="ap-{propName}" class="text-xs">
					{propName}
					{#if isRequired}<span class="text-destructive">*</span>{/if}
				</Label>
				{#if prop.description}
					<p class="text-[10px] text-muted-foreground -mt-1">{prop.description}</p>
				{/if}
				{#if prop.type === 'boolean'}
					<Switch
						id="ap-{propName}"
						checked={Boolean(value)}
						onCheckedChange={(v) => updateInput(propName, v)}
					/>
				{:else if prop.type === 'object' || prop.type === 'array'}
					<Textarea
						id="ap-{propName}"
						value={typeof value === 'string' ? value : JSON.stringify(value || '', null, 2)}
						oninput={(e) => {
							try {
								updateInput(propName, JSON.parse(e.currentTarget.value));
							} catch {
								updateInput(propName, e.currentTarget.value);
							}
						}}
						placeholder={prop.type === 'object' ? '{"key": "value"}' : '["item1", "item2"]'}
						rows={3}
						class="text-xs font-mono"
					/>
				{:else if prop.type === 'number'}
					<Input
						id="ap-{propName}"
						type="number"
						value={value as string || ''}
						oninput={(e) => updateInput(propName, Number(e.currentTarget.value))}
						class="text-xs"
					/>
				{:else}
					<Input
						id="ap-{propName}"
						type="text"
						value={value as string || ''}
						oninput={(e) => updateInput(propName, e.currentTarget.value)}
						placeholder={prop.description || propName}
						class="text-xs"
					/>
				{/if}
			</div>
		{/each}
	{:else}
		<p class="text-[10px] text-muted-foreground">No input parameters defined for this action.</p>
	{/if}
</div>
