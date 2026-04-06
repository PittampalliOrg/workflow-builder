<script lang="ts">
	/**
	 * Schema-driven config form for an action.
	 * Renders fields from the action's inputSchema (JSON Schema).
	 * Modeled after sw-generic-schema-config.svelte and Vercel's action-config-renderer.
	 */
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Switch } from '$lib/components/ui/switch';
	import * as Select from '$lib/components/ui/select';
	import { Separator } from '$lib/components/ui/separator';

	interface Props {
		schema: Record<string, unknown> | null;
		values: Record<string, unknown>;
		onChange: (values: Record<string, unknown>) => void;
		connectionExternalId?: string | null;
		onConnectionChange?: (connId: string) => void;
		connections?: Array<{ pieceName: string; externalId: string; displayName: string }>;
		pieceName?: string;
	}

	let {
		schema,
		values,
		onChange,
		connectionExternalId = null,
		onConnectionChange,
		connections = [],
		pieceName = ''
	}: Props = $props();

	// Extract fields from JSON Schema
	const fields = $derived.by(() => {
		if (!schema || typeof schema !== 'object') return [];
		const props = (schema as Record<string, unknown>).properties as Record<string, Record<string, unknown>> | undefined;
		const required = (schema as Record<string, unknown>).required as string[] | undefined;
		if (!props) return [];

		return Object.entries(props).map(([name, fieldSchema]) => ({
			name,
			label: (fieldSchema.title || fieldSchema.description || name) as string,
			description: (fieldSchema.description || '') as string,
			type: (Array.isArray(fieldSchema.type) ? fieldSchema.type[0] : fieldSchema.type || 'string') as string,
			required: required?.includes(name) ?? false,
			default: fieldSchema.default,
			enum: fieldSchema.enum as unknown[] | undefined,
			format: fieldSchema.format as string | undefined,
		}));
	});

	// Matching connection for this piece
	const matchingConnections = $derived(
		connections.filter((c) => {
			const shortName = c.pieceName.replace('@activepieces/piece-', '').replace(/^@.*\//, '');
			return shortName === pieceName || c.pieceName === pieceName;
		})
	);

	function updateField(name: string, value: unknown) {
		onChange({ ...values, [name]: value });
	}

	function getFieldType(field: { type: string; enum?: unknown[]; format?: string }): string {
		if (field.enum && field.enum.length > 0) return 'select';
		if (field.type === 'boolean') return 'switch';
		if (field.type === 'number' || field.type === 'integer') return 'number';
		if (field.type === 'array') return 'array';
		if (field.type === 'object') return 'json';
		if (field.format === 'textarea' || field.type === 'string' && field.enum === undefined) {
			// Heuristic: long field names suggest textarea
			return 'text';
		}
		return 'text';
	}
</script>

<div class="flex flex-col gap-3 p-3">
	<!-- Connection selector (if piece requires auth) -->
	{#if matchingConnections.length > 0 || pieceName}
		<div class="space-y-1.5">
			<Label class="text-[11px] text-muted-foreground">Connection</Label>
			<Select.Root
				type="single"
				value={connectionExternalId || undefined}
				onValueChange={(v) => onConnectionChange?.(v)}
			>
				<Select.Trigger class="h-8 text-xs">
					{#if connectionExternalId}
						{matchingConnections.find(c => c.externalId === connectionExternalId)?.displayName || connectionExternalId}
					{:else}
						<span class="text-muted-foreground">Select connection...</span>
					{/if}
				</Select.Trigger>
				<Select.Content>
					{#each matchingConnections as conn}
						<Select.Item value={conn.externalId} label={conn.displayName}>
							{conn.displayName}
						</Select.Item>
					{/each}
					{#if matchingConnections.length === 0}
						<div class="px-2 py-1.5 text-xs text-muted-foreground">
							No {pieceName} connections found
						</div>
					{/if}
				</Select.Content>
			</Select.Root>
		</div>

		<Separator />
	{/if}

	<!-- Schema-driven fields -->
	{#each fields as field}
		{@const fieldType = getFieldType(field)}
		<div class="space-y-1.5">
			<Label class="text-[11px] text-muted-foreground">
				{field.label}
				{#if field.required}
					<span class="text-destructive">*</span>
				{/if}
			</Label>

			{#if fieldType === 'select'}
				<Select.Root
					type="single"
					value={String(values[field.name] ?? field.default ?? '')}
					onValueChange={(v) => updateField(field.name, v)}
				>
					<Select.Trigger class="h-8 text-xs">
						{String(values[field.name] ?? field.default ?? 'Select...')}
					</Select.Trigger>
					<Select.Content>
						{#each field.enum || [] as opt}
							<Select.Item value={String(opt)} label={String(opt)}>
								{String(opt)}
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>

			{:else if fieldType === 'switch'}
				<Switch
					checked={Boolean(values[field.name] ?? field.default)}
					onCheckedChange={(v) => updateField(field.name, v)}
				/>

			{:else if fieldType === 'number'}
				<Input
					type="number"
					value={String(values[field.name] ?? field.default ?? '')}
					oninput={(e) => updateField(field.name, Number(e.currentTarget.value))}
					class="h-8 text-xs"
					placeholder={field.description || field.name}
				/>

			{:else if fieldType === 'json' || fieldType === 'array'}
				<Textarea
					value={typeof values[field.name] === 'string'
						? values[field.name] as string
						: JSON.stringify(values[field.name] ?? field.default ?? {}, null, 2)}
					oninput={(e) => {
						try {
							updateField(field.name, JSON.parse(e.currentTarget.value));
						} catch {
							updateField(field.name, e.currentTarget.value);
						}
					}}
					class="min-h-[60px] font-mono text-xs"
					placeholder={`${field.name} (JSON)`}
				/>

			{:else}
				<!-- text input -->
				<Input
					value={String(values[field.name] ?? field.default ?? '')}
					oninput={(e) => updateField(field.name, e.currentTarget.value)}
					class="h-8 text-xs"
					placeholder={field.description || field.name}
				/>
			{/if}

			{#if field.description && field.description !== field.label}
				<p class="text-[10px] text-muted-foreground/70">{field.description}</p>
			{/if}
		</div>
	{/each}

	{#if fields.length === 0 && schema}
		<p class="text-xs text-muted-foreground py-4 text-center">
			No configurable fields for this action.
		</p>
	{/if}
</div>
