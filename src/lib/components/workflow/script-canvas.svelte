<script lang="ts">
	import {
		SvelteFlow,
		Controls,
		Background,
		BackgroundVariant,
		MiniMap,
		MarkerType,
		type NodeTypes,
		type Node,
		type Edge
	} from '@xyflow/svelte';
	import { getContext } from 'svelte';
	import { FileCode2, Sparkles, Info, GitFork, Braces, Bot, Zap, Hand } from '@lucide/svelte';
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
		/** Run page: approve a parked gate (event-kind node) by callId. */
		onApproveCall?: (callId: string) => void;
		/** Code⇄canvas sync: a node with a source line was clicked. */
		onNodeLine?: (line: number) => void;
		/** Code⇄canvas sync: highlight the node nearest this source line. */
		activeLine?: number | null;
	}
	let {
		scriptSource = null,
		scriptMeta = undefined,
		callStates = null,
		onKillSession = undefined,
		onSkipCall = undefined,
		onApproveCall = undefined,
		onNodeLine = undefined,
		activeLine = null
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
			const isLoop = Boolean((e.data as { loop?: boolean } | undefined)?.loop);
			const isPipeline = e.label === 'then';
			// Fan-out edges (parallel/pipeline) are animated + hued so concurrency
			// reads instantly; loop-back edges cycle in rose; the spine stays quiet.
			const stroke = isLoop
				? 'oklch(0.72 0.17 15)' // rose
				: isParallel
					? 'oklch(0.78 0.15 75)' // amber
					: isPipeline
						? 'oklch(0.72 0.13 235)' // sky
						: 'var(--muted-foreground)';
			if (isLoop) {
				return {
					...e,
					type: 'bezier',
					animated: true,
					markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: stroke },
					style: `stroke: ${stroke}; stroke-width: 1.5px; stroke-dasharray: 6 4; opacity: 0.75;`,
					labelStyle: `fill: ${stroke}; font-size: 10px; font-weight: 600;`
				};
			}
			return {
				...e,
				// Default (bezier) edges: soft curvature reads more organically than
				// smoothstep's bus-bar right angles, especially on fan-out/fan-in.
				type: 'default',
				animated: isParallel || isPipeline,
				markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: stroke },
				style: `stroke: ${stroke}; stroke-width: ${isParallel || isPipeline ? 1.75 : 1.25}px; opacity: ${isParallel || isPipeline ? 0.85 : 0.45};`
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
			const isActive = activeLine != null && typeof line === 'number' && line === activeLine;
			return {
				...n,
				data: {
					...n.data,
					codeActive: isActive,
					...(callState ? { callState, onKillSession, onSkipCall, onApproveCall } : {})
				}
			};
		});
		edges = styledEdges.map((e) => ({ ...e }));
	});

	function handleNodeClick({ node }: { node: Node }) {
		const line = (node.data as { line?: number | null } | undefined)?.line;
		if (typeof line === 'number' && onNodeLine) onNodeLine(line);
	}

	const isEmpty = $derived((graph?.nodes.length ?? 0) === 0);
	const showMiniMap = $derived((graph?.nodes.length ?? 0) > 10);
	const MINIMAP_HUES: Record<string, string> = {
		agent: 'oklch(0.72 0.12 180)',
		action: 'oklch(0.7 0.15 295)',
		event: 'oklch(0.72 0.17 15)',
		team: 'oklch(0.74 0.12 210)',
		workflow: 'oklch(0.68 0.14 275)',
		parallel: 'oklch(0.78 0.15 75)',
		pipeline: 'oklch(0.72 0.13 235)',
		phase: 'oklch(0.72 0.18 328)',
		loopGroup: 'oklch(0.72 0.17 15 / 0.12)',
		parallelGroup: 'oklch(0.78 0.15 75 / 0.12)',
		pipelineGroup: 'oklch(0.72 0.13 235 / 0.12)'
	};
	function miniMapColor(node: Node): string {
		const v = (node.data as { variant?: string } | undefined)?.variant ?? '';
		return MINIMAP_HUES[v] ?? 'var(--muted-foreground)';
	}
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
			{#if model && model.calls.some((c) => c.kind === 'action')}
				<span class="text-muted-foreground/50">·</span>
				<span>{model.calls.filter((c) => c.kind === 'action').length} action{model.calls.filter((c) => c.kind === 'action').length === 1 ? '' : 's'}</span>
			{/if}
			{#if model && model.calls.some((c) => c.kind === 'event')}
				<span class="text-muted-foreground/50">·</span>
				<span class="text-rose-300/90">{model.calls.filter((c) => c.kind === 'event').length} gate{model.calls.filter((c) => c.kind === 'event').length === 1 ? '' : 's'}</span>
			{/if}
			{#if model && model.loops.length > 0}
				<span class="text-muted-foreground/50">·</span>
				<span>{model.loops.length} loop{model.loops.length === 1 ? '' : 's'}</span>
			{/if}
		</div>
		<div class="pointer-events-none absolute right-3 top-3 z-10 flex flex-col gap-1.5 rounded-lg border border-border/50 bg-background/80 px-2.5 py-2 text-[10px] shadow-sm backdrop-blur">
			<div class="flex items-center gap-1.5">
				<Bot class="size-3 text-teal-300" />
				<span class="text-muted-foreground">agent</span>
				<Zap class="ml-1 size-3 text-violet-300" />
				<span class="text-muted-foreground">action</span>
				<Hand class="ml-1 size-3 text-rose-300" />
				<span class="text-muted-foreground">gate</span>
			</div>
			<div class="flex items-center gap-1.5">
				<GitFork class="size-3 text-amber-300" />
				<span class="text-muted-foreground">parallel</span>
				<Braces class="ml-1 size-3 text-teal-300" />
				<span class="text-muted-foreground">typed output</span>
			</div>
			<div class="flex items-center gap-1.5">
				<span class="inline-block h-0 w-4 border-t-[1.5px] border-dashed border-rose-300"></span>
				<span class="text-muted-foreground">repeats (loop)</span>
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
			onnodeclick={handleNodeClick}
			proOptions={{ hideAttribution: true }}
		>
			<Background variant={BackgroundVariant.Dots} gap={18} size={1} />
			<Controls showLock={false} />
			{#if showMiniMap}
				<MiniMap nodeColor={miniMapColor} pannable zoomable class="!bg-background/80" />
			{/if}
		</SvelteFlow>
	{/if}
</div>

<style>
	/* Node enter: a one-shot fade+rise on the node's INNER content — NEVER the
	 * .svelte-flow__node wrapper: SvelteFlow positions nodes via an inline
	 * `transform`, and a keyframe animating transform there overrides the
	 * positioning for the animation's lifetime (fill-mode both = forever),
	 * collapsing every node onto the canvas origin. */
	:global(.svelte-flow__node > div) {
		animation: wfb-node-enter 240ms cubic-bezier(0.22, 1, 0.36, 1) both;
	}
	@keyframes wfb-node-enter {
		from {
			opacity: 0;
			transform: translateY(6px) scale(0.985);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}
	/* Live-run pulse: a soft breathing ring on cards with a RUNNING journal
	 * row (box-shadow on a rounded card — cheap, no layout). */
	:global(.wfb-node-card.wfb-node-running) {
		animation: wfb-node-pulse 2.2s ease-in-out infinite;
	}
	@keyframes wfb-node-pulse {
		0%,
		100% {
			box-shadow: 0 0 0 0 color-mix(in oklch, oklch(0.72 0.13 235) 35%, transparent);
		}
		50% {
			box-shadow: 0 0 0 6px color-mix(in oklch, oklch(0.72 0.13 235) 8%, transparent);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		:global(.svelte-flow__node > div) {
			animation: none;
		}
		:global(.wfb-node-card.wfb-node-running) {
			animation: none;
		}
	}
</style>
