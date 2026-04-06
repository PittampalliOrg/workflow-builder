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
		addTask as specAddTask,
		getTask,
		getTaskNames,
		generateTaskName,
	} from '$lib/helpers/spec-mutations';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');

	// Current selected node
	const node = $derived(store.selectedNode);

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

	// Fetch catalog + connections on mount (cached for the component lifetime)
	onMount(async () => {
		try {
			const [catalogRes, connRes] = await Promise.all([
				fetch('/api/action-catalog'),
				fetch('/api/app-connections'),
			]);
			if (catalogRes.ok) {
				const data = await catalogRes.json();
				allCatalogItems = (data.items || []).filter((i: CatalogAction) => i.insertable);
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

	// Catalog action is ALWAYS derived from callValue + catalog items — never manually set
	const catalogAction = $derived.by(() => {
		if (!catalogLoaded || !callValue || allCatalogItems.length === 0) return null;
		const [callPiece, callAction] = callValue.split('/');
		return allCatalogItems.find((a) => {
			if (`${a.pieceName}/${a.actionName}` === callValue) return true;
			if (a.name === callValue) return true;
			if (callPiece && callAction && a.pieceName === callPiece) {
				const stripped = a.actionName.startsWith(a.pieceName + '-')
					? a.actionName.slice(a.pieceName.length + 1)
					: a.actionName;
				if (stripped === callAction) return true;
			}
			return false;
		}) || null;
	});

	// Reset showSelector when switching to a different node
	$effect(() => {
		if (node?.id) showSelector = false;
	});

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

	// Strip action name prefix for the call value (gmail-send_email → send_email)
	function cleanActionName(actionName: string, piece: string): string {
		return actionName.startsWith(piece + '-') ? actionName.slice(piece.length + 1) : actionName;
	}

	// Update action when selected from catalog
	function handleActionSelect(action: CatalogAction) {
		if (!node || !store.spec) return;

		const piece = action.pieceName;
		const cleanAct = cleanActionName(action.actionName, piece);
		const newCall = `${piece}/${cleanAct}`;

		// Find matching connection
		const conn = connections.find((c) => {
			const shortName = c.pieceName.replace('@activepieces/piece-', '').replace(/^@.*\//, '');
			return shortName === piece;
		});

		const newTaskDef = {
			call: newCall,
			with: {
				...(conn ? { connectionExternalId: conn.externalId } : {}),
				body: {
					input: {},
					metadata: { pieceName: piece, actionName: cleanAct },
				},
			},
		};

		// Check if this task exists in the spec
		const existing = getTask(store.spec, taskName);
		let newSpec: Record<string, unknown>;
		if (existing) {
			// Update existing task
			newSpec = specUpdateTask(store.spec, taskName, newTaskDef);
		} else {
			// Task not in spec — generate a name and add it
			const name = generateTaskName(action.displayName, getTaskNames(store.spec));
			newSpec = specAddTask(store.spec, name, newTaskDef);
		}

		store.applySpecAndRebuild(newSpec);
		showSelector = false; // Switch back to config form view
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
			schema={catalogAction?.inputSchema as Record<string, unknown> | null}
			values={inputValues}
			onChange={handleInputChange}
			{connectionExternalId}
			onConnectionChange={handleConnectionChange}
			{connections}
			{pieceName}
		/>
	</div>
{/if}
