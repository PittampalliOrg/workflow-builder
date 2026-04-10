<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';
	import { Wrench, IterationCcw, CheckCircle2, XCircle, Loader2 } from 'lucide-svelte';
	import type { WorkflowNodeData } from '$lib/stores/workflow.svelte';

	interface Props {
		data: WorkflowNodeData;
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	const turnCount = $derived((data as Record<string, unknown>).childWorkflowTurnCount as number ?? 0);
	const toolCount = $derived((data as Record<string, unknown>).childWorkflowToolCount as number ?? 0);

	const isRunning = $derived(data.status === 'running');
	const isSuccess = $derived(data.status === 'success');
	const isError = $derived(data.status === 'error');

	const borderClass = $derived(
		isRunning ? 'border-cyan-400/80 shadow-cyan-500/25 shadow-lg child-workflow-pulse'
		: isSuccess ? 'border-emerald-400/70 shadow-emerald-500/10'
		: isError ? 'border-rose-400/70 shadow-rose-500/15'
		: 'border-slate-500/40'
	);

	const StatusIcon = $derived(
		isRunning ? Loader2
		: isSuccess ? CheckCircle2
		: isError ? XCircle
		: Loader2
	);

	const statusIconClass = $derived(
		isRunning ? 'text-cyan-400 animate-spin'
		: isSuccess ? 'text-emerald-400'
		: isError ? 'text-rose-400'
		: 'text-slate-500'
	);

	// Cap visible dots at 12 — beyond that show a count
	const maxDots = 12;
	const showDots = $derived(turnCount > 0);
	const dotCount = $derived(Math.min(turnCount, maxDots));
	const overflowCount = $derived(Math.max(turnCount - maxDots, 0));
</script>

<div
	class="min-w-[200px] max-w-[280px] rounded-2xl border-2 bg-gradient-to-br from-slate-900/95 via-slate-900/90 to-indigo-950/40 px-4 py-3 backdrop-blur-sm transition-all {borderClass} {selected ? 'ring-2 ring-cyan-400/40' : ''}"
>
	<Handle type="target" position={Position.Left} class="pointer-events-none opacity-0" />
	<Handle type="source" position={Position.Right} class="pointer-events-none opacity-0" />

	<!-- Header row: loop icon + name + status -->
	<div class="flex items-center gap-2.5">
		<div
			class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 transition-all {isRunning ? 'child-workflow-icon-spin border-cyan-400/50 bg-cyan-500/15 text-cyan-300' : ''}"
		>
			<IterationCcw size={18} />
		</div>
		<div class="min-w-0 flex-1">
			<div class="flex items-center gap-1.5">
				<span class="truncate text-sm font-semibold text-slate-100">{data.label}</span>
				<StatusIcon size={14} class={statusIconClass} />
			</div>
			{#if data.description}
				<div class="truncate text-[11px] text-slate-400">{data.description}</div>
			{/if}
		</div>
	</div>

	<!-- Turn progress dots -->
	{#if showDots}
		<div class="mt-2.5 flex items-center gap-1 border-t border-slate-700/50 pt-2">
			<div class="flex flex-wrap items-center gap-[5px]">
				{#each Array(dotCount) as _, i}
					{@const isLatest = i === dotCount - 1 && overflowCount === 0}
					<div
						class="h-[7px] w-[7px] rounded-full transition-all
							{isRunning && isLatest
								? 'bg-cyan-400 child-workflow-dot-pulse shadow-[0_0_6px_rgba(34,211,238,0.6)]'
								: isSuccess
									? 'bg-emerald-400/80'
									: isError && isLatest
										? 'bg-rose-400'
										: 'bg-cyan-400/60'
							}"
					></div>
				{/each}
				{#if overflowCount > 0}
					<span class="ml-0.5 text-[10px] font-medium {isRunning ? 'text-cyan-400' : 'text-slate-400'}">
						+{overflowCount}
					</span>
				{/if}
			</div>
			{#if toolCount > 0}
				<div class="ml-auto flex items-center gap-1 text-[10px] text-slate-500">
					<Wrench size={10} />
					<span>{toolCount}</span>
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	/* Spinning loop icon when active */
	:global(.child-workflow-icon-spin svg) {
		animation: loopSpin 2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
	}

	@keyframes loopSpin {
		0% { transform: rotate(0deg); }
		100% { transform: rotate(-360deg); }
	}

	/* Pulsing glow on the node border when running */
	:global(.child-workflow-pulse) {
		animation: borderPulse 2s ease-in-out infinite;
	}

	@keyframes borderPulse {
		0%, 100% { box-shadow: 0 0 8px rgba(34, 211, 238, 0.15); }
		50% { box-shadow: 0 0 20px rgba(34, 211, 238, 0.35); }
	}

	/* Pulsing latest dot when running */
	:global(.child-workflow-dot-pulse) {
		animation: dotPulse 1.2s ease-in-out infinite;
	}

	@keyframes dotPulse {
		0%, 100% { transform: scale(1); opacity: 1; }
		50% { transform: scale(1.5); opacity: 0.7; }
	}
</style>
