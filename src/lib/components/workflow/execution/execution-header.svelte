<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		CheckCircle2,
		XCircle,
		Loader2,
		Clock,
		Copy,
		Check,
		ExternalLink,
		ChevronRight
	} from '@lucide/svelte';
	import { resolveStatusTone, statusTonePillClass } from '$lib/utils/status-tone';

	interface Props {
		status: string;
		duration?: string;
		startedAt?: string;
		executionId: string;
		instanceId?: string;
		traceId?: string;
		workflowName?: string;
	}

	let { status, duration, startedAt, executionId, instanceId, traceId, workflowName }: Props = $props();

	let copiedKey = $state<string | null>(null);
	let feedbackTimer: ReturnType<typeof setTimeout> | undefined;

	const isRunning = $derived(
		status.toUpperCase() === 'RUNNING' || status.toUpperCase() === 'PENDING'
	);

	const identifiers = $derived(
		[
			{ key: 'execution', label: 'Execution ID', value: executionId },
			instanceId ? { key: 'instance', label: 'Dapr Instance ID', value: instanceId } : null,
			traceId ? { key: 'trace', label: 'Trace ID', value: traceId } : null
		].filter((id): id is { key: string; label: string; value: string } => id !== null)
	);

	async function copyIdentifier(key: string, value: string) {
		try {
			await navigator.clipboard.writeText(value);
			copiedKey = key;
			clearTimeout(feedbackTimer);
			feedbackTimer = setTimeout(() => (copiedKey = null), 1500);
		} catch {
			// Clipboard not available
		}
	}
</script>

<div class="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
	<div class="flex items-center gap-2 min-w-0">
		{#if workflowName}
			<span class="truncate text-sm font-semibold">{workflowName}</span>
			<span class="text-muted-foreground">/</span>
		{/if}
		<span class="text-sm font-medium">Execution</span>
	</div>

	<span
		class="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium {statusTonePillClass(resolveStatusTone(status))}"
	>
		{#if isRunning}
			<Loader2 size={12} class="animate-spin" />
		{:else if status.toUpperCase() === 'COMPLETED' || status.toUpperCase() === 'SUCCESS'}
			<CheckCircle2 size={12} />
		{:else if status.toUpperCase() === 'FAILED' || status.toUpperCase() === 'ERROR'}
			<XCircle size={12} />
		{:else}
			<Clock size={12} />
		{/if}
		{status}
	</span>

	{#if duration}
		<span class="flex items-center gap-1 text-xs text-muted-foreground">
			<Clock size={12} />
			{duration}
		</span>
	{/if}

	{#if startedAt}
		<span class="text-xs text-muted-foreground">
			Started {startedAt}
		</span>
	{/if}

	<details class="group relative">
		<summary
			class="flex cursor-pointer list-none items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
		>
			<ChevronRight size={12} class="transition-transform group-open:rotate-90" />
			Run IDs
		</summary>
		<div
			class="absolute left-0 top-full z-20 mt-1 w-max max-w-[calc(100vw-2rem)] rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md"
		>
			<ul class="flex flex-col gap-1">
				{#each identifiers as id (id.key)}
					<li class="flex items-center gap-2">
						<span class="w-28 shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
							{id.label}
						</span>
						<code class="max-w-64 truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
							{id.value}
						</code>
						<button
							type="button"
							class="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							onclick={() => copyIdentifier(id.key, id.value)}
							aria-label="Copy {id.label}"
							title="Copy {id.label}"
						>
							{#if copiedKey === id.key}
								<Check size={12} class="text-green-500" />
							{:else}
								<Copy size={12} />
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		</div>
	</details>

	<div class="ml-auto flex items-center gap-1">
		{#if traceId}
			<button
				class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				onclick={() => goto(`/observability/${traceId}`)}
			>
				<ExternalLink size={12} />
				View Trace
			</button>
		{/if}
	</div>
</div>
