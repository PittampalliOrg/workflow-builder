<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import * as Avatar from '$lib/components/ui/avatar';
	import * as Card from '$lib/components/ui/card';
	import { Blocks } from 'lucide-svelte';
	import ResourceAwareSchemaConfig from './resource-aware-schema-config.svelte';

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

	let withConfig = $derived((taskConfig.with as Record<string, unknown>) || {});
	let body = $derived((withConfig.body as Record<string, unknown>) || {});
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

	async function resolveOptions(
		fieldKey: string,
		payload: {
			input: Record<string, unknown>;
			authValue?: string | null;
			connectionExternalId?: string | null;
			searchValue?: string;
		},
	) {
		if (!actionId) return null;
		const response = await fetch(`/api/action-catalog/${encodeURIComponent(actionId)}/options`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				field: fieldKey,
				param: fieldKey,
				...payload,
			}),
		});
		const data = await response.json().catch(() => null);
		if (!response.ok) {
			throw new Error((data as { error?: string } | null)?.error || `HTTP ${response.status}`);
		}
		return data as {
			options?: Array<{ label: string; value: unknown }>;
			disabled?: boolean;
			placeholder?: string;
		} | null;
	}

	$effect(() => {
		void loadAuthPieces();
	});
</script>

<div class="space-y-4">
	<Card.Root class="gap-3 p-3">
		<div class="flex items-start justify-between gap-3">
			<div class="space-y-1">
				<div class="flex items-center gap-2">
					<Blocks size={14} class="text-violet-500" />
					<span class="text-xs font-semibold">{catalogFunction.displayName}</span>
				</div>
				<div class="flex items-center gap-1.5">
					<Badge variant="secondary" class="text-[9px]">{authLabel}</Badge>
					<span class="text-[10px] text-muted-foreground">{catalogFunction.actionName}</span>
					{#if category}
						<Badge variant="outline" class="text-[9px]">{category}</Badge>
					{/if}
				</div>
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
		{#if authRequired}
			<p class="text-[10px] text-muted-foreground">
				This action uses the selected connection stored in the `auth` field.
			</p>
		{/if}
	</Card.Root>

	<ResourceAwareSchemaConfig
		{schema}
		values={inputValues}
		onChange={updateInput}
		title="Action inputs"
		description="These values are persisted into taskConfig.with.body.input."
		authPieceName={(actionDetail?.providerId as string | undefined) || catalogFunction.pieceName}
		authLabel={authLabel}
		authRequired={authRequired}
		{resourceTypes}
		{dynamicInputs}
		resolveOptions={resolveOptions}
	/>
</div>
