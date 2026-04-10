<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';
	import { GitBranch } from 'lucide-svelte';
	import type { WorkflowNodeData } from '$lib/stores/workflow.svelte';

	interface Props {
		data: WorkflowNodeData;
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	const isRunning = $derived(data.status === 'running');
	const isSuccess = $derived(data.status === 'success');
	const isError = $derived(data.status === 'error');

	const containerClass = $derived(
		isRunning
			? 'border-yellow-500 bg-yellow-50/60 dark:bg-yellow-950/20 dark:border-yellow-500/60 cw-group-running'
		: isSuccess
			? 'border-green-500 bg-green-50/50 dark:bg-green-950/20 dark:border-green-500/50'
		: isError
			? 'border-red-500 bg-red-50/50 dark:bg-red-950/20 dark:border-red-500/50'
		: 'border-slate-300 bg-slate-50/50 dark:bg-slate-900/20 dark:border-slate-600/40'
	);

	const badgeClass = $derived(
		isRunning ? 'bg-yellow-200/80 text-yellow-800 dark:bg-yellow-800/40 dark:text-yellow-200'
		: isSuccess ? 'bg-green-200/80 text-green-800 dark:bg-green-800/40 dark:text-green-200'
		: isError ? 'bg-red-200/80 text-red-800 dark:bg-red-800/40 dark:text-red-200'
		: 'bg-slate-200/80 text-slate-700 dark:bg-slate-700/40 dark:text-slate-300'
	);

	const iconClass = $derived(
		isRunning ? 'text-yellow-600 dark:text-yellow-300'
		: isSuccess ? 'text-green-600 dark:text-green-300'
		: isError ? 'text-red-600 dark:text-red-300'
		: 'text-slate-500'
	);

	let prevStatus = $state('idle');
	let showRipple = $state(false);

	$effect(() => {
		const s = data.status ?? 'idle';
		if (s === 'success' && prevStatus === 'running') {
			showRipple = true;
			setTimeout(() => (showRipple = false), 800);
		}
		prevStatus = s;
	});
</script>

<div class="relative h-full w-full rounded-2xl border-2 transition-all {containerClass} {selected ? 'ring-2 ring-ring' : ''}">
	<Handle type="target" position={Position.Left} class="pointer-events-none opacity-0" />
	<Handle type="source" position={Position.Right} class="pointer-events-none opacity-0" />
	<Handle type="target" position={Position.Top} />
	<Handle type="source" position={Position.Bottom} />

	<!-- Status badge (top-right) -->
	{#if isSuccess}
		<div class="cw-group__check">✓</div>
	{:else if isError}
		<div class="cw-group__error">✕</div>
	{/if}

	<!-- Group header label -->
	<div class="flex items-center gap-2 px-4 pt-3">
		<div class="relative">
			<GitBranch size={14} class={iconClass} />
			{#if isRunning}
				<span class="cw-group__spinner"></span>
			{/if}
		</div>
		<span class="text-[13px] font-bold text-slate-800 dark:text-slate-100">{data.label}</span>
		<span class="ml-auto rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider {badgeClass}">
			{data.description}
		</span>
	</div>

	<!-- Completion ripple -->
	{#if showRipple}
		<div class="cw-group__ripple"></div>
		<div class="cw-group__ripple cw-group__ripple--delayed"></div>
	{/if}
</div>

<style>
	/* Running: pulse glow matching base-sw-node */
	:global(.cw-group-running) {
		animation: cwGroupPulse 2s ease-in-out infinite;
	}
	@keyframes cwGroupPulse {
		0%, 100% { box-shadow: 0 0 0 0 rgba(234, 179, 8, 0.3); }
		50% { box-shadow: 0 0 0 8px rgba(234, 179, 8, 0); }
	}

	/* Spinner around icon */
	.cw-group__spinner {
		position: absolute;
		inset: -5px;
		border: 2px solid transparent;
		border-top-color: rgba(234, 179, 8, 0.8);
		border-radius: 50%;
		animation: cwSpin 1s linear infinite;
	}
	@keyframes cwSpin {
		to { transform: rotate(360deg); }
	}

	/* Success check */
	.cw-group__check {
		position: absolute;
		top: 6px;
		right: 6px;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: rgba(34, 197, 94, 0.5);
		color: white;
		font-size: 10px;
		font-weight: bold;
		z-index: 10;
		animation: cwPop 0.3s ease;
	}

	/* Error badge */
	.cw-group__error {
		position: absolute;
		top: 6px;
		right: 6px;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: rgba(239, 68, 68, 0.5);
		color: white;
		font-size: 10px;
		font-weight: bold;
		z-index: 10;
		animation: cwPop 0.3s ease;
	}

	@keyframes cwPop {
		0% { transform: scale(0); opacity: 0; }
		60% { transform: scale(1.2); }
		100% { transform: scale(1); opacity: 1; }
	}

	/* Completion ripple */
	.cw-group__ripple {
		position: absolute;
		inset: -4px;
		border: 2px solid rgba(34, 197, 94, 0.6);
		border-radius: 1rem;
		animation: cwRipple 0.8s ease-out forwards;
		pointer-events: none;
	}
	.cw-group__ripple--delayed {
		animation-delay: 0.15s;
	}
	@keyframes cwRipple {
		0% { inset: -4px; opacity: 1; }
		100% { inset: -20px; opacity: 0; }
	}
</style>
