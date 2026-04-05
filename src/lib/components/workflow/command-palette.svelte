<script lang="ts">
	import { getContext } from 'svelte';
	import * as Command from '$lib/components/ui/command';
	import { Dialog, DialogContent } from '$lib/components/ui/dialog';
	import { Badge } from '$lib/components/ui/badge';
	import * as Avatar from '$lib/components/ui/avatar';
	import {
		Play, Square, Globe, Variable, GitBranch, Clock, Send, Headphones,
		Repeat, GitFork, Shield, Zap, OctagonAlert, Layers, Search
	} from 'lucide-svelte';
	import { createActionCatalogStore, type ActionCatalogItem } from '$lib/stores/action-catalog.svelte';
	import type { createWorkflowStore, WorkflowNodeType } from '$lib/stores/workflow.svelte';

	interface Props {
		open: boolean;
		onClose: () => void;
		/** If set, the picker is for replacing this node's action */
		replaceNodeId?: string | null;
		/** If set, the new node will be inserted on this edge */
		insertOnEdgeId?: string | null;
		/** Position to place the new node (canvas coordinates) */
		position?: { x: number; y: number } | null;
	}

	let { open, onClose, replaceNodeId = null, insertOnEdgeId = null, position = null }: Props = $props();

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');
	const catalog = createActionCatalogStore();

	let query = $state('');

	const nodeTypes: { type: WorkflowNodeType; label: string; icon: typeof Play; group: string }[] = [
		{ type: 'call', label: 'Call', icon: Globe, group: 'Steps' },
		{ type: 'set', label: 'Set Variable', icon: Variable, group: 'Steps' },
		{ type: 'switch', label: 'Switch / Branch', icon: GitBranch, group: 'Steps' },
		{ type: 'wait', label: 'Wait / Delay', icon: Clock, group: 'Steps' },
		{ type: 'emit', label: 'Emit Event', icon: Send, group: 'Steps' },
		{ type: 'listen', label: 'Listen for Event', icon: Headphones, group: 'Steps' },
		{ type: 'for', label: 'For Loop', icon: Repeat, group: 'Steps' },
		{ type: 'fork', label: 'Fork / Parallel', icon: GitFork, group: 'Steps' },
		{ type: 'try', label: 'Try / Catch', icon: Shield, group: 'Steps' },
		{ type: 'run', label: 'Run Sub-workflow', icon: Zap, group: 'Steps' },
		{ type: 'raise', label: 'Raise Error', icon: OctagonAlert, group: 'Steps' },
		{ type: 'do', label: 'Do Block', icon: Layers, group: 'Steps' },
	];

	// Filter node types when replacing — only show actions, not structural types
	let showNodeTypes = $derived(!replaceNodeId);

	let filteredNodeTypes = $derived.by(() => {
		if (!showNodeTypes) return [];
		if (!query) return nodeTypes;
		const q = query.toLowerCase();
		return nodeTypes.filter(n => n.label.toLowerCase().includes(q) || n.type.includes(q));
	});

	// Catalog actions
	$effect(() => {
		if (open) {
			catalog.load();
			query = '';
		}
	});

	$effect(() => {
		catalog.query = query;
	});

	let catalogActions = $derived.by(() => catalog.filteredItems.slice(0, 50));
	let catalogGroups = $derived.by(() => {
		const map = new Map<string, ActionCatalogItem[]>();
		for (const action of catalogActions) {
			const group = action.providerLabel || action.pieceName || 'Other';
			const list = map.get(group) || [];
			list.push(action);
			map.set(group, list);
		}
		return Array.from(map.entries())
			.map(([group, items]) => ({ group, items }))
			.sort((a, b) => a.group.localeCompare(b.group));
	});

	function getDefaultPosition(): { x: number; y: number } {
		if (position) return position;
		// Default to center of existing nodes, or (250, 200) if no nodes
		const nodes = store.nodes;
		if (nodes.length > 0) {
			const avgX = nodes.reduce((sum, n) => sum + n.position.x, 0) / nodes.length;
			const avgY = nodes.reduce((sum, n) => sum + n.position.y, 0) / nodes.length;
			return { x: avgX + 50, y: avgY + 100 };
		}
		return { x: 250, y: 200 };
	}

	function handleSelectNodeType(type: WorkflowNodeType) {
		const pos = getDefaultPosition();
		if (insertOnEdgeId) {
			store.insertNodeOnEdge(insertOnEdgeId, type, pos);
		} else {
			store.addNode(type, pos, type.charAt(0).toUpperCase() + type.slice(1));
		}
		onClose();
	}

	async function handleSelectAction(action: ActionCatalogItem) {
		if (!action.insertable) return;
		try {
			const response = await fetch(`/api/action-catalog/${encodeURIComponent(action.id)}`);
			if (!response.ok) return;
			const definition = await response.json();

			if (replaceNodeId) {
				// Replace existing node's action
				replaceNode(replaceNodeId, action, definition);
			} else if (insertOnEdgeId) {
				// Insert on edge with the selected action
				const pos = getDefaultPosition();
				const nodeId = store.insertNodeOnEdge(insertOnEdgeId, 'call', pos);
				if (nodeId) {
					applyActionToNode(nodeId, action, definition);
				}
			} else {
				// Add new node
				const pos = getDefaultPosition();
				const nodeId = store.addNode('call', pos, action.displayName);
				applyActionToNode(nodeId, action, definition);
			}
		} catch (err) {
			console.error('Failed to load action:', err);
		}
		onClose();
	}

	function applyActionToNode(nodeId: string, action: ActionCatalogItem, definition: Record<string, unknown>) {
		const actionDefinition = {
			id: action.id,
			name: action.name,
			displayName: action.displayName,
			service: action.service,
			kind: action.kind,
			visibility: action.visibility,
			sourceKind: action.sourceKind,
			version: action.version,
			language: action.language,
			entrypoint: action.entrypoint,
			insertable: action.visibility === 'public-callable',
		};

		const taskConfig = (definition.taskConfig || definition.definition || {}) as Record<string, unknown>;

		store.updateNodeData(nodeId, {
			label: action.displayName,
			taskConfig,
			actionDefinition,
			catalogFunction: action.service === 'fn-activepieces' ? {
				name: action.name,
				displayName: action.displayName,
				pieceName: action.providerId || action.pieceName,
				actionName: action.actionName,
			} : undefined,
			actionCatalogDetail: definition,
		});
	}

	function replaceNode(nodeId: string, action: ActionCatalogItem, definition: Record<string, unknown>) {
		applyActionToNode(nodeId, action, definition);
	}
</script>

<Dialog {open} onOpenChange={(v) => { if (!v) onClose(); }}>
	<DialogContent class="max-w-2xl max-h-[70vh] flex flex-col p-0 gap-0 overflow-hidden">
		<Command.Root class="flex-1 flex flex-col" shouldFilter={false}>
			<div class="flex items-center border-b px-3">
				<Search size={14} class="shrink-0 text-muted-foreground" />
				<Command.Input
					placeholder={replaceNodeId ? 'Search actions to replace...' : 'Search steps, integrations, and actions...'}
					bind:value={query}
					class="h-11 border-0 focus:ring-0 text-sm"
				/>
			</div>

			<Command.List class="flex-1 overflow-y-auto p-2 max-h-[55vh]">
				{#if !query && !replaceNodeId}
					<Command.Group heading="Quick Start">
						<Command.Item value="__call__" onSelect={() => handleSelectNodeType('call')} class="flex items-center gap-2 px-2 py-1.5">
							<div class="rounded p-1 bg-amber-100 text-amber-600 dark:bg-amber-900 dark:text-amber-400">
								<Globe size={14} />
							</div>
							<span class="text-sm">HTTP / API Call</span>
						</Command.Item>
						<Command.Item value="__set__" onSelect={() => handleSelectNodeType('set')} class="flex items-center gap-2 px-2 py-1.5">
							<div class="rounded p-1 bg-purple-100 text-purple-600 dark:bg-purple-900 dark:text-purple-400">
								<Variable size={14} />
							</div>
							<span class="text-sm">Set Variable</span>
						</Command.Item>
						<Command.Item value="__switch__" onSelect={() => handleSelectNodeType('switch')} class="flex items-center gap-2 px-2 py-1.5">
							<div class="rounded p-1 bg-pink-100 text-pink-600 dark:bg-pink-900 dark:text-pink-400">
								<GitBranch size={14} />
							</div>
							<span class="text-sm">Switch / Branch</span>
						</Command.Item>
					</Command.Group>
				{/if}

				{#if filteredNodeTypes.length > 0}
					<Command.Group heading="Steps">
						{#each filteredNodeTypes as nt (nt.type)}
							<Command.Item value={`__${nt.type}__`} onSelect={() => handleSelectNodeType(nt.type)} class="flex items-center gap-2 px-2 py-1.5">
								<nt.icon size={14} class="text-muted-foreground" />
								<span class="text-sm">{nt.label}</span>
							</Command.Item>
						{/each}
					</Command.Group>
				{/if}

				{#if catalog.loading}
					<div class="flex items-center justify-center py-6 text-sm text-muted-foreground">
						Loading integrations...
					</div>
				{:else if catalogGroups.length > 0}
					{#each catalogGroups as group (group.group)}
						<Command.Group heading={group.group}>
							{#each group.items as action (action.id)}
								<Command.Item
									value={action.id}
									onSelect={() => handleSelectAction(action)}
									disabled={!action.insertable}
									class="flex items-start gap-2 px-2 py-1.5"
								>
									{#if action.providerIconUrl}
										<Avatar.Root class="mt-0.5 h-6 w-6 shrink-0 rounded-md border border-border bg-background">
											<Avatar.Image src={action.providerIconUrl} alt="" class="object-contain p-0.5" />
											<Avatar.Fallback class="rounded-md text-[8px]">
												{(action.providerLabel || action.displayName || '?')[0].toUpperCase()}
											</Avatar.Fallback>
										</Avatar.Root>
									{:else}
										<Globe size={14} class="mt-0.5 shrink-0 text-muted-foreground" />
									{/if}
									<div class="min-w-0 flex-1">
										<div class="flex items-center gap-1.5">
											<span class="text-sm">{action.displayName}</span>
											{#if action.version}
												<Badge variant="outline" class="text-[8px] px-1">{action.version}</Badge>
											{/if}
										</div>
										{#if action.description}
											<p class="text-[10px] text-muted-foreground line-clamp-1">{action.description}</p>
										{/if}
									</div>
								</Command.Item>
							{/each}
						</Command.Group>
					{/each}
				{/if}

				{#if query && filteredNodeTypes.length === 0 && catalogGroups.length === 0 && !catalog.loading}
					<Command.Empty>No results for "{query}"</Command.Empty>
				{/if}
			</Command.List>

			<div class="border-t px-3 py-2 text-[10px] text-muted-foreground">
				{#if replaceNodeId}
					Replacing action — edges and position will be preserved
				{:else if insertOnEdgeId}
					Inserting on edge — node will be placed between connected nodes
				{:else}
					<kbd class="rounded border px-1 py-0.5 text-[9px]">⌘K</kbd> to open &middot;
					<kbd class="rounded border px-1 py-0.5 text-[9px]">↑↓</kbd> to navigate &middot;
					<kbd class="rounded border px-1 py-0.5 text-[9px]">↵</kbd> to select
				{/if}
			</div>
		</Command.Root>
	</DialogContent>
</Dialog>
