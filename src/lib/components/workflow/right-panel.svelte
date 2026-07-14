<script lang="ts">
	/**
	 * Unified right panel — consolidates Properties/Code/AI/Runs into one resizable panel.
	 * Replaces both the old side-panel.svelte and the fixed ai-assistant-panel.svelte.
	 */
	import { getContext } from 'svelte';
	import { slide } from 'svelte/transition';
	import { PanelRightClose, Settings2, Code2, Sparkles, Play, Webhook } from '@lucide/svelte';
	import { Tabs, TabsList, TabsTrigger, TabsContent } from '$lib/components/ui/tabs';
	import { buttonVariants } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import type { createUiStore, RightPanelTab } from '$lib/stores/ui.svelte';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import NodeConfigPanel from './node-config-panel.svelte';
	import ActionProperties from './action-properties.svelte';
	import SpecEditor from './spec-editor.svelte';
	import ScriptCodePanel from './script-code-panel.svelte';
	import RunsPanel from './runs-panel.svelte';
	import AiTabContent from './ai-tab-content.svelte';
	import WorkflowTriggersPanel from './workflow-triggers-panel.svelte';

	const ui = getContext<ReturnType<typeof createUiStore>>('ui');
	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');

	// Panel width (persisted to localStorage)
	const MIN_WIDTH = 320;
	const MAX_WIDTH_PCT = 50;
	const DEFAULT_WIDTH = 420;

	let panelWidth = $state(loadWidth());
	let isResizing = $state(false);

	// The Runs tab hosts the full Run Console when a run is selected — give it room.
	// One-time nudge per newly-selected run (only widens, never shrinks; not persisted,
	// so it never clobbers the user's saved width). The panel stays user-resizable.
	const RUN_VIEW_MIN = 600;
	const CODE_VIEW_MIN = 560;
	let codeNudged = $state(false);
	$effect(() => {
		if (
			ui.rightPanelTab === 'code' &&
			store.isDynamicScript &&
			!codeNudged &&
			panelWidth < CODE_VIEW_MIN
		) {
			codeNudged = true;
			const cap =
				typeof window !== 'undefined'
					? Math.round((window.innerWidth * MAX_WIDTH_PCT) / 100)
					: CODE_VIEW_MIN;
			panelWidth = Math.min(CODE_VIEW_MIN, cap);
		}
	});
	let nudgedFor = $state<string | null>(null);
	$effect(() => {
		const sel = store.selectedExecutionId;
		if (!sel) {
			nudgedFor = null;
			return;
		}
		if (ui.rightPanelTab === 'runs' && sel !== nudgedFor && panelWidth < RUN_VIEW_MIN) {
			nudgedFor = sel;
			const cap =
				typeof window !== 'undefined'
					? Math.round((window.innerWidth * MAX_WIDTH_PCT) / 100)
					: RUN_VIEW_MIN;
			panelWidth = Math.min(RUN_VIEW_MIN, cap);
		}
	});

	// Determine if selected node is a call/action type (shows ActionProperties vs NodeConfigPanel)
	// Reads from the spec (source of truth) — checks if node ID maps to a task with a `call` property
	const isCallNode = $derived.by(() => {
		if (!store.selectedNode || !store.spec) return false;
		if (store.selectedNode.data?.type === 'agent' || store.selectedNode.type === 'agent') {
			return false;
		}
		const id = store.selectedNode.id;
		// Extract task name from SDK node ID: "/do/0/send-email" → "send-email"
		const taskName = id.startsWith('/do/') ? id.split('/').pop() || '' : id;
		// Check spec for a task with this name that has a `call` property
		const doArray = ((store.spec as Record<string, unknown>).do || []) as Array<Record<string, unknown>>;
		const task = doArray.find((e) => Object.keys(e)[0] === taskName);
		if (task) {
			const def = task[taskName] as Record<string, unknown>;
			return (
				typeof def?.call === 'string' &&
				def.call !== 'durable/run'
			) || def?.call === '';
		}
		// Fallback: check node data
		const data = store.selectedNode.data as Record<string, unknown>;
		const nodeType = (data?.swType || data?.type || '') as string;
		return nodeType === 'call' || nodeType === 'action';
	});

	// Available tabs — Properties is conditional on node selection, Code/AI/Runs always visible
	const tabs = $derived.by(() => {
		const all: Array<{ id: RightPanelTab; label: string; icon: typeof Sparkles }> = [];
		if (store.selectedNode || ui.rightPanelTab === 'properties') {
			all.push({ id: 'properties', label: 'Properties', icon: Settings2 });
		}
		all.push({
			id: 'code',
			label: store.isDynamicScript ? 'Code' : 'Spec',
			icon: Code2
		});
		all.push({ id: 'ai', label: 'AI', icon: Sparkles });
		all.push({ id: 'runs', label: 'Runs', icon: Play });
		all.push({ id: 'triggers', label: 'Triggers', icon: Webhook });
		return all;
	});

	// If current tab is node-specific but no node selected, fall back to AI
	$effect(() => {
		if (!store.selectedNode && ui.rightPanelTab === 'properties') {
			ui.rightPanelTab = 'ai';
		}
	});

	// Panel header title
	const headerTitle = $derived.by(() => {
		if (ui.rightPanelTab === 'code' && store.isDynamicScript) return 'Script';
		if (ui.rightPanelTab === 'properties' || ui.rightPanelTab === 'code') {
			return store.selectedNode?.data?.label || 'Node';
		}
		if (ui.rightPanelTab === 'ai') return 'AI Assistant';
		if (ui.rightPanelTab === 'runs') return 'Workflow';
		return '';
	});

	function loadWidth(): number {
		if (typeof localStorage === 'undefined') return DEFAULT_WIDTH;
		const saved = localStorage.getItem('wb-panel-width');
		return saved ? Math.max(MIN_WIDTH, parseInt(saved, 10) || DEFAULT_WIDTH) : DEFAULT_WIDTH;
	}

	function saveWidth(w: number) {
		panelWidth = w;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('wb-panel-width', String(w));
		}
	}

	function onResizeStart(e: PointerEvent) {
		e.preventDefault();
		isResizing = true;
		const startX = e.clientX;
		const startWidth = panelWidth;
		const maxWidth = window.innerWidth * (MAX_WIDTH_PCT / 100);

		function onMove(ev: PointerEvent) {
			const delta = startX - ev.clientX;
			const newWidth = Math.min(maxWidth, Math.max(MIN_WIDTH, startWidth + delta));
			panelWidth = Math.round(newWidth);
		}

		function onUp() {
			isResizing = false;
			saveWidth(panelWidth);
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		}

		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}
</script>

<div
	class="relative flex h-full flex-col border-l border-border bg-card"
	style="width: {panelWidth}px;"
	transition:slide={{ axis: 'x', duration: 150 }}
>
	<!-- Resize handle -->
	<div
		class="absolute left-0 top-0 bottom-0 z-10 flex w-1.5 cursor-col-resize items-center justify-center hover:bg-primary/10 active:bg-primary/20 transition-colors"
		onpointerdown={onResizeStart}
		role="separator"
		aria-orientation="vertical"
		tabindex={0}
	>
		{#if isResizing}
			<div class="h-8 w-0.5 rounded-full bg-primary"></div>
		{/if}
	</div>

	<!-- Header -->
	<div class="flex h-9 items-center justify-between border-b border-border px-3">
		<span class="min-w-0 truncate text-xs font-medium text-card-foreground">
			{headerTitle}
		</span>

		<Tooltip.Root>
			<Tooltip.Trigger
				class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
				onclick={() => ui.closeRightPanel()}
			>
				<PanelRightClose size={14} />
			</Tooltip.Trigger>
			<Tooltip.Content>Close panel</Tooltip.Content>
		</Tooltip.Root>
	</div>

	<!-- Tabbed content -->
	<Tabs
		bind:value={ui.rightPanelTab}
		class="flex flex-1 flex-col overflow-hidden"
	>
		<div class="px-2 pt-1.5 pb-1.5">
			<TabsList class="w-full h-8">
				{#each tabs as tab (tab.id)}
					<TabsTrigger
						value={tab.id}
						class="text-[11px] flex-1 gap-1"
					>
						<tab.icon size={12} />
						{tab.label}
					</TabsTrigger>
				{/each}
			</TabsList>
		</div>

		<TabsContent value="properties" class="mt-0 flex-1 overflow-auto">
			{#if store.selectedNode}
				{#if isCallNode}
					<ActionProperties />
				{:else}
					<NodeConfigPanel mode="properties" />
				{/if}
			{:else}
				<div class="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
					Select a node to configure.
				</div>
			{/if}
		</TabsContent>

		<TabsContent value="code" class="mt-0 flex-1 overflow-hidden flex flex-col">
			{#if store.isDynamicScript}
				<ScriptCodePanel />
			{:else}
				<SpecEditor />
			{/if}
		</TabsContent>

		<TabsContent value="ai" class="mt-0 flex-1 overflow-hidden flex flex-col">
			<AiTabContent />
		</TabsContent>

		<TabsContent value="runs" class="mt-0 flex-1 overflow-hidden flex flex-col">
			<RunsPanel embedded />
		</TabsContent>

		<TabsContent value="triggers" class="mt-0 flex-1 overflow-auto">
			{#if store.workflowId}
				<WorkflowTriggersPanel workflowId={store.workflowId} />
			{:else}
				<div class="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
					Save the workflow first to configure triggers.
				</div>
			{/if}
		</TabsContent>
	</Tabs>
</div>
