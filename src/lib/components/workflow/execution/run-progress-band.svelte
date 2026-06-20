<script lang="ts">
	/**
	 * Real-time flow-progress band for the Run Console — the "is this actually
	 * progressing?" answer at a glance. Shows the currently-executing node + a
	 * LIVE action indicator (thinking / running a tool / working), an ordered
	 * node stepper coloured by per-node status, a node-completion progress bar,
	 * and the live token rate. All derived from the execution SSE snapshot, so it
	 * updates continuously while the run is active.
	 */
	import type { Node, Edge } from '@xyflow/svelte';
	import type { ExecutionReadModel } from '$lib/types/execution-stream';
	import { buildExecutionCanvasState, type ExecutionCanvasStatus } from '$lib/utils/execution-canvas';
	import { fmtTokens } from '$lib/utils/format-tokens';
	import { Wrench, Sparkles, Gauge, Check, X, Loader2 } from '@lucide/svelte';

	interface Props {
		nodes: Node[];
		edges: Edge[];
		snapshot: ExecutionReadModel | null;
		activeToolName?: string | null;
		isStreaming?: boolean;
		tokensPerSec?: number | null;
		runActive?: boolean;
	}

	let {
		nodes,
		edges,
		snapshot,
		activeToolName = null,
		isStreaming = false,
		tokensPerSec = null,
		runActive = false
	}: Props = $props();

	const canvas = $derived(buildExecutionCanvasState(snapshot, nodes, edges));

	// Ordered, meaningful steps (drop synthetic start/end + non-executing notes).
	const steps = $derived.by(() =>
		nodes
			.filter((n) => n.type !== 'start' && n.type !== 'end' && n.type !== 'note')
			.map((n) => {
				const d = (n.data ?? {}) as Record<string, unknown>;
				const label =
					(typeof d.label === 'string' && d.label) ||
					(typeof d.stepName === 'string' && d.stepName) ||
					(typeof d.name === 'string' && d.name) ||
					n.id;
				return { id: n.id, label: String(label), status: canvas.nodeStatuses[n.id] ?? 'idle' };
			})
	);

	const counts = $derived.by(() => {
		let done = 0;
		let running = 0;
		let error = 0;
		for (const s of steps) {
			if (s.status === 'success') done++;
			else if (s.status === 'running') running++;
			else if (s.status === 'error') error++;
		}
		return { done, running, error, total: steps.length };
	});

	const pct = $derived(
		counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0
	);

	const terminal = $derived(canvas.isTerminal);
	const activeLabel = $derived(canvas.activeNodeLabel);

	// Live action being performed right now (drives the "always moving" feel).
	type LiveAction = { kind: 'thinking' | 'tool' | 'working'; text: string };
	const liveAction = $derived.by<LiveAction | null>(() => {
		if (terminal || !runActive) return null;
		if (isStreaming) return { kind: 'thinking', text: 'thinking…' };
		if (activeToolName) return { kind: 'tool', text: activeToolName };
		return { kind: 'working', text: 'working…' };
	});

	function dotClass(status: ExecutionCanvasStatus): string {
		switch (status) {
			case 'success':
				return 'bg-emerald-500';
			case 'running':
				return 'bg-teal-400 animate-pulse';
			case 'error':
				return 'bg-red-500';
			default:
				return 'bg-muted-foreground/30';
		}
	}
</script>

<div class="border-b bg-muted/10 px-3 py-2">
	<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
		<!-- Now: current node + live action -->
		<div class="flex min-w-0 items-center gap-2">
			{#if terminal}
				<span
					class="flex size-4 shrink-0 items-center justify-center rounded-full {counts.error > 0
						? 'bg-red-500/15 text-red-500'
						: 'bg-emerald-500/15 text-emerald-500'}"
				>
					{#if counts.error > 0}<X class="size-3" />{:else}<Check class="size-3" />{/if}
				</span>
				<span class="truncate text-xs font-medium">
					{counts.error > 0 ? 'Run ended with errors' : 'Run complete'}
				</span>
			{:else}
				<Loader2 class="size-3.5 shrink-0 animate-spin text-teal-400" />
				<span class="truncate text-xs font-medium">{activeLabel ?? 'Starting…'}</span>
				{#if liveAction}
					<span
						class="inline-flex shrink-0 items-center gap-1 rounded-full bg-teal-500/10 px-1.5 py-0.5 text-[10px] font-medium text-teal-600 dark:text-teal-300"
					>
						{#if liveAction.kind === 'tool'}
							<Wrench class="size-2.5" />
						{:else if liveAction.kind === 'thinking'}
							<Sparkles class="size-2.5" />
						{/if}
						{liveAction.text}
					</span>
				{/if}
			{/if}
		</div>

		<!-- Roll-up counts + live rate -->
		<div class="ml-auto flex items-center gap-3 text-[11px] text-muted-foreground">
			{#if counts.total > 0}
				<span class="tabular-nums">{counts.done}/{counts.total} steps</span>
				{#if counts.running > 0}<span class="text-teal-500">▶ {counts.running}</span>{/if}
				{#if counts.error > 0}<span class="text-red-500">✕ {counts.error}</span>{/if}
			{/if}
			{#if tokensPerSec != null && tokensPerSec > 0}
				<span class="inline-flex items-center gap-1"><Gauge class="size-3" />{fmtTokens(Math.round(tokensPerSec))}/s</span>
			{/if}
		</div>
	</div>

	{#if counts.total > 0}
		<!-- Completion progress bar -->
		<div class="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
			<div
				class="h-full rounded-full transition-all duration-500 {counts.error > 0
					? 'bg-red-500'
					: terminal
						? 'bg-emerald-500'
						: 'bg-primary'}"
				style="width: {terminal && counts.error === 0 ? 100 : pct}%"
			></div>
		</div>

		<!-- Ordered node stepper -->
		<div class="mt-2 flex items-center gap-0.5 overflow-x-auto pb-0.5">
			{#each steps as step, i (step.id)}
				{#if i > 0}
					<span
						class="h-px w-2.5 shrink-0 {step.status === 'success' || steps[i - 1].status === 'success'
							? 'bg-emerald-500/50'
							: 'bg-border'}"
					></span>
				{/if}
				<span
					class="inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] {step.status ===
					'running'
						? 'border-teal-400/40 bg-teal-500/10 text-teal-600 dark:text-teal-300'
						: step.status === 'error'
							? 'border-red-400/40 bg-red-500/10 text-red-600 dark:text-red-300'
							: step.status === 'success'
								? 'border-transparent text-muted-foreground'
								: 'border-transparent text-muted-foreground/50'}"
					title="{step.label} — {step.status}"
				>
					<span class="size-1.5 rounded-full {dotClass(step.status)}"></span>
					<span class="max-w-[12ch] truncate">{step.label}</span>
				</span>
			{/each}
		</div>
	{/if}
</div>
