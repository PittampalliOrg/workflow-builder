<script lang="ts">
	import { page } from '$app/state';
	import { DEFAULT_WORKSPACE_SLUG } from '$lib/utils/workspace-path';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import { Switch } from '$lib/components/ui/switch';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as Avatar from '$lib/components/ui/avatar';
	import JsonSchemaDataEditor from '../json-schema-data-editor.svelte';

	interface Props {
		schema: Record<string, unknown> | null;
		values: Record<string, unknown>;
		onChange: (values: Record<string, unknown>) => void;
		title?: string;
		description?: string | null;
		compact?: boolean;
		authPieceName?: string | null;
		authLabel?: string | null;
		authRequired?: boolean | null;
		/** Render the built-in Connection card (set false when the host pins its own). */
		showConnectionPicker?: boolean;
		resourceTypes?: Record<string, string>;
		dynamicInputs?: Record<
			string,
			{
				handler: string;
				depends_on?: string[];
				search?: boolean;
			}
		>;
		resolveOptions?: (
			fieldKey: string,
			payload: {
				input: Record<string, unknown>;
				authValue?: string | null;
				connectionExternalId?: string | null;
				searchValue?: string;
				/** Progress channel (e.g. piece-service cold-start "warming… retrying"). */
				onStatus?: (message: string | null) => void;
			},
		) => Promise<{
			options?: Array<{ label: string; value: unknown }>;
			disabled?: boolean;
			placeholder?: string;
		} | null>;
	}

	interface AppConnection {
		id: string;
		externalId: string;
		pieceName: string;
		displayName: string;
		type: string;
		status: string;
	}

	interface PieceAuthInfo {
		name: string;
		displayName: string;
		logoUrl: string | null;
		authType: string;
	}

	interface DynamicOption {
		label: string;
		value: unknown;
	}

	interface DynamicMeta {
		disabled?: boolean;
		placeholder?: string;
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

	let {
		schema,
		values,
		onChange,
		title = 'Action inputs',
		description = null,
		compact = false,
		authPieceName = null,
		authLabel = null,
		authRequired = null,
		showConnectionPicker = true,
		resourceTypes = {},
		dynamicInputs = {},
		resolveOptions = undefined,
	}: Props = $props();

	const slug = $derived(
		(page.params.slug as string | undefined) ?? DEFAULT_WORKSPACE_SLUG,
	);

	let rootSchema = $derived(asSchema(schema));
	let fieldEntries = $derived.by(() =>
		collectFields(
			rootSchema,
			[],
			0,
			new Set(Array.isArray(rootSchema.required) ? rootSchema.required : []),
		),
	);
	let hasFields = $derived(fieldEntries.length > 0);
	let dynamicFieldKeys = $derived.by(() =>
		fieldEntries
			.map((field) => field.path.join('.'))
			.filter((key) => Boolean(dynamicInputConfig(key))),
	);
	let hasResourceFields = $derived(
		fieldEntries.some((field) => Boolean(resourceTypes[field.path.join('.')])),
	);
	let inferredAuthRequired = $derived.by(() => {
		if (authRequired !== null) return authRequired;
		const piece = authPiece();
		if (piece) return piece.authType !== 'NONE';
		return Boolean(authPieceName);
	});
	let showAuthBlock = $derived(
		showConnectionPicker && Boolean(authPieceName) && inferredAuthRequired !== false,
	);

	let connections = $state<AppConnection[]>([]);
	let authPieces = $state<PieceAuthInfo[]>([]);
	let loadingConnections = $state(false);
	let connectionsLoaded = $state(false);
	let authCatalogLoaded = $state(false);
	let connectionsError = $state<string | null>(null);
	let dynamicOptions = $state<Record<string, DynamicOption[]>>({});
	let dynamicMeta = $state<Record<string, DynamicMeta>>({});
	let dynamicLoading = $state<Record<string, boolean>>({});
	let dynamicErrors = $state<Record<string, string>>({});
	let dynamicNotices = $state<Record<string, string>>({});
	let dynamicRequestVersion = $state<Record<string, number>>({});
	let dynamicSignatures = $state<Record<string, string>>({});

	function isRecord(value: unknown): value is Record<string, unknown> {
		return !!value && typeof value === 'object' && !Array.isArray(value);
	}

	function asSchema(value: unknown): JsonSchema {
		return isRecord(value) ? (value as JsonSchema) : {};
	}

	function getTypes(propSchema: JsonSchema): string[] {
		if (Array.isArray(propSchema.type)) {
			return propSchema.type.filter((entry): entry is string => typeof entry === 'string');
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

	function parseSelectValue(raw: string): unknown {
		if (!raw) return undefined;
		try {
			return JSON.parse(raw) as unknown;
		} catch {
			return raw;
		}
	}

	function selectValue(value: unknown): string {
		return JSON.stringify(value);
	}

	function dynamicInputConfig(key: string) {
		return dynamicInputs[key] || null;
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

	function dynamicNoticeFor(key: string): string | null {
		return dynamicNotices[key] || null;
	}

	function normalizeResourceName(value: string): string {
		return value
			.trim()
			.toLowerCase()
			.replace(/^@activepieces\/piece-/, '')
			.replace(/[_\s]+/g, '-');
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

	function extractConnectionExternalId(value: string | null | undefined): string | null {
		if (!value || typeof value !== 'string') return null;
		const match = value.match(/\{\{connections\['([^']+)'\]\}\}/);
		if (match) return match[1];
		return value.startsWith('{{') ? null : value;
	}

	function authValue(): string | null {
		const current = values.auth;
		return typeof current === 'string' ? current : null;
	}

	function selectedAuthExternalId(): string | null {
		return extractConnectionExternalId(authValue());
	}

	function selectedAuthConnection(): AppConnection | null {
		const externalId = selectedAuthExternalId();
		if (!externalId) return null;
		return connections.find((connection) => connection.externalId === externalId) ?? null;
	}

	function authPiece(): PieceAuthInfo | null {
		if (!authPieceName) return null;
		const target = normalizeResourceName(authPieceName);
		return authPieces.find((piece) => normalizeResourceName(piece.name) === target) ?? null;
	}

	function authPieceDisplayName(): string {
		return authLabel || authPiece()?.displayName || authPieceName || 'Connection';
	}

	function authPieceLogo(): string | null {
		return authPiece()?.logoUrl || null;
	}

	const connectionTemplateExample = "{{connections['externalId']}}";

	let lastFetchedPieceName = $state<string | null>(null);

	async function loadConnections() {
		if (loadingConnections) return;
		// Skip if already loaded for the same piece
		const currentPiece = authPieceName || null;
		if (connectionsLoaded && lastFetchedPieceName === currentPiece) return;
		loadingConnections = true;
		connectionsError = null;
		try {
			const params = new URLSearchParams();
			if (authPieceName) {
				params.set('pieceName', authPieceName);
			}
			const response = await fetch(`/api/app-connections${params.size > 0 ? `?${params.toString()}` : ''}`);
			const payload = (await response.json().catch(() => [])) as AppConnection[] | { message?: string };
			if (!response.ok || !Array.isArray(payload)) {
				connectionsError =
					(Array.isArray(payload) ? null : payload?.message) || `HTTP ${response.status}`;
				return;
			}
			connections = payload;
			connectionsLoaded = true;
			lastFetchedPieceName = currentPiece;
		} catch (error) {
			connectionsError = error instanceof Error ? error.message : String(error);
		} finally {
			loadingConnections = false;
		}
	}

	async function loadAuthCatalog() {
		if (!authPieceName || authCatalogLoaded) return;
		authCatalogLoaded = true;
		try {
			const response = await fetch('/api/pieces?auth=true');
			const payload = (await response.json().catch(() => [])) as PieceAuthInfo[] | { message?: string };
			if (!response.ok || !Array.isArray(payload)) return;
			authPieces = payload;
		} catch {
			// ignore; auth picker still works with raw/manual values
		}
	}

	async function loadDynamicOptions(key: string) {
		if (!resolveOptions) return;
		const config = dynamicInputConfig(key);
		if (!config) return;

		const requestId = (dynamicRequestVersion[key] || 0) + 1;
		dynamicRequestVersion = { ...dynamicRequestVersion, [key]: requestId };
		dynamicLoading = { ...dynamicLoading, [key]: true };
		dynamicErrors = { ...dynamicErrors, [key]: '' };
		dynamicNotices = { ...dynamicNotices, [key]: '' };

		try {
			const payload = await resolveOptions(key, {
				input: isRecord(values) ? values : {},
				authValue: authValue(),
				connectionExternalId: selectedAuthExternalId(),
				searchValue:
					config.search && typeof getPathValue(isRecord(values) ? values : {}, key.split('.')) === 'string'
						? (getPathValue(isRecord(values) ? values : {}, key.split('.')) as string)
						: undefined,
				onStatus: (message) => {
					if (requestId !== dynamicRequestVersion[key]) return;
					dynamicNotices = { ...dynamicNotices, [key]: message || '' };
				},
			});

			if (requestId !== dynamicRequestVersion[key]) return;

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
			if (requestId === dynamicRequestVersion[key]) {
				dynamicLoading = { ...dynamicLoading, [key]: false };
				dynamicNotices = { ...dynamicNotices, [key]: '' };
			}
		}
	}

	function shouldRefreshDynamicField(key: string): boolean {
		const config = dynamicInputConfig(key);
		if (!config || !resolveOptions) return false;
		const dependencyValues = Object.fromEntries(
			[
				...(config.depends_on || []),
				'auth',
			].map((dep) => [dep, dep === 'auth' ? authValue() : getPathValue(isRecord(values) ? values : {}, dep.split('.'))]),
		);
		const nextSignature = JSON.stringify(dependencyValues);
		if (dynamicSignatures[key] === nextSignature) return false;
		dynamicSignatures = { ...dynamicSignatures, [key]: nextSignature };
		return true;
	}

	$effect(() => {
		if (authPieceName) {
			void loadAuthCatalog();
		}
	});

	$effect(() => {
		if (authPieceName || hasResourceFields) {
			void loadConnections();
		}
	});

	// Re-fetch connections when user returns from creating one in another tab
	$effect(() => {
		if (typeof document === 'undefined') return;
		function onVisibilityChange() {
			if (document.visibilityState === 'visible' && authPieceName) {
				// Reset loaded state to allow re-fetch
				connectionsLoaded = false;
				lastFetchedPieceName = null;
				void loadConnections();
			}
		}
		document.addEventListener('visibilitychange', onVisibilityChange);
		return () => document.removeEventListener('visibilitychange', onVisibilityChange);
	});

	$effect(() => {
		for (const key of dynamicFieldKeys) {
			if (shouldRefreshDynamicField(key)) {
				void loadDynamicOptions(key);
			}
		}
	});

	function updateAuthConnection(externalId: string | null) {
		if (!externalId) {
			setValue(['auth'], undefined);
			return;
		}
		setValue(['auth'], `{{connections['${externalId}']}}`);
	}

	let propertyEntries = $derived(Object.entries(rootSchema.properties || {}));
	let requiredFields = $derived(new Set(rootSchema.required || []));
	let authConnections = $derived.by(() => {
		const pieceName = authPieceName ? normalizeResourceName(authPieceName) : null;
		if (!pieceName) return [];
		return connections.filter((connection) => matchesResourceType(connection, pieceName));
	});
	let hasAuthConnections = $derived(authConnections.length > 0);
	let authConnection = $derived(selectedAuthConnection());
	let authConnectionLabel = $derived(
		authConnection ? `${authConnection.displayName} (${authConnection.pieceName})` : '',
	);
	let authValueSerialized = $derived(authValue() || '');
	function renderFieldValue(field: Field): unknown {
		const current = getPathValue(isRecord(values) ? values : {}, field.path);
		return current === undefined ? field.schema.default : current;
	}
</script>

<div class="space-y-4">
	<div class="rounded-lg border border-border/70 bg-muted/20 p-3">
		<div class="flex items-center justify-between gap-3">
			<div>
				<p class="text-xs font-semibold">{title}</p>
				{#if description}
					<p class="text-[10px] text-muted-foreground">{description}</p>
				{:else}
					<p class="text-[10px] text-muted-foreground">
						{compact ? 'Schema-driven inputs.' : 'Inputs are derived from the action schema and live metadata.'}
					</p>
				{/if}
			</div>
			<Badge variant="secondary" class="text-[9px]">{fieldEntries.length} fields</Badge>
		</div>
	</div>

	{#if showAuthBlock}
		<Card.Root class="gap-3 p-3">
			<div class="flex items-center justify-between gap-3">
				<div class="flex items-center gap-2">
					{#if authPieceLogo()}
						<Avatar.Root class="h-7 w-7 rounded-md border border-border bg-background">
							<Avatar.Image src={authPieceLogo() || ''} alt={authPieceDisplayName()} class="object-contain p-1" />
							<Avatar.Fallback class="rounded-md text-[9px] font-medium">
								{authPieceDisplayName().slice(0, 1).toUpperCase()}
							</Avatar.Fallback>
						</Avatar.Root>
					{/if}
					<div>
						<p class="text-xs font-semibold">Connection</p>
						<p class="text-[10px] text-muted-foreground">
							{authPieceDisplayName()}
							{#if inferredAuthRequired === false}
								<span> · optional</span>
							{/if}
						</p>
					</div>
				</div>
				<div class="flex items-center gap-1.5">
					{#if authConnection}
						<Badge variant="outline" class="text-[9px]">{authConnection.status}</Badge>
					{/if}
					{#if inferredAuthRequired !== false}
						<Badge variant="secondary" class="text-[9px]">required</Badge>
					{/if}
				</div>
			</div>

			<div class="space-y-1.5">
				<Label class="text-xs">Selected connection</Label>
				{#if hasAuthConnections}
					<Select.Root
						type="single"
						value={authConnection?.externalId || ''}
						onValueChange={(value) => updateAuthConnection(value || null)}
					>
						<Select.Trigger class="w-full">
							{authConnection ? authConnectionLabel : `Select ${authPieceDisplayName()}`}
						</Select.Trigger>
						<Select.Content>
							{#each authConnections as connection (connection.externalId)}
								<Select.Item value={connection.externalId}>
									{connection.displayName} ({connection.pieceName})
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				{:else if connectionsLoaded && !loadingConnections}
					<div class="rounded-md border border-dashed border-border bg-muted/30 p-3 text-center">
						<p class="text-[11px] text-muted-foreground">
							No {authPieceDisplayName()} connection found
						</p>
						<a
							href="/workspaces/{slug}/credentials"
							target="_blank"
							rel="noopener noreferrer"
							class="mt-2 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
						>
							+ Connect {authPieceDisplayName()}
						</a>
						<p class="mt-1.5 text-[9px] text-muted-foreground">
							Opens the Credentials page to set up OAuth2 or API key
						</p>
					</div>
				{:else if loadingConnections}
					<div class="flex items-center gap-2 rounded-md border border-border p-2">
						<div class="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
						<span class="text-[10px] text-muted-foreground">Loading connections...</span>
					</div>
				{/if}
				<Input
					value={authValueSerialized}
					oninput={(event) => {
						const raw = event.currentTarget.value;
						setValue(['auth'], raw.trim() ? raw : undefined);
					}}
					placeholder={hasAuthConnections ? 'Or paste raw auth value / template' : 'Auth template or secret'}
					class="text-xs"
				/>
				<p class="text-[10px] text-muted-foreground">
					Stored as <code>{connectionTemplateExample}</code> when you pick a saved connection.
				</p>
			</div>
			{#if connectionsError}
				<p class="text-[10px] text-destructive">{connectionsError}</p>
			{/if}
		</Card.Root>
	{/if}

	{#if hasFields}
		<div class="space-y-3">
			{#each fieldEntries as field}
				{@const fieldKey = field.path.join('.')}
				{@const currentValue = renderFieldValue(field)}
				{@const kind = fieldKind(field.schema)}
				{@const dynamicInput = dynamicInputConfig(fieldKey)}
				{@const dynamicChoices = dynamicOptionsFor(fieldKey)}
				{@const dynamicMetaState = dynamicMetaFor(fieldKey)}
				{@const resourceType = resourceTypes[fieldKey]}
				{@const matchingConnections = resourceType ? resourceConnections(fieldKey) : []}
				<div class="space-y-1.5" style={`margin-left: ${Math.min(field.depth, 4) * 0.5}rem`}>
					<Label for={`schema-field-${fieldKey.replace(/\./g, '-')}`} class="text-xs">
						{field.label}
						{#if field.required}<span class="text-destructive">*</span>{/if}
					</Label>
					{#if field.schema.description}
						<p class="text-[10px] text-muted-foreground -mt-1">{field.schema.description}</p>
					{/if}

					{#if dynamicInput}
						<Select.Root
							type="single"
							value={currentValue === undefined ? '' : selectValue(currentValue)}
							onValueChange={(value) => setValue(field.path, parseSelectValue(value))}
						>
							<Select.Trigger class="w-full">
								{dynamicLoadingFor(fieldKey)
									? 'Loading options...'
									: dynamicMetaState.placeholder || `Select ${field.label}`}
							</Select.Trigger>
							<Select.Content>
								{#each dynamicChoices as option}
									<Select.Item value={selectValue(option.value)}>
										{option.label}
									</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
						<Input
							id={`schema-field-${fieldKey.replace(/\./g, '-')}-manual`}
							type="text"
							value={currentValue === undefined || currentValue === null ? '' : String(currentValue)}
							oninput={(event) => setValue(field.path, event.currentTarget.value)}
							placeholder={`Override ${field.label} manually`}
							class="text-xs"
						/>
						<div class="flex items-center justify-between gap-2">
							<p class="text-[10px] text-muted-foreground">
								Resolved via <code>{dynamicInput.handler}</code>
								{#if dynamicInput.depends_on?.length}
									<span> using {dynamicInput.depends_on.join(', ')}</span>
								{/if}
							</p>
							<Button
								variant="ghost"
								size="sm"
								class="h-6 px-2 text-[10px]"
								onclick={() => void loadDynamicOptions(fieldKey)}
							>
								{dynamicLoadingFor(fieldKey) ? 'Loading' : 'Refresh'}
							</Button>
						</div>
						{#if dynamicNoticeFor(fieldKey)}
							<p class="text-[10px] text-amber-500">{dynamicNoticeFor(fieldKey)}</p>
						{/if}
						{#if dynamicErrorFor(fieldKey)}
							<p class="text-[10px] text-destructive">{dynamicErrorFor(fieldKey)}</p>
						{/if}
					{:else if resourceType}
						<Select.Root
							type="single"
							value={typeof currentValue === 'string' ? currentValue : ''}
							onValueChange={(value) => setValue(field.path, value || undefined)}
						>
							<Select.Trigger class="w-full">
								{loadingConnections
									? `Loading ${resourceType} connections...`
									: matchingConnections.length > 0
										? `Select ${resourceType} connection`
										: `Enter ${resourceType} connection manually`}
							</Select.Trigger>
							<Select.Content>
								{#each matchingConnections as connection (connection.externalId)}
									<Select.Item value={connection.externalId}>
										{connection.displayName} ({connection.pieceName})
									</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
						{#if matchingConnections.length === 0}
							<Input
								id={`schema-field-${fieldKey.replace(/\./g, '-')}-manual`}
								type="text"
								value={typeof currentValue === 'string' ? currentValue : ''}
								oninput={(event) => setValue(field.path, event.currentTarget.value || undefined)}
								placeholder={`${resourceType} connection external id`}
								class="text-xs"
							/>
						{/if}
					{:else if kind === 'boolean'}
						<div class="flex items-center justify-between rounded-md border border-border/70 px-3 py-2">
							<div class="min-w-0">
								<p class="text-xs font-medium">{field.label}</p>
								{#if compact}
									<p class="text-[10px] text-muted-foreground">Toggle on or off.</p>
								{/if}
							</div>
							<Switch
								id={`schema-field-${fieldKey.replace(/\./g, '-')}`}
								checked={Boolean(currentValue)}
								onCheckedChange={(checked) => setValue(field.path, checked)}
							/>
						</div>
					{:else if kind === 'number'}
						<Input
							id={`schema-field-${fieldKey.replace(/\./g, '-')}`}
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
							class="text-xs"
						/>
					{:else if kind === 'enum'}
						<Select.Root
							type="single"
							value={currentValue === undefined ? '' : selectValue(currentValue)}
							onValueChange={(value) => setValue(field.path, parseSelectValue(value))}
						>
							<Select.Trigger class="w-full">
								{field.schema.title || `Select ${field.label}`}
							</Select.Trigger>
							<Select.Content>
								{#each field.schema.enum || [] as option}
									<Select.Item value={selectValue(option)}>
										{typeof option === 'string' ? option : JSON.stringify(option)}
									</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
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
								id={`schema-field-${fieldKey.replace(/\./g, '-')}`}
								value={serializeValue(currentValue)}
								oninput={(event) => setValue(field.path, parseJsonValue(event.currentTarget.value))}
								placeholder={field.schema.type === 'array' ? '[]' : '{}'}
								rows={Math.max(3, Math.min(8, field.path.length + 2))}
								class="font-mono text-[11px]"
							/>
						{/if}
					{:else}
						<Input
							id={`schema-field-${fieldKey.replace(/\./g, '-')}`}
							type="text"
							value={currentValue === undefined || currentValue === null ? '' : String(currentValue)}
							oninput={(event) => {
								const raw = event.currentTarget.value;
								setValue(field.path, raw.trim() ? raw : undefined);
							}}
							placeholder={field.schema.title || field.label}
							class="text-xs"
						/>
					{/if}
				</div>
			{/each}
		</div>
	{:else}
		<div class="rounded-md border border-dashed border-border/70 bg-muted/20 p-3 text-xs text-muted-foreground">
			No object properties were found in the schema.
		</div>
	{/if}
</div>
