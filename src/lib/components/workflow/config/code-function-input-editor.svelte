<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Switch } from '$lib/components/ui/switch';

	interface Props {
		schema: Record<string, unknown>;
		values: Record<string, unknown>;
		resourceTypes?: Record<string, string>;
		dynamicInputs?: Record<
			string,
			{
				handler: string;
				depends_on?: string[];
				search?: boolean;
			}
		>;
		codeFunctionRef?: {
			id?: string;
			slug?: string;
			version?: string;
		} | null;
		onChange: (values: Record<string, unknown>) => void;
	}

	interface AppConnection {
		id: string;
		externalId: string;
		pieceName: string;
		displayName: string;
		type: string;
		status: string;
	}

	interface DynamicOption {
		label: string;
		value: unknown;
	}

	interface DynamicMeta {
		disabled?: boolean;
		placeholder?: string;
	}

	let { schema, values, resourceTypes = {}, dynamicInputs = {}, codeFunctionRef = null, onChange }: Props = $props();

	type JsonSchema = {
		type?: string | string[];
		enum?: unknown[];
		oneOf?: unknown[];
		properties?: Record<string, JsonSchema>;
		required?: string[];
		description?: string;
		title?: string;
		default?: unknown;
		items?: JsonSchema;
		format?: string;
	};

	let objectSchema = $derived(schema as JsonSchema);
	let properties = $derived(objectSchema.properties || {});
	let requiredFields = $derived(new Set(objectSchema.required || []));
	let propertyEntries = $derived(Object.entries(properties));
	let connections = $state<AppConnection[]>([]);
	let loadingConnections = $state(false);
	let connectionsLoaded = $state(false);
	let connectionsError = $state<string | null>(null);
	let hasResourceFields = $derived(propertyEntries.some(([key]) => Boolean(resourceTypes[key])));
	let dynamicOptions = $state<Record<string, DynamicOption[]>>({});
	let dynamicMeta = $state<Record<string, DynamicMeta>>({});
	let dynamicLoading = $state<Record<string, boolean>>({});
	let dynamicErrors = $state<Record<string, string>>({});
	let dynamicRequestVersion = $state<Record<string, number>>({});
	let dynamicSignatures = $state<Record<string, string>>({});

	function getTypes(propSchema: JsonSchema): string[] {
		if (Array.isArray(propSchema.type)) {
			return propSchema.type.filter((entry): entry is string => typeof entry === 'string');
		}
		return typeof propSchema.type === 'string' ? [propSchema.type] : [];
	}

	function getDisplayValue(key: string, propSchema: JsonSchema): unknown {
		const current = values[key];
		if (current !== undefined) return current;
		return propSchema.default;
	}

	function serializeJson(value: unknown): string {
		if (typeof value === 'string') return value;
		if (value === undefined) return '';
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	}

	function updateField(key: string, nextValue: unknown) {
		const next = { ...values };
		if (nextValue === undefined) {
			delete next[key];
		} else {
			next[key] = nextValue;
		}
		onChange(next);
	}

	function parseJsonField(key: string, raw: string) {
		const trimmed = raw.trim();
		if (!trimmed) {
			updateField(key, undefined);
			return;
		}
		try {
			updateField(key, JSON.parse(trimmed) as unknown);
		} catch {
			updateField(key, raw);
		}
	}

	function parseNumberField(key: string, raw: string) {
		const trimmed = raw.trim();
		if (!trimmed) {
			updateField(key, undefined);
			return;
		}
		const parsed = Number(trimmed);
		updateField(key, Number.isFinite(parsed) ? parsed : raw);
	}

	function parseSelectField(raw: string): unknown {
		if (!raw) return undefined;
		try {
			return JSON.parse(raw) as unknown;
		} catch {
			return raw;
		}
	}

	function optionLabel(value: unknown): string {
		if (typeof value === 'string') return value;
		if (value === null) return 'null';
		return JSON.stringify(value);
	}

	function optionValue(value: unknown): string {
		return JSON.stringify(value);
	}

	function normalizeResourceName(value: string): string {
		return value.trim().toLowerCase().replace(/[_\s]+/g, '-');
	}

	function matchesResourceType(connection: AppConnection, resourceType: string): boolean {
		const connectionName = normalizeResourceName(connection.pieceName);
		const requested = normalizeResourceName(resourceType);
		return (
			connectionName === requested ||
			connectionName.includes(requested) ||
			requested.includes(connectionName)
		);
	}

	function resourceConnections(key: string): AppConnection[] {
		const resourceType = resourceTypes[key];
		if (!resourceType) return [];
		return connections.filter((connection) => matchesResourceType(connection, resourceType));
	}

	function dynamicInputConfig(key: string) {
		return dynamicInputs[key] || null;
	}

	function hasDynamicInput(key: string): boolean {
		return Boolean(dynamicInputConfig(key));
	}

	function dynamicOptionsFor(key: string): DynamicOption[] {
		return dynamicOptions[key] || [];
	}

	function dynamicLoadingFor(key: string): boolean {
		return dynamicLoading[key] === true;
	}

	function dynamicErrorFor(key: string): string | null {
		return dynamicErrors[key] || null;
	}

	function dynamicMetaFor(key: string): DynamicMeta {
		return dynamicMeta[key] || {};
	}

	async function loadConnections() {
		if (loadingConnections || connectionsLoaded || !hasResourceFields) return;
		loadingConnections = true;
		connectionsError = null;
		try {
			const response = await fetch('/api/app-connections');
			const payload = (await response.json().catch(() => [])) as AppConnection[] | { message?: string };
			if (!response.ok || !Array.isArray(payload)) {
				connectionsError =
					(Array.isArray(payload) ? null : payload?.message) || `HTTP ${response.status}`;
				return;
			}
			connections = payload;
			connectionsLoaded = true;
		} catch (error) {
			connectionsError = error instanceof Error ? error.message : String(error);
		} finally {
			loadingConnections = false;
		}
	}

	async function loadDynamicOptions(key: string) {
		const config = dynamicInputConfig(key);
		if (!config || !codeFunctionRef) return;

		const requestId = (dynamicRequestVersion[key] || 0) + 1;
		dynamicRequestVersion = { ...dynamicRequestVersion, [key]: requestId };
		dynamicLoading = { ...dynamicLoading, [key]: true };
		dynamicErrors = { ...dynamicErrors, [key]: '' };

		try {
			const response = await fetch('/api/code-functions/options', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					functionRef: codeFunctionRef,
					param: key,
					input: values,
					searchValue:
						config.search && typeof values[key] === 'string'
							? (values[key] as string)
							: undefined,
				}),
			});
			const payload = (await response.json().catch(() => null)) as
				| {
						options?: DynamicOption[];
						disabled?: boolean;
						placeholder?: string;
						message?: string;
						error?: string;
				  }
				| null;

			if (requestId !== dynamicRequestVersion[key]) return;

			if (!response.ok) {
				dynamicErrors = {
					...dynamicErrors,
					[key]: payload?.error || payload?.message || `HTTP ${response.status}`,
				};
				return;
			}

			dynamicOptions = {
				...dynamicOptions,
				[key]: Array.isArray(payload?.options) ? payload.options : [],
			};
			dynamicMeta = {
				...dynamicMeta,
				[key]: {
					disabled: payload?.disabled === true,
					placeholder: typeof payload?.placeholder === 'string' ? payload.placeholder : undefined,
				},
			};
		} catch (error) {
			if (requestId !== dynamicRequestVersion[key]) return;
			dynamicErrors = {
				...dynamicErrors,
				[key]: error instanceof Error ? error.message : String(error),
			};
		} finally {
			if (requestId !== dynamicRequestVersion[key]) return;
			dynamicLoading = { ...dynamicLoading, [key]: false };
		}
	}

	function scalarKind(propSchema: JsonSchema): 'boolean' | 'number' | 'string' | 'json' | 'enum' {
		if (propSchema.enum?.length) return 'enum';

		const types = getTypes(propSchema).filter((type) => type !== 'null');
		if (propSchema.oneOf?.length) return 'json';
		if (types.includes('boolean')) return 'boolean';
		if (types.includes('number') || types.includes('integer')) return 'number';
		if (types.includes('array') || types.includes('object')) return 'json';
		if (propSchema.items || propSchema.properties) return 'json';
		return 'string';
	}

	$effect(() => {
		if (!hasResourceFields) return;
		void loadConnections();
	});

	$effect(() => {
		if (!codeFunctionRef) return;
		for (const [key] of propertyEntries) {
			if (hasDynamicInput(key)) {
				const config = dynamicInputConfig(key);
				const signature = JSON.stringify({
					functionRef: codeFunctionRef,
					dependsOn: config?.depends_on || [],
					values: (config?.depends_on || []).map((dependency) => [dependency, values[dependency]]),
				});
				if (dynamicSignatures[key] === signature) continue;
				dynamicSignatures = { ...dynamicSignatures, [key]: signature };
				void loadDynamicOptions(key);
			}
		}
	});
</script>

<div class="rounded-lg border border-border/70 p-3">
	<div class="flex items-center justify-between gap-3">
		<div>
			<p class="text-xs font-semibold">Code inputs</p>
			<p class="text-[10px] text-muted-foreground">
				Values are stored in `taskConfig.with.body.input`.
			</p>
		</div>
		<Badge variant="secondary" class="text-[9px]">{propertyEntries.length} fields</Badge>
	</div>

	{#if propertyEntries.length > 0}
		<div class="mt-3 space-y-3">
			{#each propertyEntries as [key, propSchema]}
				{@const kind = scalarKind(propSchema)}
				{@const currentValue = getDisplayValue(key, propSchema)}
				{@const isRequired = requiredFields.has(key)}
				{@const resourceType = resourceTypes[key]}
				{@const matchingConnections = resourceConnections(key)}
				{@const dynamicInput = dynamicInputConfig(key)}
				{@const dynamicChoices = dynamicOptionsFor(key)}
				{@const dynamicMetaState = dynamicMetaFor(key)}
				<div class="space-y-1.5">
					<Label for={`code-input-${key}`} class="text-xs">
						{propSchema.title || key}
						{#if isRequired}<span class="text-destructive">*</span>{/if}
					</Label>
					{#if propSchema.description}
						<p class="text-[10px] text-muted-foreground -mt-1">{propSchema.description}</p>
					{/if}

					{#if dynamicInput}
						<NativeSelect
							id={`code-input-${key}`}
							class="w-full"
							value={currentValue === undefined ? '' : optionValue(currentValue)}
							disabled={dynamicLoadingFor(key) || dynamicMetaState.disabled === true}
							onchange={(event) => updateField(key, parseSelectField(event.currentTarget.value))}
						>
							<option value="">
								{dynamicLoadingFor(key)
									? 'Loading options...'
									: dynamicMetaState.placeholder
										? dynamicMetaState.placeholder
										: dynamicChoices.length > 0
										? `Select ${propSchema.title || key}`
										: 'No dynamic options returned'}
							</option>
							{#each dynamicChoices as option}
								<option value={optionValue(option.value)}>{option.label}</option>
							{/each}
						</NativeSelect>
						<Input
							id={`code-input-${key}-manual`}
							type="text"
							value={currentValue === undefined || currentValue === null ? '' : String(currentValue)}
							oninput={(event) => updateField(key, event.currentTarget.value)}
							placeholder={`Override ${propSchema.title || key} manually`}
						/>
						<div class="flex items-center justify-between gap-2">
							<p class="text-[10px] text-muted-foreground">
								Resolved via <code>{dynamicInput.handler}</code>
								{#if dynamicInput.depends_on?.length}
									<span> using {dynamicInput.depends_on.join(', ')}</span>
								{/if}
							</p>
							<button
								type="button"
								class="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
								onclick={() => void loadDynamicOptions(key)}
							>
								Refresh
							</button>
						</div>
						{#if dynamicErrorFor(key)}
							<p class="text-[10px] text-destructive">{dynamicErrorFor(key)}</p>
						{/if}
					{:else if resourceType}
						<NativeSelect
							id={`code-input-${key}`}
							class="w-full"
							value={typeof currentValue === 'string' ? currentValue : ''}
							onchange={(event) => updateField(key, event.currentTarget.value || undefined)}
						>
							<option value="">
								{loadingConnections
									? `Loading ${resourceType} connections...`
									: matchingConnections.length > 0
										? `Select ${resourceType} connection`
										: `Enter ${resourceType} connection manually below`}
							</option>
							{#each matchingConnections as connection}
								<option value={connection.externalId}>
									{connection.displayName} ({connection.pieceName})
								</option>
							{/each}
						</NativeSelect>
						{#if matchingConnections.length === 0}
							<Input
								id={`code-input-${key}-manual`}
								type="text"
								value={currentValue === undefined || currentValue === null ? '' : String(currentValue)}
								oninput={(event) => updateField(key, event.currentTarget.value)}
								placeholder={`${resourceType} connection external id`}
							/>
						{/if}
						{#if connectionsError}
							<p class="text-[10px] text-destructive">{connectionsError}</p>
						{/if}
					{:else if kind === 'boolean'}
						<div class="flex items-center justify-between rounded-md border border-border/70 px-3 py-2">
							<div class="min-w-0">
								<p class="text-xs font-medium">{propSchema.title || key}</p>
								{#if propSchema.default !== undefined}
									<p class="text-[10px] text-muted-foreground">Default: {optionLabel(propSchema.default)}</p>
								{/if}
							</div>
							<Switch
								checked={Boolean(currentValue)}
								onCheckedChange={(checked) => updateField(key, checked)}
							/>
						</div>
					{:else if kind === 'number'}
						<Input
							id={`code-input-${key}`}
							type="number"
							value={currentValue === undefined || currentValue === null ? '' : String(currentValue)}
							oninput={(event) => parseNumberField(key, event.currentTarget.value)}
						/>
					{:else if kind === 'enum'}
						<NativeSelect
							id={`code-input-${key}`}
							class="w-full"
							value={currentValue === undefined ? '' : optionValue(currentValue)}
							onchange={(event) => updateField(key, parseSelectField(event.currentTarget.value))}
						>
							{#if !isRequired}
								<option value="">Select a value</option>
							{/if}
							{#each propSchema.enum || [] as option}
								<option value={optionValue(option)}>{optionLabel(option)}</option>
							{/each}
						</NativeSelect>
					{:else if kind === 'json'}
						<Textarea
							id={`code-input-${key}`}
							rows={5}
							class="font-mono text-[11px]"
							value={serializeJson(currentValue)}
							oninput={(event) => parseJsonField(key, event.currentTarget.value)}
							placeholder={propSchema.type === 'array' ? '[]' : '{}'}
						/>
					{:else}
						<Input
							id={`code-input-${key}`}
							type="text"
							value={currentValue === undefined || currentValue === null ? '' : String(currentValue)}
							oninput={(event) => updateField(key, event.currentTarget.value)}
						/>
					{/if}
				</div>
			{/each}
		</div>
	{:else}
		<div class="mt-3 rounded-md border border-dashed border-border/70 bg-muted/30 p-3 text-xs text-muted-foreground">
			The parser did not expose any named inputs for this function.
		</div>
	{/if}
</div>
