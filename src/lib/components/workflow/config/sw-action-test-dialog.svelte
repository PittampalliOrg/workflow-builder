<script lang="ts">
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import {
		Dialog,
		DialogContent,
		DialogFooter,
		DialogHeader,
		DialogTitle,
	} from '$lib/components/ui/dialog';
	import { Textarea } from '$lib/components/ui/textarea';
	import ResourceAwareSchemaConfig from './lazy-resource-aware-schema-config.svelte';
	import type { ActionCatalogDetail } from '$lib/stores/action-catalog.svelte';

	interface Props {
		open: boolean;
		action: ActionCatalogDetail | null;
		onClose: () => void;
	}

	let { open = $bindable(), action, onClose }: Props = $props();

	let inputValues = $state<Record<string, unknown>>({});
	let responseState = $state<{
		status: 'idle' | 'running' | 'done' | 'error';
		message: string | null;
		payload: unknown;
	}>({
		status: 'idle',
		message: null,
		payload: null,
	});
	let initializedFor = $state<string | null>(null);

	function isRecord(value: unknown): value is Record<string, unknown> {
		return !!value && typeof value === 'object' && !Array.isArray(value);
	}

	function extractSchema(current: ActionCatalogDetail | null): Record<string, unknown> | null {
		if (!current) return null;
		if (current.inputSchema && typeof current.inputSchema === 'object') {
			return current.inputSchema;
		}
		if (current.definition && typeof current.definition === 'object') {
			const definition = current.definition as Record<string, unknown>;
			const input = definition.input;
			if (input && typeof input === 'object') {
				const schema = (input as { schema?: { document?: Record<string, unknown> } }).schema?.document;
				if (schema && typeof schema === 'object') {
					return schema;
				}
			}
		}
		return null;
	}

	function extractDynamicInputs(current: ActionCatalogDetail | null): Record<
		string,
		{ handler: string; depends_on?: string[]; search?: boolean }
	> {
		const raw = current ? ((current as unknown) as Record<string, unknown>) : null;
		const source =
			(raw?.dynamicInputs as Record<string, { handler: string; depends_on?: string[]; search?: boolean }> | undefined) ||
			(raw?.fieldProviders as Record<string, { handler: string; depends_on?: string[]; search?: boolean }> | undefined) ||
			null;
		return source || {};
	}

	function extractResourceTypes(current: ActionCatalogDetail | null): Record<string, string> {
		const raw = current ? ((current as unknown) as Record<string, unknown>) : null;
		const source =
			(raw?.resourceTypes as Record<string, string> | undefined) ||
			(raw?.fieldResourceTypes as Record<string, string> | undefined) ||
			null;
		return source || {};
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
		if (!action) return null;
		const response = await fetch(`/api/action-catalog/${encodeURIComponent(action.id)}/options`, {
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

	function extractInitialValues(current: ActionCatalogDetail | null): Record<string, unknown> {
		const values =
			current?.taskConfig &&
			typeof current.taskConfig === 'object' &&
			current.taskConfig.with &&
			typeof current.taskConfig.with === 'object'
				? ((current.taskConfig.with as Record<string, unknown>).body as Record<string, unknown> | undefined)
				: undefined;
		const input = values && isRecord(values.input) ? (values.input as Record<string, unknown>) : {};
		return { ...input };
	}

	function previewPayload(): Record<string, unknown> {
		return {
			action: action
				? {
						id: action.id,
						displayName: action.displayName,
						service: action.service,
						kind: action.kind,
						sourceKind: action.sourceKind,
						visibility: action.visibility,
						version: action.version,
				  }
				: null,
			input: inputValues,
			taskConfig: action?.taskConfig ?? null,
			definition: action?.definition ?? null,
		};
	}

	async function copyPreview() {
		if (!navigator.clipboard) return;
		await navigator.clipboard.writeText(JSON.stringify(previewPayload(), null, 2));
		responseState = {
			status: 'done',
			message: 'Payload copied to clipboard.',
			payload: previewPayload(),
		};
	}

	async function runTest() {
		if (!action) return;
		responseState = {
			status: 'running',
			message: 'Executing action...',
			payload: null,
		};

		try {
			const response = await fetch(`/api/action-catalog/${encodeURIComponent(action.id)}/test`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ input: inputValues }),
			});
			const payload = await response.json().catch(() => null);
			if (!response.ok) {
				throw new Error((payload as { error?: string } | null)?.error || `HTTP ${response.status}`);
			}
			responseState = {
				status: 'done',
				message: 'Execution completed.',
				payload,
			};
		} catch (error) {
			responseState = {
				status: 'error',
				message: error instanceof Error ? error.message : String(error),
				payload: null,
			};
		}
	}

	$effect(() => {
		if (!open || !action) {
			if (!open) {
				responseState = { status: 'idle', message: null, payload: null };
			}
			return;
		}

		if (initializedFor === action.id) return;
		initializedFor = action.id;
		inputValues = extractInitialValues(action);
		responseState = { status: 'idle', message: null, payload: null };
	});

	$effect(() => {
		if (!open) {
			initializedFor = null;
		}
	});

	let schema = $derived(extractSchema(action));
	let resourceTypes = $derived(extractResourceTypes(action));
	let dynamicInputs = $derived(extractDynamicInputs(action));
	let canExecute = $derived(Boolean(action?.insertable));
	let preview = $derived(previewPayload());
	let previewJson = $derived(JSON.stringify(preview, null, 2));
	let responseJson = $derived(
		responseState.payload ? JSON.stringify(responseState.payload, null, 2) : '',
	);
	const dialogTitle = $derived(
		action ? `Test ${action.displayName}` : 'Test Action',
	);
</script>

<Dialog {open} onOpenChange={(next) => !next && onClose()}>
	<DialogContent class="max-h-[90vh] overflow-hidden sm:max-w-4xl">
		<DialogHeader>
			<DialogTitle>{dialogTitle}</DialogTitle>
		</DialogHeader>

		{#if action}
			<div class="flex flex-wrap items-center gap-1.5">
				<Badge variant="outline" class="text-[9px]">{action.service}</Badge>
				<Badge variant="secondary" class="text-[9px]">{action.kind}</Badge>
				<Badge variant="outline" class="text-[9px]">{action.visibility}</Badge>
				{#if action.language}
					<Badge variant="outline" class="text-[9px]">{action.language}</Badge>
				{/if}
			</div>

			<div class="grid gap-4 py-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
				<div class="min-h-0 overflow-auto pr-1">
					<ResourceAwareSchemaConfig
						schema={schema}
						values={inputValues}
						onChange={(next: Record<string, unknown>) => {
							inputValues = next;
						}}
						title="Test input"
						description={canExecute
							? 'This payload will be sent to the executor.'
							: 'This payload previews the SW-compatible input shape.'}
						authPieceName={action?.providerId ?? action?.pieceName ?? null}
						authLabel={action?.providerLabel ?? action?.pieceName ?? null}
						{resourceTypes}
						{dynamicInputs}
						{resolveOptions}
					/>
				</div>

				<div class="space-y-3">
					<div class="rounded-lg border border-border/70 p-3">
						<div class="flex items-center justify-between gap-3">
							<p class="text-xs font-semibold">Preview payload</p>
							<Button variant="ghost" size="sm" class="h-7 px-2 text-[10px]" onclick={copyPreview}>
								Copy
							</Button>
						</div>
						<Textarea
							class="mt-2 font-mono text-[11px]"
							rows={12}
							value={previewJson}
							readonly
						/>
					</div>

					{#if responseState.status !== 'idle'}
						<div class="rounded-lg border border-border/70 p-3">
							<div class="flex items-center justify-between gap-3">
								<p class="text-xs font-semibold">Result</p>
								<Badge
									variant={responseState.status === 'error' ? 'destructive' : 'secondary'}
									class="text-[9px]"
								>
									{responseState.status}
								</Badge>
							</div>
							{#if responseState.message}
								<p class="mt-2 text-[10px] text-muted-foreground">{responseState.message}</p>
							{/if}
							{#if responseJson}
								<Textarea
									class="mt-2 font-mono text-[11px]"
									rows={10}
									value={responseJson}
									readonly
								/>
							{/if}
						</div>
					{/if}

					{#if !canExecute}
						<Alert>
							<AlertDescription class="text-[11px]">
								This action is inspect-only or does not currently expose an executable SW-compatible projection. Use the preview payload to validate the generated SW 1.0-compatible node config.
							</AlertDescription>
						</Alert>
					{/if}
				</div>
			</div>
		{/if}

		<DialogFooter class="gap-2">
			<Button variant="outline" onclick={onClose}>Close</Button>
			{#if canExecute}
				<Button variant="secondary" onclick={runTest} disabled={responseState.status === 'running'}>
					{responseState.status === 'running' ? 'Running...' : 'Run Test'}
				</Button>
			{:else}
				<Button variant="secondary" onclick={copyPreview}>Copy Payload</Button>
			{/if}
		</DialogFooter>
	</DialogContent>
</Dialog>
