<script lang="ts">
	import { goto } from '$app/navigation';
	import { Badge } from '$lib/components/ui/badge';
	import { CheckCircle2, XCircle, Loader2, Clock, Copy, Check, ExternalLink } from '@lucide/svelte';

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

	let copyFeedback = $state(false);

	const isRunning = $derived(
		status.toUpperCase() === 'RUNNING' || status.toUpperCase() === 'PENDING'
	);

	function statusVariant(s: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		switch (s.toUpperCase()) {
			case 'RUNNING':
			case 'PENDING':
				return 'default';
			case 'COMPLETED':
			case 'SUCCESS':
				return 'secondary';
			case 'FAILED':
			case 'ERROR':
				return 'destructive';
			default:
				return 'outline';
		}
	}

	async function copyId() {
		try {
			await navigator.clipboard.writeText(executionId);
			copyFeedback = true;
			setTimeout(() => (copyFeedback = false), 1500);
		} catch {
			// Clipboard not available
		}
	}
</script>

<div class="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
	<div class="flex items-center gap-2">
		{#if workflowName}
			<span class="text-sm font-semibold">{workflowName}</span>
			<span class="text-muted-foreground">/</span>
		{/if}
		<span class="text-sm font-medium">Execution</span>
	</div>

	<Badge variant={statusVariant(status)} class="flex items-center gap-1">
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
	</Badge>

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

	<div class="flex items-center gap-1">
		<code class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
			{executionId.slice(0, 8)}
		</code>
		<button
			class="rounded p-1 text-muted-foreground hover:text-foreground transition-colors"
			onclick={copyId}
			title="Copy execution ID"
		>
			{#if copyFeedback}
				<Check size={12} class="text-green-500" />
			{:else}
				<Copy size={12} />
			{/if}
		</button>
	</div>

	{#if instanceId}
		<code class="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground" title="Dapr Instance ID">
			{instanceId.slice(0, 12)}
		</code>
	{/if}

	<div class="ml-auto flex items-center gap-1">
		{#if traceId}
			<button
				class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted transition-colors"
				onclick={() => goto(`/observability/${traceId}`)}
			>
				<ExternalLink size={12} />
				View Trace
			</button>
		{/if}
		<a
			href={traceId
				? `/api/observability/mlflow/traces/${encodeURIComponent(traceId)}`
				: `/api/observability/mlflow/executions/${encodeURIComponent(executionId)}`}
			target="_blank"
			rel="noopener noreferrer"
			class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-sky-600 transition-colors hover:bg-muted dark:text-sky-300"
			title="View trace in MLflow"
		>
			<ExternalLink size={12} />
			MLflow
		</a>
	</div>
</div>
