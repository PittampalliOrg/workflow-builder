<script lang="ts">
	import {
		SvelteFlow,
		Controls,
		Background,
		BackgroundVariant,
		MarkerType,
		type NodeTypes,
		type Node,
		type Edge
	} from '@xyflow/svelte';
	import { getContext } from 'svelte';
	import { FileCode2, Sparkles, Info } from '@lucide/svelte';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import type { createUiStore } from '$lib/stores/ui.svelte';
	import { scriptToGraph, type ScriptGraphModel } from '$lib/utils/script-graph-adapter';
	import ScriptNode from './nodes/script-node.svelte';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');
	const ui = getContext<ReturnType<typeof createUiStore>>('ui');

	const nodeTypes: NodeTypes = { script: ScriptNode } satisfies NodeTypes;

	let colorMode = $derived<'light' | 'dark' | 'system'>(
		ui.theme === 'dark' ? 'dark' : ui.theme === 'light' ? 'light' : 'system'
	);

	let nodes = $state.raw<Node[]>([]);
	let edges = $state.raw<Edge[]>([]);
	let model = $state<ScriptGraphModel | null>(null);

	// Rebuild the structural preview whenever the script source changes (the
	// authoring session saves → editor refetch → store.scriptSource updates).
	$effect(() => {
		const src = store.scriptSource;
		const meta = store.scriptMeta;
		if (!src) {
			nodes = [];
			edges = [];
			model = null;
			return;
		}
		const graph = scriptToGraph(src, meta);
		model = graph.model;
		nodes = graph.nodes.map((n) => ({ ...n }));
		edges = graph.edges.map((e) => ({
			...e,
			type: 'default',
			markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
			style: 'stroke: var(--muted-foreground); opacity: 0.35;'
		}));
	});

	const isEmpty = $derived(nodes.length === 0);
</script>

<div class="relative h-full w-full">
	{#if isEmpty}
		<div class="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
			<div class="flex size-12 items-center justify-center rounded-xl border border-fuchsia-400/30 bg-fuchsia-500/10">
				<FileCode2 class="size-6 text-fuchsia-300" />
			</div>
			<div class="max-w-md space-y-1">
				<h3 class="text-sm font-semibold">This is a dynamic-script workflow</h3>
				<p class="text-xs text-muted-foreground">
					Its spec is a JavaScript orchestration script (phases, <code>agent()</code>,
					<code>parallel()</code>, <code>pipeline()</code>, <code>workflow()</code>) — not a
					node graph. Open the <span class="font-medium text-fuchsia-300">AI</span> panel and
					describe what you want in plain language; the assistant authors the script and it
					appears here.
				</p>
			</div>
			<button
				class="inline-flex items-center gap-1.5 rounded-md border border-fuchsia-400/30 bg-fuchsia-500/10 px-3 py-1.5 text-xs font-medium text-fuchsia-200 hover:bg-fuchsia-500/20"
				onclick={() => ui.openRightPanel('ai')}
			>
				<Sparkles class="size-3.5" /> Author with AI
			</button>
		</div>
	{:else}
		<div class="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2 rounded-md border border-border/50 bg-background/80 px-2.5 py-1 text-[11px] text-muted-foreground backdrop-blur">
			<Info class="size-3.5 text-fuchsia-300" />
			<span>
				Structure preview · {model?.phases.length ?? 0} phase{(model?.phases.length ?? 0) === 1 ? '' : 's'} ·
				{model?.estimatedAgentCalls ?? 0} agent call{(model?.estimatedAgentCalls ?? 0) === 1 ? '' : 's'}
			</span>
		</div>
		<SvelteFlow
			bind:nodes
			bind:edges
			{nodeTypes}
			{colorMode}
			fitView
			fitViewOptions={{ padding: 0.2 }}
			nodesDraggable={false}
			nodesConnectable={false}
			elementsSelectable={true}
			panOnScroll
			proOptions={{ hideAttribution: true }}
		>
			<Background variant={BackgroundVariant.Dots} gap={18} size={1} />
			<Controls showLock={false} />
		</SvelteFlow>
	{/if}
</div>
