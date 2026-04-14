<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Separator } from '$lib/components/ui/separator';
	import { Switch } from '$lib/components/ui/switch';
	import { Textarea } from '$lib/components/ui/textarea';
	import JsonSchemaDataEditor from '../json-schema-data-editor.svelte';

	interface Props {
		schema: Record<string, unknown> | null;
		values: Record<string, unknown>;
		onChange: (values: Record<string, unknown>) => void;
		title?: string;
		description?: string | null;
		compact?: boolean;
	}

	type JsonSchema = {
		type?: string | string[];
		properties?: Record<string, JsonSchema>;
		required?: string[];
		description?: string;
		title?: string;
		default?: unknown;
		enum?: unknown[];
		items?: JsonSchema;
		oneOf?: JsonSchema[];
		format?: string;
	};

	type Field = {
		path: string[];
		label: string;
		schema: JsonSchema;
		required: boolean;
		depth: number;
	};

	let { schema, values, onChange, title = 'Action inputs', description = null, compact = false }: Props = $props();

	function isRecord(value: unknown): value is Record<string, unknown> {
		return !!value && typeof value === 'object' && !Array.isArray(value);
	}

	function asSchema(value: unknown): JsonSchema {
		return isRecord(value) ? (value as JsonSchema) : {};
	}

	function getTypes(propSchema: JsonSchema): string[] {
		if (Array.isArray(propSchema.type)) {
			return propSchema.type.filter((value): value is string => typeof value === 'string');
		}
		return typeof propSchema.type === 'string' ? [propSchema.type] : [];
	}

	function fieldKind(propSchema: JsonSchema): 'boolean' | 'number' | 'enum' | 'json' | 'string' {
		if (Array.isArray(propSchema.enum) && propSchema.enum.length > 0) return 'enum';
		if (Array.isArray(propSchema.oneOf) && propSchema.oneOf.length > 0) return 'json';
		const types = getTypes(propSchema).filter((type) => type !== 'null');
		if (types.includes('boolean')) return 'boolean';
		if (types.includes('integer') || types.includes('number')) return 'number';
		if (types.includes('object') || types.includes('array')) return 'json';
		if (propSchema.items || propSchema.properties) return 'json';
		return 'string';
	}

	function shouldUseGeneratedEditor(propSchema: JsonSchema): boolean {
		const types = getTypes(propSchema).filter((type) => type !== 'null');
		if (types.includes('object')) return Boolean(propSchema.properties);
		if (types.includes('array')) return Boolean(propSchema.items);
		return Boolean(propSchema.oneOf?.length || propSchema.properties || propSchema.items);
	}

	function collectFields(
		currentSchema: JsonSchema,
		path: string[] = [],
		depth = 0,
		requiredSet = new Set<string>(),
	): Field[] {
		const fields: Field[] = [];
		const properties = currentSchema.properties || {};

		for (const [name, child] of Object.entries(properties)) {
			const nextPath = [...path, name];
			const childSchema = asSchema(child);
			const isNestedObject =
				Boolean(childSchema.properties) &&
				Object.keys(childSchema.properties || {}).length > 0;

			if (isNestedObject) {
				fields.push(
					...collectFields(
						childSchema,
						nextPath,
						depth + 1,
						new Set(Array.isArray(childSchema.required) ? childSchema.required : []),
					),
				);
				continue;
			}

			fields.push({
				path: nextPath,
				label: nextPath.join('.'),
				schema: childSchema,
				required: requiredSet.has(name),
				depth,
			});
		}

		return fields;
	}

	function updatePath(source: Record<string, unknown>, path: string[], nextValue: unknown): Record<string, unknown> {
		const next = { ...source };
		let cursor: Record<string, unknown> = next;

		for (let index = 0; index < path.length; index += 1) {
			const key = path[index];
			const isLeaf = index === path.length - 1;

			if (isLeaf) {
				if (nextValue === undefined) {
					delete cursor[key];
				} else {
					cursor[key] = nextValue;
				}
				break;
			}

			const currentChild = cursor[key];
			const child = isRecord(currentChild) ? { ...currentChild } : {};
			cursor[key] = child;
			cursor = child;
		}

		return next;
	}

	function getPathValue(source: Record<string, unknown>, path: string[]): unknown {
		let current: unknown = source;
		for (const key of path) {
			if (!isRecord(current)) return undefined;
			current = current[key];
		}
		return current;
	}

	function serializeValue(value: unknown): string {
		if (typeof value === 'string') return value;
		if (value === undefined) return '';
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	}

	function parseJsonValue(raw: string): unknown {
		const trimmed = raw.trim();
		if (!trimmed) return undefined;
		try {
			return JSON.parse(trimmed) as unknown;
		} catch {
			return raw;
		}
	}

	function setValue(path: string[], nextValue: unknown) {
		onChange(updatePath(isRecord(values) ? values : {}, path, nextValue));
	}

	function selectValue(option: unknown): string {
		return JSON.stringify(option);
	}

	function parseSelectValue(raw: string): unknown {
		if (!raw) return undefined;
		try {
			return JSON.parse(raw) as unknown;
		} catch {
			return raw;
		}
	}

	let rootSchema = $derived(asSchema(schema));
	let fieldEntries = $derived.by(() =>
		collectFields(rootSchema, [], 0, new Set(Array.isArray(rootSchema.required) ? rootSchema.required : [])),
	);
	let hasFields = $derived(fieldEntries.length > 0);

	function displayValue(field: Field): unknown {
		const current = getPathValue(isRecord(values) ? values : {}, field.path);
		return current === undefined ? field.schema.default : current;
	}
</script>

<div class="rounded-lg border border-border/70 p-3">
	<div class="flex items-center justify-between gap-3">
		<div>
			<p class="text-xs font-semibold">{title}</p>
			{#if description}
				<p class="text-[10px] text-muted-foreground">{description}</p>
			{:else}
				<p class="text-[10px] text-muted-foreground">
					{compact ? 'Schema-driven inputs.' : 'Inputs are derived from the Serverless Workflow-compatible JSON schema.'}
				</p>
			{/if}
		</div>
		<Badge variant="secondary" class="text-[9px]">{fieldEntries.length} fields</Badge>
	</div>

	<Separator class="my-3" />

	{#if hasFields}
		<div class="space-y-3">
			{#each fieldEntries as field}
				{@const currentValue = displayValue(field)}
				{@const kind = fieldKind(field.schema)}
				<div class="space-y-1.5" style={`margin-left: ${Math.min(field.depth, 4) * 0.5}rem`}>
					<Label for={`sw-field-${field.path.join('-')}`} class="text-xs">
						{field.label}
						{#if field.required}<span class="text-destructive">*</span>{/if}
					</Label>
					{#if field.schema.description}
						<p class="text-[10px] text-muted-foreground -mt-1">{field.schema.description}</p>
					{/if}

					{#if kind === 'boolean'}
						<Switch
							id={`sw-field-${field.path.join('-')}`}
							checked={Boolean(currentValue)}
							onCheckedChange={(checked) => setValue(field.path, checked)}
						/>
					{:else if kind === 'number'}
						<Input
							id={`sw-field-${field.path.join('-')}`}
							type="number"
							value={typeof currentValue === 'number' || typeof currentValue === 'string' ? String(currentValue) : ''}
							oninput={(event) => {
								const raw = event.currentTarget.value.trim();
								if (!raw) {
									setValue(field.path, undefined);
									return;
								}
								const parsed = Number(raw);
								setValue(field.path, Number.isFinite(parsed) ? parsed : raw);
							}}
							placeholder={field.schema.format || field.label}
						/>
					{:else if kind === 'enum'}
						<NativeSelect
							id={`sw-field-${field.path.join('-')}`}
							class="w-full"
							value={currentValue === undefined ? '' : selectValue(currentValue)}
							onchange={(event) => setValue(field.path, parseSelectValue(event.currentTarget.value))}
						>
							<option value="">{field.schema.title || `Select ${field.label}`}</option>
							{#each field.schema.enum || [] as option}
								<option value={selectValue(option)}>{typeof option === 'string' ? option : JSON.stringify(option)}</option>
							{/each}
						</NativeSelect>
					{:else if kind === 'json'}
						{#if shouldUseGeneratedEditor(field.schema)}
							<JsonSchemaDataEditor
								schema={field.schema as Record<string, unknown>}
								value={currentValue ?? (getTypes(field.schema).includes('array') ? [] : {})}
								onChange={(nextValue) => setValue(field.path, nextValue)}
								title={field.label}
								description={field.schema.description || null}
								jsonRows={Math.max(3, Math.min(8, field.path.length + 2))}
							/>
						{:else}
							<Textarea
								id={`sw-field-${field.path.join('-')}`}
								value={serializeValue(currentValue)}
								oninput={(event) => setValue(field.path, parseJsonValue(event.currentTarget.value))}
								placeholder={field.schema.type === 'array' ? '[]' : '{}'}
								rows={Math.max(3, Math.min(8, field.path.length + 2))}
								class="font-mono text-[11px]"
							/>
						{/if}
					{:else}
						<Input
							id={`sw-field-${field.path.join('-')}`}
							type="text"
							value={currentValue === undefined || currentValue === null ? '' : String(currentValue)}
							oninput={(event) => {
								const raw = event.currentTarget.value;
								setValue(field.path, raw.trim() ? raw : undefined);
							}}
							placeholder={field.schema.title || field.label}
						/>
					{/if}
				</div>
			{/each}
		</div>
	{:else}
		<div class="rounded-md border border-dashed border-border/70 bg-muted/20 p-3 text-xs text-muted-foreground">
			No object properties were found in the schema. The action can still be tested using the raw payload preview.
		</div>
	{/if}
</div>
