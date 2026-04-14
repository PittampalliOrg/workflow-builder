<script lang="ts">
	/**
	 * Action Properties — two-state rendering inside the Properties tab.
	 *
	 * State 1: No action configured → shows ActionSelector (catalog browser)
	 * State 2: Action configured → shows config form with Service/Action header
	 *
	 * Modeled after Vercel workflow-builder-template's action-config + action-grid pattern.
	 */
	import { getContext, onMount } from 'svelte';
	import { ArrowLeft, ExternalLink } from 'lucide-svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Separator } from '$lib/components/ui/separator';
	import * as Select from '$lib/components/ui/select';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import ActionSelector, { type CatalogAction } from './action-selector.svelte';
	import ActionConfigForm from './action-config-form.svelte';
	import {
		updateTask as specUpdateTask,
		getTask,
	} from '$lib/helpers/spec-mutations';
	import type { ActionCatalogItem } from '$lib/stores/action-catalog.svelte';
	import {
		getNodeIdForTaskName,
		insertActionTask,
		replaceActionTask,
	} from '$lib/helpers/workflow-action-spec';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');

	// Current selected node
	const node = $derived(store.selectedNode);

	// Extract task name from node ID.
	// SDK buildGraph() produces IDs like "/do/0/send-email" — task name is the last segment.
	// For canvas-created nodes, ID is a UUID which won't match a task name.
	const taskName = $derived.by(() => {
		const id = node?.id || '';
		if (id.startsWith('/do/')) {
			// SDK node ID: "/do/0/send-email" → "send-email"
			const parts = id.split('/');
			return parts[parts.length - 1];
		}
		return id;
	});

	// Read task definition from the SPEC (source of truth), not from node data
	const specTask = $derived.by(() => {
		if (!store.spec || !taskName) return null;
		return getTask(store.spec, taskName);
	});

	const callValue = $derived((specTask?.call || '') as string);
	const hasAction = $derived(!!callValue && callValue !== '');

	// Parse piece/action from call value (e.g., "gmail/send_email")
	const pieceName = $derived(callValue.includes('/') ? callValue.split('/')[0] : '');
	const actionName = $derived(callValue.includes('/') ? callValue.split('/')[1] : callValue);

	function asRecord(value: unknown): Record<string, unknown> | null {
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	}

	function unwrapSchema(value: unknown): Record<string, unknown> | null {
		const record = asRecord(value);
		if (!record) return null;
		const document = asRecord(record.document);
		if (document) return document;
		return record;
	}

	// Extract input values from the spec task's with block
	const inputValues = $derived.by(() => {
		if (!specTask) return {};
		const withBlock = specTask.with as Record<string, unknown> | undefined;
		if (!withBlock) return {};
		const body = withBlock.body as Record<string, unknown> | undefined;
		return (withBlock.input || body?.input || {}) as Record<string, unknown>;
	});

	const connectionExternalId = $derived.by(() => {
		if (!specTask) return null;
		const withBlock = specTask.with as Record<string, unknown> | undefined;
		return (withBlock?.connectionExternalId || null) as string | null;
	});

	// Catalog data
	let allCatalogItems = $state<CatalogAction[]>([]);
	let connections = $state<Array<{ pieceName: string; externalId: string; displayName: string }>>([]);
	let catalogLoaded = $state(false);
	let showSelector = $state(false); // Toggle to show action selector instead of config form
	let catalogAction = $state<CatalogAction | null>(null);
	let catalogDetail = $state<Record<string, unknown> | null>(null);
	let catalogDetailActionId = $state<string | null>(null);
	let catalogDetailLoadingId = $state<string | null>(null);

	// Fetch catalog + connections on mount (cached for the component lifetime)
	onMount(async () => {
		try {
			const [catalogRes, connRes] = await Promise.all([
				fetch('/api/action-catalog'),
				fetch('/api/app-connections'),
			]);
			if (catalogRes.ok) {
				const data = await catalogRes.json();
				allCatalogItems = data.items || [];
			}
			if (connRes.ok) {
				const connData = await connRes.json();
				connections = (Array.isArray(connData) ? connData : connData.connections || [])
					.filter((c: Record<string, unknown>) => c.status === 'ACTIVE')
					.map((c: Record<string, unknown>) => ({
						pieceName: c.pieceName as string,
						externalId: c.externalId as string,
						displayName: (c.displayName || c.pieceName) as string,
					}));
			}
		} catch {
			// Silently fail
		} finally {
			catalogLoaded = true;
		}
	});

	function resolveCatalogAction(
		items: CatalogAction[],
		call: string,
		providerHint: string,
	): CatalogAction | null {
		if (!call || items.length === 0) return null;
		const nodeData = asRecord(node?.data);
		const actionDefinition = asRecord(nodeData?.actionDefinition);
		const actionCatalogDetail = asRecord(nodeData?.actionCatalogDetail);
		const metadataActionId =
			(typeof actionDefinition?.id === 'string' && actionDefinition.id) ||
			(typeof actionCatalogDetail?.id === 'string' && actionCatalogDetail.id) ||
			null;
		if (metadataActionId) {
			const metadataMatch = items.find((a) => a.id === metadataActionId);
			if (metadataMatch) return metadataMatch;
		}

		const [callPiece, callAction] = call.split('/');
		const matches = items.filter((a) => {
			const piece = typeof a.pieceName === 'string' ? a.pieceName : '';
			const action = typeof a.actionName === 'string' ? a.actionName : '';
			const slug = typeof a.slug === 'string' ? a.slug : '';
			const name = typeof a.name === 'string' ? a.name : '';
			const taskConfigCall = asRecord(a.taskConfig)?.call;
			const candidates = [
				piece && action ? `${piece}/${action}` : null,
				slug,
				name,
				typeof taskConfigCall === 'string' ? taskConfigCall : null,
			].filter(Boolean);
			if (candidates.includes(call)) return true;
			if (callPiece && callAction && piece === callPiece && action) {
				const stripped = action.startsWith(`${piece}/`)
					? action.slice(piece.length + 1)
					: action.startsWith(piece + '-')
						? action.slice(piece.length + 1)
						: action;
				if (stripped === callAction) return true;
			}
			return false;
		});
		if (matches.length <= 1) return matches[0] || null;

		const componentName = providerHint.toLowerCase();
		if (componentName) {
			const providerMatch = matches.find((a) => {
				const haystack = `${a.id} ${a.name} ${a.displayName}`.toLowerCase();
				return (
					(componentName.includes('openai') && haystack.includes('openai')) ||
					(componentName.includes('anthropic') && haystack.includes('anthropic'))
				);
			});
			if (providerMatch) return providerMatch;
		}

		return matches[0] || null;
	}

	$effect(() => {
		catalogAction = catalogLoaded
			? resolveCatalogAction(allCatalogItems, callValue, String(inputValues.componentName ?? ''))
			: null;
	});

	async function loadCatalogDetail(actionId: string) {
		const requestId = actionId;
		catalogDetailActionId = requestId;
		catalogDetailLoadingId = requestId;
		catalogDetail = null;
		try {
			const response = await fetch(`/api/action-catalog/${encodeURIComponent(actionId)}`);
			if (!response.ok || catalogDetailActionId !== requestId) return;
			const detail = await response.json();
			if (catalogDetailActionId === requestId && detail && typeof detail === 'object' && !Array.isArray(detail)) {
				catalogDetail = detail as Record<string, unknown>;
			}
		} catch {
			if (catalogDetailActionId === requestId) catalogDetail = null;
		} finally {
			if (catalogDetailLoadingId === requestId) catalogDetailLoadingId = null;
		}
	}

	$effect(() => {
		const actionId = catalogAction?.id || null;
		if (!actionId) {
			catalogDetailActionId = null;
			catalogDetailLoadingId = null;
			catalogDetail = null;
			return;
		}
		if (catalogDetailActionId === actionId && catalogDetail) return;
		if (catalogDetailLoadingId === actionId) return;
		void loadCatalogDetail(actionId);
	});

	const effectiveInputSchema = $derived.by(() => {
		const nodeData = (node?.data || {}) as Record<string, unknown>;
		const detail = asRecord(nodeData.actionCatalogDetail);
		const loadedDetail = asRecord(catalogDetail);
		const definition = asRecord(loadedDetail?.definition) || asRecord(detail?.definition);
		const taskConfigValue = asRecord(nodeData.taskConfig) || specTask;

		return (
			unwrapSchema(catalogAction?.inputSchema) ||
			unwrapSchema(loadedDetail?.inputSchema) ||
			unwrapSchema(detail?.inputSchema) ||
			unwrapSchema(asRecord(asRecord(definition?.input)?.schema)?.document) ||
			unwrapSchema(asRecord(asRecord(loadedDetail?.taskConfig)?.input)?.schema) ||
			unwrapSchema(asRecord(asRecord(taskConfigValue?.input)?.schema)?.document) ||
			null
		);
	});

	// Reset showSelector when switching to a different node
	$effect(() => {
		if (node?.id) showSelector = false;
	});

	// Update action when selected from catalog
	async function handleActionSelect(action: CatalogAction) {
		if (!node) return;

		try {
			const response = await fetch(`/api/action-catalog/${encodeURIComponent(action.id)}`);
			if (!response.ok) return;
			const definition = await response.json();
			const catalogAction = action as unknown as ActionCatalogItem;
			const existing = store.spec ? getTask(store.spec, taskName) : null;
			const projection = existing
				? replaceActionTask(store.spec, store.workflowName, taskName, catalogAction, definition)
				: insertActionTask(store.spec, store.workflowName, catalogAction, definition);

			store.setTaskMetadata(projection.taskName, projection.metadata);
			await store.applySpecAndRebuild(projection.spec);
			store.selectedNodeId = getNodeIdForTaskName(store.nodes, projection.taskName);
			showSelector = false; // Switch back to config form view
		} catch (error) {
			console.error('Failed to apply action selection:', error);
		}
	}

	// Update input values — updates spec WITHOUT rebuilding graph (no structural change)
	// This prevents the edit→rebuild→deselect→form-unmount loop
	function handleInputChange(newValues: Record<string, unknown>) {
		if (!node || !store.spec || !taskName) return;
		const existing = getTask(store.spec, taskName);
		if (!existing) return;

		const withBlock = (existing.with || {}) as Record<string, unknown>;
		const body = (withBlock.body || {}) as Record<string, unknown>;

		const newSpec = specUpdateTask(store.spec, taskName, {
			...existing,
			with: {
				...withBlock,
				body: { ...body, input: newValues },
			},
		});
		// Update spec without graph rebuild (structure unchanged, just field values)
		store.spec = newSpec;
		store.isDirty = true;
	}

	function handleConnectionChange(connId: string) {
		if (!node || !store.spec || !taskName) return;
		const existing = getTask(store.spec, taskName);
		if (!existing) return;

		const withBlock = (existing.with || {}) as Record<string, unknown>;
		const newSpec = specUpdateTask(store.spec, taskName, {
			...existing,
			with: { ...withBlock, connectionExternalId: connId },
		});
		// Update spec without graph rebuild (structure unchanged)
		store.spec = newSpec;
		store.isDirty = true;
	}

	function handleLabelChange(label: string) {
		if (!node || !store.spec || !taskName) return;
		// Renaming a task means changing the key in the spec's do[] array
		// For now, just update the node's display label (doesn't affect spec task name)
		store.updateNodeData(node.id, { label });
	}

	function changeAction() {
		showSelector = true;
	}
</script>

{#if !node}
	<div class="flex items-center justify-center py-8 text-xs text-muted-foreground">
		Select a node to configure
	</div>
{:else if !hasAction || showSelector}
	<!-- Action selector: shown when no action configured OR user clicked "change action" -->
	<div class="flex h-full flex-col">
		<div class="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
			{#if hasAction}
				<Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" onclick={() => showSelector = false}>
					<ArrowLeft size={10} />
				</Button>
				<span>Change action for <strong>{taskName}</strong></span>
			{:else}
				<span>Select an action for this step:</span>
			{/if}
		</div>
		<ActionSelector onSelect={handleActionSelect} />
	</div>
{:else}
	<!-- Action configured → Show config form -->
	<div class="flex h-full flex-col overflow-y-auto">
		<!-- Action header -->
		<div class="flex items-center gap-2 border-b border-border px-3 py-2">
			<Button
				variant="ghost"
				size="icon"
				class="h-6 w-6 shrink-0"
				onclick={changeAction}
			>
				<ArrowLeft size={12} />
			</Button>

			{#if catalogAction?.providerIconUrl}
				<img
					src={catalogAction.providerIconUrl as string}
					alt=""
					class="h-5 w-5 rounded-sm shrink-0"
				/>
			{/if}

			<div class="min-w-0 flex-1">
				<div class="text-xs font-medium truncate">
					{catalogAction?.displayName || actionName}
				</div>
				<div class="text-[10px] text-muted-foreground truncate">
					{pieceName}/{actionName}
				</div>
			</div>
		</div>

		<!-- Label -->
		<div class="space-y-1.5 px-3 pt-3">
			<Label class="text-[11px] text-muted-foreground">Label</Label>
			<Input
				value={String((node?.data as Record<string, unknown>)?.label || taskName)}
				oninput={(e) => handleLabelChange(e.currentTarget.value)}
				class="h-8 text-xs"
			/>
		</div>

		<Separator class="my-3" />

		<!-- Config form from schema -->
		<ActionConfigForm
			schema={effectiveInputSchema}
			values={inputValues}
			onChange={handleInputChange}
			{connectionExternalId}
			onConnectionChange={handleConnectionChange}
			{connections}
			{pieceName}
		/>
	</div>
{/if}
