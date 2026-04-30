<script lang="ts">
	import { CheckCircle2, Circle, Loader2, XCircle } from '@lucide/svelte';
	import type { SandboxPhase } from '$lib/types/sandbox';

	interface Props {
		currentPhase: SandboxPhase;
	}

	let { currentPhase }: Props = $props();

	const phases: Array<{ id: SandboxPhase; label: string }> = [
		{ id: 'PROVISIONING', label: 'Provisioning' },
		{ id: 'READY', label: 'Ready' },
		{ id: 'DELETING', label: 'Deleting' }
	];

	const phaseOrder: Record<string, number> = {
		UNKNOWN: -1,
		PROVISIONING: 0,
		READY: 1,
		ERROR: 1,
		DELETING: 2
	};

	const currentIndex = $derived(phaseOrder[currentPhase] ?? -1);
	const isError = $derived(currentPhase === 'ERROR');
</script>

<div class="flex items-center gap-0">
	{#each phases as phase, i}
		{@const isCompleted = currentIndex > i}
		{@const isCurrent = currentIndex === i}
		{@const isCurrentError = isCurrent && isError && phase.id === 'READY'}

		<!-- Connector line -->
		{#if i > 0}
			<div
				class="h-0.5 w-6 {isCompleted || isCurrent ? (isCurrentError ? 'bg-red-500' : 'bg-green-500') : 'bg-border'}"
			></div>
		{/if}

		<!-- Checkpoint -->
		<div class="flex items-center gap-1.5" title={phase.label}>
			{#if isCurrentError}
				<XCircle class="h-4 w-4 text-red-500" />
			{:else if isCompleted}
				<CheckCircle2 class="h-4 w-4 text-green-500" />
			{:else if isCurrent}
				<Loader2 class="h-4 w-4 animate-spin text-green-500" />
			{:else}
				<Circle class="h-4 w-4 text-muted-foreground/30" />
			{/if}
			<span class="text-xs {isCurrent ? 'font-medium text-foreground' : isCompleted ? 'text-muted-foreground' : 'text-muted-foreground/50'}">
				{phase.label}
			</span>
		</div>
	{/each}
</div>
