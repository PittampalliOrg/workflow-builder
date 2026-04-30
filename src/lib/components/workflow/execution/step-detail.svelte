<script lang="ts">
	import { CheckCircle2, XCircle, Loader2, Circle } from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import JsonViewer from './json-viewer.svelte';

	interface StepData {
		stepName: string;
		label: string;
		actionType: string;
		status: string;
		input: unknown;
		output: unknown;
		error: string | null;
		durationMs: number | null;
	}

	interface Props {
		step: StepData;
	}

	let { step }: Props = $props();

	let expanded = $state(false);

	function formatDuration(ms: number | null): string {
		if (ms === null) return '—';
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
	}

	function statusVariant(s: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		switch (s) {
			case 'running':
			case 'pending':
				return 'default';
			case 'success':
				return 'secondary';
			case 'error':
				return 'destructive';
			default:
				return 'outline';
		}
	}
</script>

<div class="rounded-md border border-border">
	<button
		class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
		onclick={() => (expanded = !expanded)}
	>
		<!-- Status icon -->
		<span class="shrink-0">
			{#if step.status === 'success'}
				<CheckCircle2 size={16} class="text-green-500" />
			{:else if step.status === 'error'}
				<XCircle size={16} class="text-red-500" />
			{:else if step.status === 'running'}
				<Loader2 size={16} class="text-yellow-500 animate-spin" />
			{:else}
				<Circle size={16} class="text-muted-foreground" />
			{/if}
		</span>

		<!-- Step name -->
		<span class="flex-1 truncate text-sm font-medium">{step.label}</span>

		<!-- Action type badge -->
		{#if step.actionType}
			<Badge variant="outline" class="shrink-0 text-[10px]">{step.actionType}</Badge>
		{/if}

		<!-- Status badge -->
		<Badge variant={statusVariant(step.status)} class="shrink-0 text-[10px]">{step.status}</Badge>

		<!-- Duration -->
		<span class="shrink-0 text-xs text-muted-foreground w-16 text-right">
			{formatDuration(step.durationMs)}
		</span>
	</button>

	{#if expanded}
		<div class="space-y-3 border-t border-border px-4 py-3">
			{#if step.input}
				<JsonViewer data={step.input} label="Input" collapsed={false} />
			{/if}

			{#if step.output}
				<JsonViewer data={step.output} label="Output" collapsed={false} />
			{/if}

			{#if step.error}
				<div class="rounded-md border border-red-200 bg-red-50 px-3 py-2 dark:border-red-800 dark:bg-red-950/30">
					<p class="text-xs font-medium text-red-600 dark:text-red-400">Error</p>
					<pre class="mt-1 max-h-[30vh] overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-red-500">{step.error}</pre>
				</div>
			{/if}
		</div>
	{/if}
</div>
