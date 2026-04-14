<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';
	import type { Snippet } from 'svelte';
	import type { PortConfig } from '$lib/types/workflow-handles';

	interface Props {
		data: Record<string, unknown>;
		selected?: boolean;
		ports: PortConfig[];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		icon: any;
		iconColor: string;
		providerIconUrl?: string | null;
		children?: Snippet;
	}

	let { data, selected = false, ports, icon: Icon, iconColor, providerIconUrl = null, children }: Props = $props();

	let status = $derived((data.status as string) || 'idle');
	let agentProgress = $derived(data.agentProgress as { turnCount: number; toolCount: number; activeTool: string | null; eventCount: number } | null);
	let prevStatus = $state('idle');
	let showRipple = $state(false);

	// Detect status transitions for ripple effect
	$effect(() => {
		if (status === 'success' && prevStatus === 'running') {
			showRipple = true;
			setTimeout(() => (showRipple = false), 800);
		}
		prevStatus = status;
	});

	let statusBorderClass = $derived(
		status === 'running'
			? 'wb-node--running border-2 border-yellow-500'
			: status === 'success'
				? 'wb-node--success border-2 border-green-500'
				: status === 'error'
					? 'wb-node--error border-2 border-red-500'
					: 'border-border'
	);

	let targetPorts = $derived(ports.filter((p) => p.type === 'target'));
	let sourcePorts = $derived(ports.filter((p) => p.type === 'source'));

	function getHandleStyle(index: number, total: number): string {
		if (total <= 1) return '';
		const pct = ((index + 1) / (total + 1)) * 100;
		return `left: ${pct}%`;
	}
</script>

<div
	class="wb-node relative h-[148px] w-[148px] rounded-md border bg-card shadow-sm {statusBorderClass} {selected
		? 'wb-node--selected ring-2 ring-ring'
		: ''}"
>
	{#each targetPorts as port, i}
		<Handle
			type="target"
			position={Position.Top}
			id={port.id}
			style={getHandleStyle(i, targetPorts.length)}
		/>
	{/each}

	<!-- Status badge (top-right) -->
	{#if status === 'success'}
		<div class="wb-node__check">✓</div>
	{:else if status === 'error'}
		<div class="wb-node__error-icon">✕</div>
	{/if}

	<!-- Centered content: icon + label + description -->
	<div class="flex h-full flex-col items-center justify-center gap-2.5 p-4 text-center">
		<div class="relative shrink-0 {providerIconUrl ? '' : iconColor}">
			{#if providerIconUrl}
				<img
					src={providerIconUrl}
					alt=""
					class="h-9 w-9 rounded-md object-contain"
					onerror={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
				/>
			{:else}
				<Icon size={36} strokeWidth={1.5} />
			{/if}
			{#if status === 'running'}
				<span class="wb-node__spinner"></span>
			{/if}
		</div>
		<div class="min-w-0 w-full">
			<div class="wb-node__label text-xs font-semibold leading-snug text-card-foreground">
				{data.label || ''}
			</div>
			{#if agentProgress}
				<div class="mt-1 flex items-center justify-center gap-1.5 text-[9px]">
					<span class="font-semibold text-blue-400">{agentProgress.turnCount}</span>
					<span class="text-muted-foreground/60">turns</span>
					<span class="text-muted-foreground/30">·</span>
					<span class="font-semibold text-orange-400">{agentProgress.toolCount}</span>
					<span class="text-muted-foreground/60">tools</span>
					<span class="text-muted-foreground/30">·</span>
					<span class="font-semibold text-emerald-400">{agentProgress.eventCount}</span>
					<span class="text-muted-foreground/60">events</span>
				</div>
				{#if agentProgress.activeTool}
					<div class="mt-0.5 truncate text-[8px] text-orange-400/80">
						⚡ {agentProgress.activeTool}
					</div>
				{/if}
			{:else if data.description}
				<div class="wb-node__desc mt-0.5 text-[9px] leading-tight text-muted-foreground">
					{data.description}
				</div>
			{/if}
		</div>
	</div>

	{#if children}
		{@render children()}
	{/if}

	{#each sourcePorts as port, i}
		<Handle
			type="source"
			position={Position.Bottom}
			id={port.id}
			style={getHandleStyle(i, sourcePorts.length)}
		/>
	{/each}

	<!-- Completion ripple effect -->
	{#if showRipple}
		<div class="wb-node__ripple"></div>
		<div class="wb-node__ripple wb-node__ripple--delayed"></div>
	{/if}
</div>

<style>
	/* Node label: wrap text, clamp to 2 lines max */
	.wb-node__label {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		word-break: break-word;
	}

	/* Description: wrap, clamp to 1 line */
	.wb-node__desc {
		display: -webkit-box;
		-webkit-line-clamp: 1;
		-webkit-box-orient: vertical;
		overflow: hidden;
		word-break: break-word;
	}

	/* Smooth status transitions */
	:global(.wb-node) {
		transition:
			border-color 0.4s ease,
			box-shadow 0.4s ease,
			transform 0.2s ease;
	}

	/* Running: pulse glow */
	:global(.wb-node--running) {
		animation: wb-pulse 2s ease-in-out infinite;
	}

	@keyframes wb-pulse {
		0%,
		100% {
			box-shadow: 0 0 0 0 rgba(234, 179, 8, 0.3);
		}
		50% {
			box-shadow: 0 0 0 8px rgba(234, 179, 8, 0);
		}
	}

	/* Success: brief glow then settle */
	:global(.wb-node--success) {
		box-shadow: 0 0 12px rgba(34, 197, 94, 0.3);
	}

	/* Error: red glow */
	:global(.wb-node--error) {
		box-shadow: 0 0 12px rgba(239, 68, 68, 0.3);
	}

	/* Spinner around icon */
	.wb-node__spinner {
		position: absolute;
		inset: -6px;
		border: 2px solid transparent;
		border-top-color: rgba(234, 179, 8, 0.8);
		border-radius: 50%;
		animation: wb-spin 1s linear infinite;
	}

	@keyframes wb-spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* Success check mark — absolute top-right */
	.wb-node__check {
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
		animation: wb-pop 0.3s ease;
	}

	/* Error X mark — absolute top-right */
	.wb-node__error-icon {
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
		animation: wb-pop 0.3s ease;
	}

	@keyframes wb-pop {
		0% {
			transform: scale(0);
			opacity: 0;
		}
		60% {
			transform: scale(1.2);
		}
		100% {
			transform: scale(1);
			opacity: 1;
		}
	}

	/* Completion ripple */
	.wb-node__ripple {
		position: absolute;
		inset: -4px;
		border: 2px solid rgba(34, 197, 94, 0.6);
		border-radius: 0.6rem;
		animation: wb-ripple 0.8s ease-out forwards;
		pointer-events: none;
	}

	.wb-node__ripple--delayed {
		animation-delay: 0.15s;
	}

	@keyframes wb-ripple {
		0% {
			inset: -4px;
			opacity: 1;
		}
		100% {
			inset: -20px;
			opacity: 0;
		}
	}
</style>
