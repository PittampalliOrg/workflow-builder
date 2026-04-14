<script lang="ts">
	import { Plus, Trash2 } from 'lucide-svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as Tabs from '$lib/components/ui/tabs';

	type SchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
	type JsonSchema = {
		type?: string | string[];
		title?: string;
		description?: string;
		properties?: Record<string, JsonSchema>;
		required?: string[];
		items?: JsonSchema;
		enum?: unknown[];
		additionalProperties?: boolean;
		default?: unknown;
	};

	type FieldRow = {
		key: string;
		path: string[];
		parentPath: string[];
		schema: JsonSchema;
		depth: number;
		nullable: boolean;
		type: SchemaType;
	};

	interface Props {
		value: Record<string, unknown> | null | undefined;
		onChange: (value: Record<string, unknown>) => void;
		title?: string;
		description?: string;
	}

	let {
		value,
		onChange,
		title = 'Output schema',
		description = 'Define the JSON object the model must return.'
	}: Props = $props();

	let mode = $state<'form' | 'json'>('form');
	let jsonDraft = $state('');
	let jsonError = $state<string | null>(null);
	let lastSerializedValue = $state('');

	function isRecord(nextValue: unknown): nextValue is Record<string, unknown> {
		return !!nextValue && typeof nextValue === 'object' && !Array.isArray(nextValue);
	}

	function cloneSchema(nextValue: unknown): JsonSchema {
		if (!isRecord(nextValue)) {
			return { type: 'object', properties: {}, required: [], additionalProperties: false };
		}
		return JSON.parse(JSON.stringify(nextValue)) as JsonSchema;
	}

	function effectiveType(schema: JsonSchema | undefined): SchemaType {
		if (!schema) return 'string';
		const types = Array.isArray(schema.type) ? schema.type : [schema.type].filter(Boolean);
		const nonNull = types.filter((candidate) => candidate !== 'null');
		const type = nonNull[0];
		if (type === 'number' || type === 'integer' || type === 'boolean' || type === 'object' || type === 'array') {
			return type;
		}
		if (schema.properties) return 'object';
		if (schema.items) return 'array';
		return 'string';
	}

	function isNullable(schema: JsonSchema | undefined): boolean {
		return Array.isArray(schema?.type) && schema.type.includes('null');
	}

	function withNullable(type: SchemaType, nullable: boolean): string | string[] {
		return nullable ? [type, 'null'] : type;
	}

	function normalizeProperty(schema: JsonSchema): JsonSchema {
		const type = effectiveType(schema);
		const nullable = isNullable(schema);
		const next: JsonSchema = {
			...schema,
			type: withNullable(type, nullable)
		};

		if (type === 'object') {
			const properties = isRecord(schema.properties) ? schema.properties : {};
			next.properties = Object.fromEntries(
				Object.entries(properties).map(([key, child]) => [key, normalizeProperty(child)])
			);
			next.required = Object.keys(next.properties);
			next.additionalProperties = schema.additionalProperties === true;
			delete next.items;
		} else if (type === 'array') {
			next.items = normalizeProperty(isRecord(schema.items) ? schema.items : { type: 'string' });
			delete next.properties;
			delete next.required;
			delete next.additionalProperties;
		} else {
			delete next.properties;
			delete next.required;
			delete next.items;
			delete next.additionalProperties;
		}

		if (Array.isArray(next.enum)) {
			next.enum = next.enum.filter((item) => item !== '');
			if (next.enum.length === 0) delete next.enum;
		}

		return next;
	}

	function normalizeRoot(schema: JsonSchema): JsonSchema {
		const root: JsonSchema = {
			...schema,
			type: 'object',
			properties: isRecord(schema.properties) ? schema.properties : {},
			additionalProperties: schema.additionalProperties === true
		};
		root.properties = Object.fromEntries(
			Object.entries(root.properties || {}).map(([key, child]) => [key, normalizeProperty(child)])
		);
		root.required = Object.keys(root.properties || {});
		return root;
	}

	function serialize(nextValue: unknown): string {
		try {
			return JSON.stringify(nextValue ?? {}, null, 2);
		} catch {
			return String(nextValue ?? '');
		}
	}

	function emit(schema: JsonSchema, normalize = true) {
		const next = normalize ? normalizeRoot(schema) : schema;
		lastSerializedValue = serialize(next);
		jsonDraft = lastSerializedValue;
		jsonError = null;
		onChange(next as Record<string, unknown>);
	}

	function getObjectAtPath(schema: JsonSchema, path: string[]): JsonSchema | null {
		let current: JsonSchema = schema;
		for (const key of path) {
			const child = current.properties?.[key];
			if (!child) return null;
			current = child;
		}
		return current;
	}

	function uniquePropertyName(properties: Record<string, JsonSchema>): string {
		let index = Object.keys(properties).length + 1;
		let candidate = `field_${index}`;
		while (properties[candidate]) {
			index += 1;
			candidate = `field_${index}`;
		}
		return candidate;
	}

	function updateAtPath(path: string[], updater: (schema: JsonSchema) => JsonSchema) {
		const root = normalizeRoot(cloneSchema(value));
		if (path.length === 0) {
			emit(updater(root));
			return;
		}
		const key = path[path.length - 1];
		const parent = getObjectAtPath(root, path.slice(0, -1));
		if (!parent?.properties?.[key]) return;
		parent.properties[key] = updater(parent.properties[key]);
		emit(root);
	}

	function addProperty(parentPath: string[]) {
		const root = normalizeRoot(cloneSchema(value));
		const parent = getObjectAtPath(root, parentPath);
		if (!parent) return;
		parent.type = withNullable('object', isNullable(parent));
		parent.properties = isRecord(parent.properties) ? parent.properties : {};
		parent.additionalProperties = parent.additionalProperties === true;
		parent.properties[uniquePropertyName(parent.properties)] = { type: 'string', description: '' };
		emit(root);
	}

	function removeProperty(path: string[]) {
		if (path.length === 0) return;
		const root = normalizeRoot(cloneSchema(value));
		const key = path[path.length - 1];
		const parent = getObjectAtPath(root, path.slice(0, -1));
		if (!parent?.properties) return;
		delete parent.properties[key];
		emit(root);
	}

	function renameProperty(path: string[], nextKeyRaw: string) {
		const nextKey = nextKeyRaw.trim().replace(/[^A-Za-z0-9_-]/g, '_');
		if (!nextKey || path.length === 0) return;
		const root = normalizeRoot(cloneSchema(value));
		const oldKey = path[path.length - 1];
		const parent = getObjectAtPath(root, path.slice(0, -1));
		if (!parent?.properties || !parent.properties[oldKey] || (parent.properties[nextKey] && nextKey !== oldKey)) return;
		const nextProperties: Record<string, JsonSchema> = {};
		for (const [key, child] of Object.entries(parent.properties)) {
			nextProperties[key === oldKey ? nextKey : key] = child;
		}
		parent.properties = nextProperties;
		emit(root);
	}

	function changeType(path: string[], nextType: SchemaType) {
		updateAtPath(path, (schema) => {
			const nullable = isNullable(schema);
			const next: JsonSchema = {
				title: schema.title,
				description: schema.description,
				type: withNullable(nextType, nullable)
			};
			if (nextType === 'object') {
				next.properties = isRecord(schema.properties) ? schema.properties : {};
				next.additionalProperties = false;
			}
			if (nextType === 'array') {
				next.items = isRecord(schema.items) ? schema.items : { type: 'string' };
			}
			if (nextType === 'string' && Array.isArray(schema.enum)) {
				next.enum = schema.enum;
			}
			return next;
		});
	}

	function changeNullable(path: string[], nullable: boolean) {
		updateAtPath(path, (schema) => ({
			...schema,
			type: withNullable(effectiveType(schema), nullable)
		}));
	}

	function changeDescription(path: string[], descriptionValue: string) {
		updateAtPath(path, (schema) => {
			const next = { ...schema };
			if (descriptionValue.trim()) next.description = descriptionValue;
			else delete next.description;
			return next;
		});
	}

	function changeEnum(path: string[], raw: string) {
		updateAtPath(path, (schema) => {
			const values = raw
				.split(',')
				.map((item) => item.trim())
				.filter(Boolean);
			const next = { ...schema };
			if (values.length > 0) next.enum = values;
			else delete next.enum;
			return next;
		});
	}

	function changeArrayItemType(path: string[], itemType: SchemaType) {
		updateAtPath(path, (schema) => ({
			...schema,
			items: normalizeProperty({
				...(isRecord(schema.items) ? schema.items : {}),
				type: itemType,
				...(itemType === 'object' ? { properties: {}, additionalProperties: false } : {}),
				...(itemType === 'array' ? { items: { type: 'string' } } : {})
			})
		}));
	}

	function changeRootAdditionalProperties(allowed: boolean) {
		const root = normalizeRoot(cloneSchema(value));
		root.additionalProperties = allowed;
		emit(root);
	}

	function collectRows(schema: JsonSchema, parentPath: string[] = [], depth = 0): FieldRow[] {
		const rows: FieldRow[] = [];
		for (const [key, child] of Object.entries(schema.properties || {})) {
			const path = [...parentPath, key];
			const type = effectiveType(child);
			rows.push({
				key,
				path,
				parentPath,
				schema: child,
				depth,
				nullable: isNullable(child),
				type
			});
			if (type === 'object') {
				rows.push(...collectRows(normalizeProperty(child), path, depth + 1));
			}
		}
		return rows;
	}

	function applyJson(raw: string) {
		jsonDraft = raw;
		try {
			const parsed = JSON.parse(raw);
			if (!isRecord(parsed)) {
				jsonError = 'Schema must be a JSON object.';
				return;
			}
			jsonError = null;
			lastSerializedValue = serialize(parsed);
			onChange(parsed);
		} catch (error) {
			jsonError = error instanceof Error ? error.message : 'Invalid JSON';
		}
	}

	let rootSchema = $derived(normalizeRoot(cloneSchema(value)));
	let rows = $derived(collectRows(rootSchema));

	$effect(() => {
		const nextSerialized = serialize(value ?? rootSchema);
		if (nextSerialized !== lastSerializedValue) {
			lastSerializedValue = nextSerialized;
			jsonDraft = serialize(normalizeRoot(cloneSchema(value)));
			jsonError = null;
		}
	});
</script>

<div class="space-y-2">
	<div class="space-y-0.5">
		<p class="text-xs font-semibold">{title}</p>
		<p class="text-[10px] text-muted-foreground">{description}</p>
	</div>

	<Tabs.Root bind:value={mode} class="min-h-0 gap-2">
		<Tabs.List class="h-7 w-full">
			<Tabs.Trigger value="form" class="text-xs">Form</Tabs.Trigger>
			<Tabs.Trigger value="json" class="text-xs">JSON</Tabs.Trigger>
		</Tabs.List>

		<Tabs.Content value="form" class="mt-0 space-y-3">
			<div class="flex items-center justify-between gap-2 rounded-md border border-border/70 p-2">
				<div>
					<p class="text-xs font-medium">Root object</p>
					<p class="text-[10px] text-muted-foreground">Fields are marked required for strict schema mode. Use nullable for optional values.</p>
				</div>
				<Button type="button" size="xs" variant="outline" onclick={() => addProperty([])}>
					<Plus size={12} /> Field
				</Button>
			</div>

			<label class="flex items-center gap-2 text-[11px] text-muted-foreground">
				<input
					type="checkbox"
					checked={rootSchema.additionalProperties === true}
					onchange={(event) => changeRootAdditionalProperties(event.currentTarget.checked)}
				/>
				Allow extra fields
			</label>

			{#if rows.length === 0}
				<div class="rounded-md border border-dashed border-border/70 p-3 text-xs text-muted-foreground">
					Add at least one output field.
				</div>
			{:else}
				<div class="space-y-2">
					{#each rows as row (row.path.join('.'))}
						<div
							class="space-y-2 rounded-md border border-border/70 bg-background p-2"
							style={`margin-left: ${Math.min(row.depth, 4) * 0.75}rem`}
						>
							<div class="grid grid-cols-[minmax(0,1fr)_6.5rem_auto] items-end gap-2">
								<div class="space-y-1">
									<Label class="text-[10px] text-muted-foreground">Field</Label>
									<Input
										value={row.key}
										onchange={(event) => renameProperty(row.path, event.currentTarget.value)}
										class="h-7 text-xs"
									/>
								</div>
								<div class="space-y-1">
									<Label class="text-[10px] text-muted-foreground">Type</Label>
									<NativeSelect
										value={row.type}
										onchange={(event) => changeType(row.path, event.currentTarget.value as SchemaType)}
										class="h-7 text-xs"
									>
										<option value="string">string</option>
										<option value="number">number</option>
										<option value="integer">integer</option>
										<option value="boolean">boolean</option>
										<option value="object">object</option>
										<option value="array">array</option>
									</NativeSelect>
								</div>
								<Button type="button" size="icon-xs" variant="ghost" onclick={() => removeProperty(row.path)}>
									<Trash2 size={12} />
								</Button>
							</div>

							<div class="space-y-1">
								<Label class="text-[10px] text-muted-foreground">Description</Label>
								<Input
									value={row.schema.description || ''}
									oninput={(event) => changeDescription(row.path, event.currentTarget.value)}
									class="h-7 text-xs"
									placeholder="What this field contains"
								/>
							</div>

							<div class="flex flex-wrap items-center gap-3">
								<label class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
									<input
										type="checkbox"
										checked={row.nullable}
										onchange={(event) => changeNullable(row.path, event.currentTarget.checked)}
									/>
									Nullable
								</label>

								{#if row.type === 'string'}
									<div class="min-w-0 flex-1 space-y-1">
										<Label class="text-[10px] text-muted-foreground">Enum values</Label>
										<Input
											value={(row.schema.enum || []).join(', ')}
											oninput={(event) => changeEnum(row.path, event.currentTarget.value)}
											class="h-7 text-xs"
											placeholder="optional, comma-separated"
										/>
									</div>
								{/if}

								{#if row.type === 'array'}
									<div class="w-32 space-y-1">
										<Label class="text-[10px] text-muted-foreground">Item type</Label>
										<NativeSelect
											value={effectiveType(row.schema.items)}
											onchange={(event) => changeArrayItemType(row.path, event.currentTarget.value as SchemaType)}
											class="h-7 text-xs"
										>
											<option value="string">string</option>
											<option value="number">number</option>
											<option value="integer">integer</option>
											<option value="boolean">boolean</option>
											<option value="object">object</option>
											<option value="array">array</option>
										</NativeSelect>
									</div>
								{/if}

								{#if row.type === 'object'}
									<Button type="button" size="xs" variant="outline" onclick={() => addProperty(row.path)}>
										<Plus size={12} /> Child
									</Button>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</Tabs.Content>

		<Tabs.Content value="json" class="mt-0 space-y-2">
			{#if jsonError}
				<Alert variant="destructive">
					<AlertDescription>{jsonError}</AlertDescription>
				</Alert>
			{/if}
			<Textarea
				value={jsonDraft}
				oninput={(event) => applyJson(event.currentTarget.value)}
				rows={12}
				class="font-mono text-xs"
				placeholder={'{"type":"object","properties":{}}'}
			/>
		</Tabs.Content>
	</Tabs.Root>
</div>
