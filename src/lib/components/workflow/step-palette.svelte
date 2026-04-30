<script lang="ts">
	import { Panel, useSvelteFlow } from '@xyflow/svelte';
	import { getContext } from 'svelte';
	import {
		Play,
		Square,
		Globe,
		Variable,
		GitBranch,
		Clock,
		Send,
		Headphones,
		Repeat,
		GitFork,
		Shield,
		Zap,
		OctagonAlert,
		Layers,
		ChevronRight,
		ChevronLeft,
		Blocks,
		Bot
	} from '@lucide/svelte';
	import { Separator } from '$lib/components/ui/separator';
	import FunctionBrowser from './function-browser.svelte';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import type { WorkflowNodeType } from '$lib/stores/workflow.svelte';
	import type { ActionCatalogItem } from '$lib/stores/action-catalog.svelte';
	import {
		getNodeIdForTaskName,
		insertActionTask,
	} from '$lib/helpers/workflow-action-spec';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');
	const { screenToFlowPosition } = useSvelteFlow();

	let expanded = $state(false);
	let showFunctionBrowser = $state(false);

	const nodeDefinitions: {
		type: WorkflowNodeType;
		label: string;
		icon: typeof Play;
		color: string;
	}[] = [
		{ type: 'start', label: 'Start', icon: Play, color: 'bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-400' },
		{ type: 'end', label: 'End', icon: Square, color: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
		{ type: 'call', label: 'Call', icon: Globe, color: 'bg-amber-100 text-amber-600 dark:bg-amber-900 dark:text-amber-400' },
		{ type: 'agent', label: 'dapr-agent-py', icon: Bot, color: 'bg-cyan-100 text-cyan-600 dark:bg-cyan-900 dark:text-cyan-400' },
		{ type: 'set', label: 'Set', icon: Variable, color: 'bg-purple-100 text-purple-600 dark:bg-purple-900 dark:text-purple-400' },
		{ type: 'switch', label: 'Switch', icon: GitBranch, color: 'bg-pink-100 text-pink-600 dark:bg-pink-900 dark:text-pink-400' },
		{ type: 'wait', label: 'Wait', icon: Clock, color: 'bg-sky-100 text-sky-600 dark:bg-sky-900 dark:text-sky-400' },
		{ type: 'emit', label: 'Emit', icon: Send, color: 'bg-green-100 text-green-600 dark:bg-green-900 dark:text-green-400' },
		{ type: 'listen', label: 'Listen', icon: Headphones, color: 'bg-cyan-100 text-cyan-600 dark:bg-cyan-900 dark:text-cyan-400' },
		{ type: 'for', label: 'For', icon: Repeat, color: 'bg-orange-100 text-orange-600 dark:bg-orange-900 dark:text-orange-400' },
		{ type: 'fork', label: 'Fork', icon: GitFork, color: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-900 dark:text-indigo-400' },
		{ type: 'try', label: 'Try', icon: Shield, color: 'bg-yellow-100 text-yellow-600 dark:bg-yellow-900 dark:text-yellow-400' },
		{ type: 'run', label: 'Run', icon: Zap, color: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900 dark:text-emerald-400' },
		{ type: 'raise', label: 'Raise', icon: OctagonAlert, color: 'bg-red-100 text-red-600 dark:bg-red-900 dark:text-red-400' },
		{ type: 'do', label: 'Do', icon: Layers, color: 'bg-teal-100 text-teal-600 dark:bg-teal-900 dark:text-teal-400' }
	];

	function onDragStart(event: DragEvent, type: WorkflowNodeType) {
		if (!event.dataTransfer) return;
		event.dataTransfer.setData('application/svelteflow-nodetype', type);
		event.dataTransfer.effectAllowed = 'move';
	}

	function onClickAdd(type: WorkflowNodeType, label: string) {
		const position = screenToFlowPosition({
			x: window.innerWidth / 2,
			y: window.innerHeight / 2
		});
		store.addNode(type, position, label);
	}

	async function onFunctionSelect(action: ActionCatalogItem, definition: Record<string, unknown>) {
		try {
			const projection = insertActionTask(store.spec, store.workflowName, action, definition);
			store.setTaskMetadata(projection.taskName, projection.metadata);
			await store.applySpecAndRebuild(projection.spec);
			store.selectedNodeId = getNodeIdForTaskName(store.nodes, projection.taskName);
		} catch (error) {
			console.error('Failed to add function from palette:', error);
		}
	}
</script>

<Panel position="top-left" class="!m-0 !p-0">
	<div
		class="rounded-br-lg border-b border-r border-border bg-card/95 shadow-md backdrop-blur-sm transition-all {expanded
			? 'w-48'
			: 'w-10'}"
	>
		<button
			onclick={() => (expanded = !expanded)}
			class="flex h-10 w-full items-center justify-center gap-1 border-b border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
			title={expanded ? 'Collapse palette' : 'Add node'}
		>
			{#if expanded}
				<ChevronLeft size={14} />
				<span class="text-xs font-medium">Steps</span>
			{:else}
				<ChevronRight size={14} />
			{/if}
		</button>

		{#if expanded}
			<div class="max-h-[calc(100vh-140px)] overflow-y-auto p-1.5">
				{#each nodeDefinitions as def}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						draggable="true"
						ondragstart={(e) => onDragStart(e, def.type)}
						class="mb-0.5 flex cursor-grab items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent active:cursor-grabbing"
					>
						<button
							onclick={() => onClickAdd(def.type, def.label)}
							class="flex items-center gap-2"
						>
							<div class="rounded p-1 {def.color}">
								<def.icon size={12} />
							</div>
							<span class="text-foreground">{def.label}</span>
						</button>
					</div>
				{/each}

				<div class="my-1.5 h-px bg-border"></div>

				<button
					onclick={() => (showFunctionBrowser = true)}
					class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
				>
					<div class="rounded p-1 bg-violet-100 text-violet-600 dark:bg-violet-900 dark:text-violet-400">
						<Blocks size={12} />
					</div>
					<span class="text-foreground">Actions</span>
				</button>
			</div>
		{/if}
	</div>
</Panel>

<FunctionBrowser
	open={showFunctionBrowser}
	onClose={() => (showFunctionBrowser = false)}
	onSelect={onFunctionSelect}
/>
