<script lang="ts">
	import { Wrench } from '@lucide/svelte';
	import type { WorkflowNodeData } from '$lib/stores/workflow.svelte';

	interface Props {
		data: WorkflowNodeData;
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	const turnCount = $derived((data as Record<string, unknown>).childWorkflowTurnCount as number ?? 0);
	const maxTurns = $derived((data as Record<string, unknown>).childWorkflowMaxTurns as number | undefined);
	const toolCount = $derived((data as Record<string, unknown>).childWorkflowToolCount as number ?? 0);

	const isRunning = $derived(data.status === 'running');
	const isSuccess = $derived(data.status === 'success');
	const isError = $derived(data.status === 'error');

	// Ring progress
	const maxDisplayTurns = $derived(
		typeof maxTurns === 'number' && Number.isFinite(maxTurns) && maxTurns > 0 ? maxTurns : 30
	);
	const cappedTurns = $derived(Math.min(turnCount, maxDisplayTurns));
	const radius = 30;
	const circumference = 2 * Math.PI * radius;
	const arcFraction = $derived(cappedTurns / maxDisplayTurns);
	const dashOffset = $derived(circumference * (1 - arcFraction));

	const ringColor = $derived(
		isRunning ? 'stroke-yellow-500 dark:stroke-yellow-400'
		: isSuccess ? 'stroke-green-500 dark:stroke-green-400'
		: isError ? 'stroke-red-500 dark:stroke-red-400'
		: 'stroke-slate-400 dark:stroke-slate-600'
	);

	const cardClass = $derived(
		isRunning
			? 'border-yellow-400 bg-white shadow-lg dark:border-yellow-500/60 dark:bg-slate-900 cw-loop-running'
		: isSuccess
			? 'border-green-400 bg-white shadow-md dark:border-green-500/60 dark:bg-slate-900'
		: isError
			? 'border-red-400 bg-white shadow-md dark:border-red-500/60 dark:bg-slate-900'
		: 'border-slate-300 bg-white shadow-md dark:border-slate-500 dark:bg-slate-900'
	);
</script>

<div class="rounded-xl border-2 transition-all {cardClass} {selected ? 'ring-2 ring-ring' : ''}">
	<div class="flex items-center gap-3 px-3 py-3">
		<!-- Circular progress ring -->
		<div class="relative flex shrink-0 items-center justify-center">
			<svg width="70" height="70" viewBox="0 0 70 70" class="{isRunning ? 'cw-ring-rotate' : ''}">
				<!-- Track -->
				<circle cx="35" cy="35" r={radius} fill="none" stroke-width="4.5" class="stroke-slate-200 dark:stroke-slate-700/60" />
				<!-- Progress arc -->
				{#if turnCount > 0}
					<circle
						cx="35" cy="35" r={radius}
						fill="none" stroke-width="4.5" stroke-linecap="round"
						class="{ringColor} {isRunning ? 'cw-ring-pulse' : ''}"
						stroke-dasharray={circumference}
						stroke-dashoffset={dashOffset}
						transform="rotate(-90 35 35)"
						style="transition: stroke-dashoffset 0.6s ease;"
					/>
				{/if}
				<!-- Tick marks -->
				{#each Array(cappedTurns) as _, i}
					{@const angle = (i / maxDisplayTurns) * 360 - 90}
					{@const rad = (angle * Math.PI) / 180}
					{@const innerR = radius - 8}
					{@const outerR = radius - 3}
					<line
						x1={35 + innerR * Math.cos(rad)} y1={35 + innerR * Math.sin(rad)}
						x2={35 + outerR * Math.cos(rad)} y2={35 + outerR * Math.sin(rad)}
						stroke-width="1.5" stroke-linecap="round"
						class={isRunning && i === cappedTurns - 1 ? 'stroke-yellow-500 dark:stroke-yellow-300' : isSuccess ? 'stroke-green-400/60' : isError ? 'stroke-red-400/60' : 'stroke-slate-400/50'}
					/>
				{/each}
			</svg>
			<!-- Center count -->
			<div class="absolute inset-0 flex flex-col items-center justify-center">
				<span class="text-lg font-bold leading-none {isRunning ? 'text-yellow-600 dark:text-yellow-300' : isSuccess ? 'text-green-600 dark:text-green-300' : isError ? 'text-red-600 dark:text-red-300' : 'text-slate-600 dark:text-slate-300'}">
					{turnCount}
				</span>
				<span class="text-[8px] uppercase tracking-widest text-slate-400 dark:text-slate-500">
					{#if maxTurns}
						/ {maxTurns}
					{:else}
						{turnCount === 1 ? 'turn' : 'turns'}
					{/if}
				</span>
			</div>
		</div>

		<!-- Info column -->
		<div class="min-w-0 flex-1">
			<div class="text-[12px] font-medium {isRunning ? 'text-yellow-700 dark:text-yellow-200 cw-text-pulse' : isSuccess ? 'text-slate-700 dark:text-slate-300' : isError ? 'text-red-600 dark:text-red-300' : 'text-slate-500 dark:text-slate-400'}">
				{data.label}
			</div>

			{#if toolCount > 0}
				<div class="mt-1 flex items-center gap-1 text-[11px] text-slate-500">
					<Wrench size={10} />
					<span>{toolCount} tool call{toolCount === 1 ? '' : 's'}</span>
				</div>
			{/if}

			{#if maxTurns}
				<div class="mt-1 text-[10px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
					{turnCount} / {maxTurns} turns
				</div>
			{/if}

			{#if turnCount > 0}
				<div class="mt-1.5 flex flex-wrap gap-[4px]">
					{#each Array(Math.min(turnCount, 16)) as _, i}
						{@const isLatest = i === Math.min(turnCount, 16) - 1 && turnCount <= 16}
						<div class="h-[5px] w-[5px] rounded-full
							{isRunning && isLatest ? 'bg-yellow-500 dark:bg-yellow-400 cw-dot-pulse' : isSuccess ? 'bg-green-400/60' : isError && isLatest ? 'bg-red-400' : 'bg-slate-300 dark:bg-slate-600/60'}
						"></div>
					{/each}
					{#if turnCount > 16}
						<span class="text-[9px] text-slate-500">+{turnCount - 16}</span>
					{/if}
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	/* Running: pulse glow matching base-sw-node yellow */
	:global(.cw-loop-running) {
		animation: cwLoopPulse 2s ease-in-out infinite;
	}
	@keyframes cwLoopPulse {
		0%, 100% { box-shadow: 0 0 0 0 rgba(234, 179, 8, 0.25); }
		50% { box-shadow: 0 0 0 6px rgba(234, 179, 8, 0); }
	}

	/* Slow rotation on the ring SVG when running */
	:global(.cw-ring-rotate) {
		animation: ringRotate 8s linear infinite;
	}
	@keyframes ringRotate {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}

	/* Pulse the progress arc opacity */
	:global(.cw-ring-pulse) {
		animation: ringPulse 1.5s ease-in-out infinite;
	}
	@keyframes ringPulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.6; }
	}

	/* Pulsing active dot */
	:global(.cw-dot-pulse) {
		animation: dotPulse 1.2s ease-in-out infinite;
	}
	@keyframes dotPulse {
		0%, 100% { transform: scale(1); box-shadow: 0 0 0 rgba(234,179,8,0); }
		50% { transform: scale(1.6); box-shadow: 0 0 6px rgba(234,179,8,0.5); }
	}

	/* Pulsing text for current tool */
	:global(.cw-text-pulse) {
		animation: textPulse 2s ease-in-out infinite;
	}
	@keyframes textPulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.6; }
	}
</style>
