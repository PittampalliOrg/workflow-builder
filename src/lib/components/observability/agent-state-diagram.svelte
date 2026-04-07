<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import type {
		ObservabilityAgentDecisionDiagram,
		ObservabilityAgentDecisionDiagramEdge,
		ObservabilityAgentDecisionDiagramNode
	} from '$lib/types/observability';
	import { ArrowRight, Circle, Flag, GitBranch, OctagonPause, TriangleAlert, Wrench } from 'lucide-svelte';

	interface Props {
		diagram: ObservabilityAgentDecisionDiagram | null;
		selectedNodeId?: string | null;
		selectedEdgeId?: string | null;
		onSelectNode?: (node: ObservabilityAgentDecisionDiagramNode) => void;
		onSelectEdge?: (edge: ObservabilityAgentDecisionDiagramEdge) => void;
	}

	let {
		diagram,
		selectedNodeId = null,
		selectedEdgeId = null,
		onSelectNode = () => {},
		onSelectEdge = () => {}
	}: Props = $props();

	const stageOrder = ['start', 'decide', 'tool_call', 'assistant_message', 'wait_or_approval', 'stop', 'error', 'finish'];

	function formatDuration(value: number): string {
		if (!Number.isFinite(value) || value <= 0) return '0ms';
		if (value < 1000) return `${Math.round(value)}ms`;
		return `${(value / 1000).toFixed(2)}s`;
	}

	function presentation(node: ObservabilityAgentDecisionDiagramNode) {
		if (node.id === 'start') return { icon: Flag, tone: 'border-sky-500/20 bg-sky-500/[0.08] text-sky-100' };
		if (node.id === 'decide') return { icon: GitBranch, tone: 'border-indigo-500/20 bg-indigo-500/[0.08] text-indigo-100' };
		if (node.id === 'tool_call') return { icon: Wrench, tone: 'border-emerald-500/20 bg-emerald-500/[0.08] text-emerald-100' };
		if (node.id === 'wait_or_approval') return { icon: OctagonPause, tone: 'border-amber-500/20 bg-amber-500/[0.08] text-amber-100' };
		if (node.id === 'error') return { icon: TriangleAlert, tone: 'border-red-500/20 bg-red-500/[0.08] text-red-100' };
		if (node.id === 'stop' || node.id === 'finish') return { icon: Circle, tone: 'border-cyan-500/20 bg-cyan-500/[0.08] text-cyan-100' };
		return { icon: Circle, tone: 'border-white/10 bg-white/[0.04] text-zinc-100' };
	}

	const orderedNodes = $derived.by(() => {
		if (!diagram) return [];
		const index = new Map(stageOrder.map((id, i) => [id, i]));
		return [...diagram.nodes].sort((a, b) => (index.get(a.id) ?? 999) - (index.get(b.id) ?? 999));
	});

	const entryNodes = $derived(orderedNodes.filter((node) => ['start', 'decide'].includes(node.id)));
	const decisionNodes = $derived(
		orderedNodes.filter((node) => !['start', 'decide', 'finish'].includes(node.id))
	);
	const finishNode = $derived(orderedNodes.find((node) => node.id === 'finish') ?? null);
</script>

{#if !diagram}
	<div class="flex min-h-[320px] items-center justify-center rounded-2xl border border-white/10 bg-black/20 text-sm text-zinc-500">
		No durable-agent decisions captured.
	</div>
{:else}
	<div class="rounded-2xl border border-white/10 bg-[radial-gradient(circle_at_top,rgba(37,99,235,0.08),transparent_38%),linear-gradient(180deg,rgba(10,10,14,0.96),rgba(8,8,12,0.96))] p-4">
		<div class="grid gap-4 2xl:grid-cols-[minmax(0,0.8fr)_40px_minmax(0,1.35fr)_40px_minmax(0,0.8fr)]">
			<div class="space-y-3">
				<p class="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Entry</p>
				{#each entryNodes as node (node.id)}
					{@const nodePresentation = presentation(node)}
					{@const Icon = nodePresentation.icon}
					<button
						class={`w-full rounded-2xl border p-3 text-left transition-all ${
							selectedNodeId === node.id
								? 'border-cyan-400/35 bg-cyan-500/[0.08] shadow-[0_10px_26px_rgba(34,211,238,0.12)]'
								: nodePresentation.tone
						}`}
						onclick={() => onSelectNode(node)}
					>
						<div class="flex items-center justify-between gap-3">
							<div class="flex min-w-0 items-center gap-2">
								<div class="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-black/20">
									<Icon size={16} />
								</div>
								<div class="min-w-0">
									<p class="truncate text-sm font-medium">{node.label}</p>
									<p class="mt-1 text-[11px] text-zinc-400">{node.type}</p>
								</div>
							</div>
							<div class="text-right">
								<p class="font-mono text-[11px] text-zinc-200">{node.count}x</p>
								<p class="mt-1 text-[11px] text-zinc-500">{formatDuration(node.totalDurationMs)}</p>
							</div>
						</div>
					</button>
				{/each}
			</div>

			<div class="hidden items-center justify-center 2xl:flex">
				<ArrowRight size={22} class="text-zinc-600" />
			</div>

			<div class="space-y-3">
				<p class="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Observed decisions</p>
				<div class="grid gap-3 md:grid-cols-2">
					{#each decisionNodes as node (node.id)}
						{@const nodePresentation = presentation(node)}
						{@const Icon = nodePresentation.icon}
						<button
							class={`w-full rounded-2xl border p-3 text-left transition-all ${
								selectedNodeId === node.id
									? 'border-cyan-400/35 bg-cyan-500/[0.08] shadow-[0_10px_26px_rgba(34,211,238,0.12)]'
									: nodePresentation.tone
							}`}
							onclick={() => onSelectNode(node)}
						>
							<div class="flex items-center justify-between gap-3">
								<div class="flex min-w-0 items-center gap-2">
									<div class="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-black/20">
										<Icon size={16} />
									</div>
									<div class="min-w-0">
										<p class="truncate text-sm font-medium">{node.label}</p>
										<p class="mt-1 text-[11px] text-zinc-400">{node.count} transition{node.count === 1 ? '' : 's'}</p>
									</div>
								</div>
								{#if node.isTerminal}
									<Badge variant="outline" class="border-cyan-500/20 bg-cyan-500/10 text-[10px] text-cyan-100">
										final
									</Badge>
								{/if}
							</div>
							<p class="mt-3 font-mono text-[11px] text-zinc-300">{formatDuration(node.totalDurationMs)}</p>
						</button>
					{/each}
				</div>
			</div>

			<div class="hidden items-center justify-center 2xl:flex">
				<ArrowRight size={22} class="text-zinc-600" />
			</div>

			<div class="space-y-3">
				<p class="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Exit</p>
				{#if finishNode}
					{@const nodePresentation = presentation(finishNode)}
					{@const Icon = nodePresentation.icon}
					<button
						class={`w-full rounded-2xl border p-3 text-left transition-all ${
							selectedNodeId === finishNode.id
								? 'border-cyan-400/35 bg-cyan-500/[0.08] shadow-[0_10px_26px_rgba(34,211,238,0.12)]'
								: nodePresentation.tone
						}`}
						onclick={() => onSelectNode(finishNode)}
					>
						<div class="flex items-center justify-between gap-3">
							<div class="flex min-w-0 items-center gap-2">
								<div class="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-black/20">
									<Icon size={16} />
								</div>
								<div class="min-w-0">
									<p class="truncate text-sm font-medium">{finishNode.label}</p>
									<p class="mt-1 text-[11px] text-zinc-400">workflow exit</p>
								</div>
							</div>
							<Badge variant="outline" class="border-cyan-500/20 bg-cyan-500/10 text-[10px] text-cyan-100">
								final
							</Badge>
						</div>
						<p class="mt-3 font-mono text-[11px] text-zinc-300">{finishNode.count}x · {formatDuration(finishNode.totalDurationMs)}</p>
					</button>
				{/if}
			</div>
		</div>

		<div class="mt-5 border-t border-white/10 pt-4">
			<p class="mb-3 text-[11px] uppercase tracking-[0.18em] text-zinc-500">Transitions</p>
			<div class="flex flex-wrap gap-2">
				{#each diagram.edges as edge (edge.id)}
					<button
						class={`rounded-xl border px-3 py-2 text-left transition-all ${
							selectedEdgeId === edge.id
								? 'border-cyan-400/35 bg-cyan-500/[0.08] shadow-[0_10px_26px_rgba(34,211,238,0.12)]'
								: 'border-white/10 bg-white/[0.04] hover:border-white/20 hover:bg-white/[0.06]'
						}`}
						onclick={() => onSelectEdge(edge)}
					>
						<div class="flex items-center gap-2">
							<span class="font-mono text-[11px] text-zinc-200">{edge.from}</span>
							<ArrowRight size={12} class="text-zinc-500" />
							<span class="font-mono text-[11px] text-zinc-200">{edge.to}</span>
						</div>
						<p class="mt-1 text-[11px] text-zinc-400">{edge.count}x · {formatDuration(edge.totalDurationMs)}</p>
					</button>
				{/each}
			</div>
		</div>
	</div>
{/if}
