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
	import { FileCode2, Sparkles, Info, GitFork, Braces } from '@lucide/svelte';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import type { createUiStore } from '$lib/stores/ui.svelte';
	import {
		scriptToGraph,
		type CallLineState,
		type ScriptGraphModel
	} from '$lib/utils/script-graph-adapter';
	import ScriptNode from './nodes/script-node.svelte';

	interface Props {
		/** Run-page mode: the run's FROZEN source (executionIr.script). When
		 * omitted the authoring store context supplies the live editor source. */
		scriptSource?: string | null;
		scriptMeta?: unknown;
		/** Per-line journal aggregation for the live overlay (run page). */
		callStates?: Record<number, CallLineState> | null;
		onKillSession?: (sessionId: string) => void;
		onSkipCall?: (callId: string) => void;
	}
	let {
		scriptSource = null,
		scriptMeta = undefined,
		callStates = null,
		onKillSession = undefined,
		onSkipCall = undefined
	}: Props = $props();

	const store = getContext<ReturnType<typeof createWorkflowStore> | undefined>('workflow');
	const ui = getContext<ReturnType<typeof createUiStore> | undefined>('ui');

	const nodeTypes: NodeTypes = { script: ScriptNode } satisfies NodeTypes;

	let colorMode = $derived<'light' | 'dark' | 'system'>(
		ui?.theme === 'dark' ? 'dark' : ui?.theme === 'light' ? 'light' : 'system'
	);

	// Pure derivation of the structural preview from the script source (rebuilds
	// when the authoring session saves → editor refetch → store.scriptSource).
	const graph = $derived.by(() => {
		const src = scriptSource ?? store?.scriptSource;
		if (!src) return null;
		return scriptToGraph(src, scriptMeta ?? store?.scriptMeta);
	});
	const model = $derived<ScriptGraphModel | null>(graph?.model ?? null);
	const styledEdges = $derived(
		(graph?.edges ?? []).map((e) => {
			const isParallel = Boolean((e.data as { parallel?: boolean } | undefined)?.parallel);
			const isPipeline = e.label === 'then';
			// Fan-out edges (parallel/pipeline) are animated + hued so concurrency
			// reads instantly; the sequential spine stays quiet.
			const stroke = isParallel
				? 'oklch(0.78 0.15 75)' // amber
				: isPipeline
					? 'oklch(0.72 0.13 235)' // sky
					: 'var(--muted-foreground)';
			return {
				...e,
				type: 'smoothstep',
				animated: isParallel || isPipeline,
				markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: stroke },
				style: `stroke: ${stroke}; stroke-width: ${isParallel || isPipeline ? 1.75 : 1.25}px; opacity: ${isParallel || isPipeline ? 0.85 : 0.4};`
			};
		})
	);

	// SvelteFlow's bind:nodes/bind:edges need mutable state (it writes selection
	// back); sync the derived graph into the bindable stores.
	let nodes = $state.raw<Node[]>([]);
	let edges = $state.raw<Edge[]>([]);
	$effect(() => {
		nodes = (graph?.nodes ?? []).map((n) => {
			const line = (n.data as { line?: number | null } | undefined)?.line;
			const callState =
				callStates && typeof line === 'number' ? (callStates[line] ?? null) : null;
			return {
				...n,
				data: {
					...n.data,
					...(callState ? { callState, onKillSession, onSkipCall } : {})
				}
			};
		});
		edges = styledEdges.map((e) => ({ ...e }));
	});

	const isEmpty = $derived((graph?.nodes.length ?? 0) === 0);
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
			{#if ui}
				<button
					class="inline-flex items-center gap-1.5 rounded-md border border-fuchsia-400/30 bg-fuchsia-500/10 px-3 py-1.5 text-xs font-medium text-fuchsia-200 hover:bg-fuchsia-500/20"
					onclick={() => ui.openRightPanel('ai')}
				>
					<Sparkles class="size-3.5" /> Author with AI
				</button>
			{/if}
		</div>
	{:else}
		<div class="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2 rounded-lg border border-border/50 bg-background/80 px-2.5 py-1.5 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
			<Info class="size-3.5 text-fuchsia-300" />
			<span class="font-medium text-foreground/80">Structure preview</span>
			<span class="text-muted-foreground/50">·</span>
			<span>{model?.phases.length ?? 0} phase{(model?.phases.length ?? 0) === 1 ? '' : 's'}</span>
			<span class="text-muted-foreground/50">·</span>
			<span>{model?.estimatedAgentCalls ?? 0} agent call{(model?.estimatedAgentCalls ?? 0) === 1 ? '' : 's'}</span>
		</div>
		<div class="pointer-events-none absolute right-3 top-3 z-10 flex flex-col gap-1.5 rounded-lg border border-border/50 bg-background/80 px-2.5 py-2 text-[10px] shadow-sm backdrop-blur">
			<div class="flex items-center gap-1.5">
				<GitFork class="size-3 text-amber-300" />
				<span class="text-muted-foreground">parallel — runs concurrently</span>
			</div>
			<div class="flex items-center gap-1.5">
				<Braces class="size-3 text-teal-300" />
				<span class="text-muted-foreground">typed — structured output</span>
			</div>
			<div class="flex items-center gap-1.5">
				<span class="inline-block h-0 w-4 border-t-[1.5px] border-dashed border-amber-300"></span>
				<span class="text-muted-foreground">fan-out / fan-in</span>
			</div>
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
