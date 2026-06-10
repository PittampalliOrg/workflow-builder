<script lang="ts">
	import { page } from '$app/state';
	import { DEFAULT_WORKSPACE_SLUG } from '$lib/utils/workspace-path';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Avatar from '$lib/components/ui/avatar';
	import * as Card from '$lib/components/ui/card';
	import * as Select from '$lib/components/ui/select';
	import {
		AlertTriangle,
		Blocks,
		CheckCircle2,
		ExternalLink,
		Loader2,
		Play,
	} from '@lucide/svelte';
	import ResourceAwareSchemaConfig from './lazy-resource-aware-schema-config.svelte';
	import JsonViewer from '../execution/json-viewer.svelte';

	interface Props {
		catalogFunction: { name: string; displayName: string; pieceName: string; actionName: string };
		actionDetail?: Record<string, unknown> | null;
		taskConfig: Record<string, unknown>;
		onUpdate: (key: string, value: unknown) => void;
	}

	interface PieceAuthInfo {
		name: string;
		displayName: string;
		logoUrl: string | null;
		authType: string;
	}

	interface PieceConnectionSummary {
		id: string;
		externalId: string;
		displayName: string;
		type: string;
		status: string;
	}

	interface PieceCatalogEntry {
		pieceName: string;
		canonicalPieceName: string;
		displayName: string;
		logoUrl: string | null;
		requiresAuth: boolean;
		isOAuth2: boolean;
		oauthAppConfigured: boolean;
		appConnections: PieceConnectionSummary[];
	}

	interface DynamicProvider {
		handler: string;
		depends_on?: string[];
		search?: boolean;
	}

	type ActionField = {
		name?: string;
		options?: {
			kind?: string;
		} | null;
		dependsOn?: string[];
		refreshers?: string[];
		refreshOnSearch?: boolean;
	};

	let { catalogFunction, actionDetail = null, taskConfig, onUpdate }: Props = $props();

	const workspaceSlug = $derived(
		(page.params.slug as string | undefined) ?? DEFAULT_WORKSPACE_SLUG,
	);

	let withConfig = $derived((taskConfig.with as Record<string, unknown>) || {});
	let body = $derived((withConfig.body as Record<string, unknown>) || {});

	// Resolve the actual piece name for auth connection lookup.
	// Priority: actionDetail.providerId > body.metadata.pieceName > extract from catalogFunction.name
	let resolvedPieceName = $derived.by(() => {
		const fromDetail = actionDetail?.providerId;
		if (typeof fromDetail === 'string' && fromDetail.length > 0) return fromDetail;
		const fromMetadata = (body?.metadata as Record<string, unknown> | undefined)?.pieceName;
		if (typeof fromMetadata === 'string' && fromMetadata.length > 0) return fromMetadata;
		// catalogFunction.pieceName may be the category (e.g., CONTENT_AND_FILES).
		// Extract piece name from catalogFunction.name (e.g., "microsoft-onedrive-list_folders")
		const name = catalogFunction.name;
		const actionName = catalogFunction.actionName;
		if (name && actionName && name.endsWith(actionName)) {
			const piece = name.slice(0, name.length - actionName.length - 1);
			if (piece.length > 0) return piece;
		}
		return catalogFunction.pieceName;
	});
	let inputValues = $derived((body.input as Record<string, unknown>) || {});
	let inputDef = $derived((taskConfig.input as Record<string, unknown>) || {});
	let schemaDef = $derived((inputDef.schema as Record<string, unknown>) || {});
	let schemaDoc = $derived((schemaDef.document as Record<string, unknown>) || {});
	let fallbackActionSchema = $derived(
		(actionDetail?.signature as { inputSchema?: Record<string, unknown> } | undefined)?.inputSchema ||
		(actionDetail?.definition as { input?: { schema?: { document?: Record<string, unknown> } } } | undefined)?.input?.schema?.document ||
		(actionDetail?.taskConfig as { input?: { schema?: { document?: Record<string, unknown> } } } | undefined)?.input?.schema?.document ||
		null,
	);
	let schema = $derived((schemaDoc && Object.keys(schemaDoc).length > 0 ? schemaDoc : fallbackActionSchema) as Record<string, unknown> | null);
	let actionId = $derived(
		typeof actionDetail?.id === 'string' && actionDetail.id.length > 0
			? actionDetail.id
			: catalogFunction.name,
	);

	let authPieces = $state<PieceAuthInfo[]>([]);
	let authPiecesLoaded = $state(false);
	let authLoading = $state(false);

	function isRecord(value: unknown): value is Record<string, unknown> {
		return !!value && typeof value === 'object' && !Array.isArray(value);
	}

	function pieceDisplayName(name: string): string {
		return name
			.split('-')
			.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
			.join(' ');
	}

	function extractBoolean(value: unknown): boolean | null {
		return typeof value === 'boolean' ? value : null;
	}

	function authPiece(): PieceAuthInfo | null {
		return authPieces.find((piece) => piece.name === catalogFunction.pieceName) ?? null;
	}

	let authRequired = $derived.by(() => {
		const raw = actionDetail && isRecord(actionDetail) ? actionDetail : null;
		const rawAuthRequired =
			extractBoolean(raw?.authRequired) ??
			extractBoolean((raw?.auth as Record<string, unknown> | undefined)?.required) ??
			null;
		if (rawAuthRequired !== null) return rawAuthRequired;
		const piece = authPiece();
		return piece ? piece.authType !== 'NONE' : false;
	});

	let authLabel = $derived(
		(actionDetail?.providerLabel as string | undefined) ||
			authPiece()?.displayName ||
			pieceDisplayName(catalogFunction.pieceName),
	);
	let providerIconUrl = $derived((actionDetail?.providerIconUrl as string | undefined) || null);
	let category = $derived((actionDetail?.category as string | undefined) || null);
	let pieceVersion = $derived(
		typeof actionDetail?.version === 'string' && actionDetail.version.length > 0
			? actionDetail.version
			: null,
	);
	let resourceTypes = $derived({});
	let dynamicInputs = $derived.by(() => {
		const raw = actionDetail && isRecord(actionDetail) ? actionDetail : null;
		const fieldProviders = Array.isArray(raw?.fields)
			? (raw?.fields as ActionField[]).reduce((acc, field) => {
					if (!field?.name || field.options?.kind !== 'dynamic') return acc;
					acc[field.name] = {
						handler: 'activepieces-options',
						depends_on:
							Array.isArray(field.dependsOn) && field.dependsOn.length > 0
								? field.dependsOn
								: Array.isArray(field.refreshers)
									? field.refreshers
									: [],
						search: field.refreshOnSearch === true,
					};
					return acc;
				}, {} as Record<string, DynamicProvider>)
			: {};
		const source =
			(Object.keys(fieldProviders).length > 0 ? fieldProviders : null) ||
			(raw?.dynamicInputs as Record<string, DynamicProvider> | undefined) ||
			(raw?.fieldProviders as Record<string, DynamicProvider> | undefined) ||
			((raw?.semanticModel as { dynamic_inputs?: Array<{ name?: string; handler?: string; depends_on?: string[]; search?: boolean }> } | undefined)
				?.dynamic_inputs || [])
				.reduce((acc, item) => {
					if (!item?.name || !item.handler) return acc;
					acc[item.name] = {
						handler: item.handler,
						depends_on: item.depends_on || [],
						search: item.search === true,
					};
					return acc;
				}, {} as Record<string, DynamicProvider>);

		return isRecord(source) ? (source as Record<string, DynamicProvider>) : fieldProviders;
	});

	function updateInput(values: Record<string, unknown>) {
		const newBody = { ...body, input: values };
		const newWith = { ...withConfig, body: newBody };
		onUpdate('taskConfig', { ...taskConfig, with: newWith });
	}

	async function loadAuthPieces() {
		if (authPiecesLoaded || authLoading) return;
		authLoading = true;
		try {
			const response = await fetch('/api/pieces?auth=true');
			if (!response.ok) return;
			const payload = (await response.json().catch(() => [])) as PieceAuthInfo[];
			if (Array.isArray(payload)) {
				authPieces = payload;
			}
		} finally {
			authPiecesLoaded = true;
			authLoading = false;
		}
	}

	// -----------------------------------------------------------------------
	// Connection tri-state (pinned at top — AP builder pattern)
	//
	// Data source: /api/mcp-connections/catalog — per-piece ACTIVE,
	// project-scoped app connections + requiresAuth/isOAuth2/oauthAppConfigured.
	// -----------------------------------------------------------------------

	function normalizePieceKey(value: string): string {
		return value
			.trim()
			.toLowerCase()
			.replace(/^@activepieces\/piece-/, '')
			.replace(/[_\s]+/g, '-')
			.replace(/-+/g, '-');
	}

	let pieceCatalogEntries = $state<PieceCatalogEntry[]>([]);
	let pieceCatalogLoaded = $state(false);
	let pieceCatalogLoading = $state(false);
	let pieceCatalogError = $state<string | null>(null);

	async function loadPieceCatalog() {
		if (pieceCatalogLoading) return;
		pieceCatalogLoading = true;
		pieceCatalogError = null;
		try {
			const response = await fetch('/api/mcp-connections/catalog');
			const payload = (await response.json().catch(() => null)) as
				| { entries?: PieceCatalogEntry[] }
				| null;
			if (!response.ok || !Array.isArray(payload?.entries)) {
				pieceCatalogError = `HTTP ${response.status}`;
				return;
			}
			pieceCatalogEntries = payload.entries;
			pieceCatalogLoaded = true;
		} catch (error) {
			pieceCatalogError = error instanceof Error ? error.message : String(error);
		} finally {
			pieceCatalogLoading = false;
		}
	}

	let pieceEntry = $derived.by(() => {
		const key = normalizePieceKey(resolvedPieceName);
		return (
			pieceCatalogEntries.find((entry) => normalizePieceKey(entry.pieceName) === key) ?? null
		);
	});
	let pieceShortName = $derived(normalizePieceKey(resolvedPieceName));
	let integrationHref = $derived(
		`/workspaces/${workspaceSlug}/connections/${encodeURIComponent(pieceShortName)}`,
	);

	function authValueOf(values: Record<string, unknown>): string | null {
		const current = values.auth;
		return typeof current === 'string' && current.trim() ? current : null;
	}

	function extractConnectionExternalId(value: string | null): string | null {
		if (!value) return null;
		const match = value.match(/connections\['([^']+)'\]/);
		if (match) return match[1];
		return value.startsWith('{{') ? null : value;
	}

	let selectedAuthValue = $derived(authValueOf(inputValues));
	let selectedConnectionExternalId = $derived(extractConnectionExternalId(selectedAuthValue));
	let selectedConnection = $derived(
		pieceEntry?.appConnections.find(
			(connection) => connection.externalId === selectedConnectionExternalId,
		) ?? null,
	);

	type ConnectionState =
		| 'loading'
		| 'connected'
		| 'unresolved'
		| 'choose'
		| 'connect-required'
		| 'oauth-app-missing'
		| 'unknown';

	let connectionState = $derived.by((): ConnectionState => {
		if (!pieceCatalogLoaded && pieceCatalogLoading) return 'loading';
		if (!pieceCatalogLoaded || !pieceEntry) return 'unknown';
		if (selectedConnection) return 'connected';
		if (selectedConnectionExternalId) return 'unresolved';
		if (pieceEntry.appConnections.length > 0) return 'choose';
		if (pieceEntry.isOAuth2 && !pieceEntry.oauthAppConfigured) return 'oauth-app-missing';
		return 'connect-required';
	});

	function updateAuthConnection(externalId: string | null) {
		const next = { ...inputValues };
		if (!externalId) {
			delete next.auth;
		} else {
			next.auth = `{{connections['${externalId}']}}`;
		}
		updateInput(next);
	}

	// Refresh connections when the user returns from connecting in another tab.
	$effect(() => {
		if (typeof document === 'undefined') return;
		function onVisibilityChange() {
			if (document.visibilityState === 'visible') {
				void loadPieceCatalog();
			}
		}
		document.addEventListener('visibilitychange', onVisibilityChange);
		return () => document.removeEventListener('visibilitychange', onVisibilityChange);
	});

	// -----------------------------------------------------------------------
	// Dynamic options with cold-start (warming) auto-retry.
	//
	// The /options proxy maps per-piece Knative cold starts to
	// 503 {warming:true}; retry twice with backoff before surfacing an error.
	// -----------------------------------------------------------------------

	const WARMING_RETRY_DELAYS_MS = [2500, 5000];

	async function resolveOptions(
		fieldKey: string,
		payload: {
			input: Record<string, unknown>;
			authValue?: string | null;
			connectionExternalId?: string | null;
			searchValue?: string;
			onStatus?: (message: string | null) => void;
		},
	) {
		if (!actionId) return null;
		const requestBody = JSON.stringify({
			field: fieldKey,
			param: fieldKey,
			input: payload.input,
			authValue: payload.authValue,
			connectionExternalId: payload.connectionExternalId,
			searchValue: payload.searchValue,
		});

		for (let attempt = 0; attempt <= WARMING_RETRY_DELAYS_MS.length; attempt += 1) {
			const response = await fetch(`/api/action-catalog/${encodeURIComponent(actionId)}/options`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: requestBody,
			});
			const data = (await response.json().catch(() => null)) as
				| {
						warming?: boolean;
						error?: string;
						options?: Array<{ label: string; value: unknown }>;
						disabled?: boolean;
						placeholder?: string;
				  }
				| null;

			const warming = response.status === 503 && data?.warming === true;
			if (!warming) {
				payload.onStatus?.(null);
				if (!response.ok) {
					throw new Error(data?.error || `HTTP ${response.status}`);
				}
				return data;
			}

			if (attempt < WARMING_RETRY_DELAYS_MS.length) {
				payload.onStatus?.(`Warming up ${authLabel} service… retrying`);
				await new Promise((resolve) => setTimeout(resolve, WARMING_RETRY_DELAYS_MS[attempt]));
			}
		}

		payload.onStatus?.(null);
		throw new Error(
			`The ${authLabel} piece service is still warming up — use Refresh in a few seconds.`,
		);
	}

	// -----------------------------------------------------------------------
	// Test step — one-off execution of the configured action with the current
	// inputs via the existing /api/action-catalog/[id]/test endpoint (which
	// forwards to the function-router /execute contract).
	// -----------------------------------------------------------------------

	let testState = $state<{
		status: 'idle' | 'running' | 'done' | 'error';
		durationMs: number | null;
		payload: unknown;
		error: string | null;
	}>({ status: 'idle', durationMs: null, payload: null, error: null });

	let testResultData = $derived.by(() => {
		const payload = testState.payload;
		return isRecord(payload) ? payload : null;
	});
	let testTruncatedPreview = $derived.by(() => {
		const data = testResultData?.data;
		if (!isRecord(data)) return null;
		if (data.truncated !== true || typeof data.preview !== 'string') return null;
		return data.preview;
	});

	async function runTest() {
		if (!actionId || testState.status === 'running') return;
		testState = { status: 'running', durationMs: null, payload: null, error: null };
		const startedAt = performance.now();
		try {
			const response = await fetch(`/api/action-catalog/${encodeURIComponent(actionId)}/test`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ input: inputValues }),
			});
			const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
			const elapsed = Math.round(performance.now() - startedAt);
			if (!response.ok) {
				const message =
					(typeof payload?.error === 'string' && payload.error) ||
					(typeof payload?.message === 'string' && payload.message) ||
					`HTTP ${response.status}`;
				testState = { status: 'error', durationMs: elapsed, payload, error: message };
				return;
			}
			const reportedDuration =
				typeof payload?.duration_ms === 'number'
					? payload.duration_ms
					: typeof payload?.durationMs === 'number'
						? payload.durationMs
						: null;
			const failed = payload?.success === false;
			testState = {
				status: failed ? 'error' : 'done',
				durationMs: reportedDuration ?? elapsed,
				payload,
				error: failed
					? (typeof payload?.error === 'string' && payload.error) || 'Action reported failure'
					: null,
			};
		} catch (error) {
			testState = {
				status: 'error',
				durationMs: Math.round(performance.now() - startedAt),
				payload: null,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	$effect(() => {
		void loadAuthPieces();
	});

	$effect(() => {
		if (authRequired && !pieceCatalogLoaded && !pieceCatalogLoading) {
			void loadPieceCatalog();
		}
	});
</script>

<div class="space-y-4">
	<!-- Header: piece logo + action name + version badge + integration link -->
	<Card.Root class="gap-3 p-3">
		<div class="flex items-start justify-between gap-3">
			<div class="space-y-1">
				<div class="flex items-center gap-2">
					<Blocks size={14} class="text-violet-500" />
					<span class="text-xs font-semibold">{catalogFunction.displayName}</span>
					{#if pieceVersion}
						<Badge variant="secondary" class="text-[9px]">v{pieceVersion}</Badge>
					{/if}
				</div>
				<div class="flex items-center gap-1.5">
					<Badge variant="secondary" class="text-[9px]">{authLabel}</Badge>
					<span class="text-[10px] text-muted-foreground">{catalogFunction.actionName}</span>
					{#if category}
						<Badge variant="outline" class="text-[9px]">{category}</Badge>
					{/if}
				</div>
				<a
					href={integrationHref}
					target="_blank"
					rel="noopener noreferrer"
					class="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
				>
					<ExternalLink size={10} />
					Open integration
				</a>
			</div>
			{#if providerIconUrl}
				<Avatar.Root class="h-8 w-8 rounded-md border border-border bg-background">
					<Avatar.Image src={providerIconUrl} alt={authLabel} class="object-contain p-1" />
					<Avatar.Fallback class="rounded-md text-[9px] font-medium">
						{authLabel.slice(0, 1).toUpperCase()}
					</Avatar.Fallback>
				</Avatar.Root>
			{/if}
		</div>
	</Card.Root>

	<!-- Connection — pinned at top with inline tri-state (AP builder pattern) -->
	{#if authRequired}
		<Card.Root class="gap-3 p-3">
			<div class="flex items-center justify-between gap-3">
				<div>
					<p class="text-xs font-semibold">Connection</p>
					<p class="text-[10px] text-muted-foreground">{authLabel}</p>
				</div>
				{#if connectionState === 'loading'}
					<Badge variant="outline" class="gap-1 text-[9px]">
						<Loader2 size={9} class="animate-spin" />
						Checking
					</Badge>
				{:else if connectionState === 'connected'}
					<Badge class="gap-1 border-emerald-500/30 bg-emerald-500/10 text-[9px] text-emerald-500" variant="outline">
						<CheckCircle2 size={9} />
						Connected
					</Badge>
				{:else if connectionState === 'unresolved'}
					<Badge variant="destructive" class="gap-1 text-[9px]">
						<AlertTriangle size={9} />
						Connection not found
					</Badge>
				{:else if connectionState === 'oauth-app-missing'}
					<Badge variant="destructive" class="gap-1 text-[9px]">
						<AlertTriangle size={9} />
						OAuth app missing
					</Badge>
				{:else if connectionState === 'choose'}
					<Badge class="gap-1 border-amber-500/30 bg-amber-500/10 text-[9px] text-amber-500" variant="outline">
						Select a connection
					</Badge>
				{:else if connectionState === 'connect-required'}
					<Badge class="gap-1 border-amber-500/30 bg-amber-500/10 text-[9px] text-amber-500" variant="outline">
						Connect required
					</Badge>
				{/if}
			</div>

			{#if connectionState === 'connected' && selectedConnection}
				<p class="text-[10px] text-muted-foreground">
					Using <span class="font-medium text-foreground">{selectedConnection.displayName}</span>
					<span class="font-mono"> · {selectedConnection.externalId}</span>
				</p>
			{:else if connectionState === 'unresolved'}
				<p class="text-[10px] text-destructive">
					This step references <code>{selectedConnectionExternalId}</code>, which is not an active
					connection in this workspace. Pick another connection or reconnect on the integration page.
				</p>
			{:else if connectionState === 'oauth-app-missing'}
				<p class="text-[10px] text-muted-foreground">
					The platform OAuth app for {authLabel} is not configured, so new connections cannot be
					created yet.
				</p>
			{/if}

			{#if pieceEntry && pieceEntry.appConnections.length > 0}
				<div class="space-y-1.5">
					<Label class="text-xs">Selected connection</Label>
					<Select.Root
						type="single"
						value={selectedConnection?.externalId || ''}
						onValueChange={(value) => updateAuthConnection(value || null)}
					>
						<Select.Trigger class="w-full">
							{selectedConnection
								? selectedConnection.displayName
								: `Select ${authLabel} connection`}
						</Select.Trigger>
						<Select.Content>
							{#each pieceEntry.appConnections as connection (connection.externalId)}
								<Select.Item value={connection.externalId}>
									{connection.displayName}
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>
			{/if}

			{#if connectionState === 'connect-required' || connectionState === 'oauth-app-missing' || connectionState === 'unresolved'}
				<div class="rounded-md border border-dashed border-border bg-muted/30 p-3 text-center">
					<a
						href={integrationHref}
						target="_blank"
						rel="noopener noreferrer"
						title="Connecting opens the integration page in a new tab — the canvas stays open; this panel refreshes when you return."
						class="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
					>
						<ExternalLink size={11} />
						{connectionState === 'oauth-app-missing'
							? `Configure ${authLabel} OAuth app`
							: `Connect ${authLabel}`}
					</a>
					<p class="mt-1.5 text-[9px] text-muted-foreground">
						Opens the integration page in a new tab — finish connecting there, then return; this
						panel refreshes automatically.
					</p>
				</div>
			{/if}

			<Input
				value={selectedAuthValue || ''}
				oninput={(event) => {
					const raw = event.currentTarget.value;
					const next = { ...inputValues };
					if (raw.trim()) next.auth = raw;
					else delete next.auth;
					updateInput(next);
				}}
				placeholder={"Or paste raw auth value / {{connections['…']}} template"}
				class="text-xs"
			/>
			{#if pieceCatalogError}
				<p class="text-[10px] text-destructive">Failed to load connections: {pieceCatalogError}</p>
			{/if}
		</Card.Root>
	{/if}

	<ResourceAwareSchemaConfig
		{schema}
		values={inputValues}
		onChange={updateInput}
		title="Action inputs"
		description="These values are persisted into taskConfig.with.body.input."
		authPieceName={resolvedPieceName}
		authLabel={authLabel}
		authRequired={authRequired}
		showConnectionPicker={false}
		{resourceTypes}
		{dynamicInputs}
		resolveOptions={resolveOptions}
	/>

	<!-- Test step — run the configured action once with the current inputs -->
	<Card.Root class="gap-3 p-3">
		<div class="flex items-center justify-between gap-3">
			<div>
				<p class="text-xs font-semibold">Test step</p>
				<p class="text-[10px] text-muted-foreground">
					Runs this action once with the inputs above.
				</p>
			</div>
			<Button
				variant="secondary"
				size="sm"
				class="h-7 gap-1.5 px-2.5 text-[11px]"
				onclick={runTest}
				disabled={testState.status === 'running'}
			>
				{#if testState.status === 'running'}
					<Loader2 size={11} class="animate-spin" />
					Running…
				{:else}
					<Play size={11} />
					Test step
				{/if}
			</Button>
		</div>

		{#if authRequired && connectionState !== 'connected' && testState.status === 'idle'}
			<p class="text-[10px] text-amber-500">
				This action requires a connection — select one above before testing.
			</p>
		{/if}

		{#if testState.status === 'done' || testState.status === 'error'}
			<div class="flex items-center gap-1.5">
				<Badge
					variant={testState.status === 'error' ? 'destructive' : 'outline'}
					class={testState.status === 'error'
						? 'text-[9px]'
						: 'border-emerald-500/30 bg-emerald-500/10 text-[9px] text-emerald-500'}
				>
					{testState.status === 'error' ? 'Failed' : 'Success'}
				</Badge>
				{#if testState.durationMs !== null}
					<span class="text-[10px] text-muted-foreground">{testState.durationMs} ms</span>
				{/if}
			</div>
			{#if testState.error}
				<p class="text-[10px] text-destructive">{testState.error}</p>
			{/if}
			{#if testTruncatedPreview !== null}
				<div class="space-y-1">
					<pre class="max-h-48 overflow-auto rounded-md border border-border bg-muted/30 p-2 text-[10px] whitespace-pre-wrap">{testTruncatedPreview}</pre>
					<p class="text-[10px] text-muted-foreground">
						Result truncated — the full payload was offloaded server-side (piece-execution
						artifact); this is the stored preview.
					</p>
				</div>
			{:else if testState.payload !== null}
				<JsonViewer data={testResultData?.data ?? testState.payload} label="Result" collapsed={false} />
			{/if}
		{/if}
	</Card.Root>
</div>
