<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Activity, ExternalLink } from '@lucide/svelte';

	type RunEvent = {
		previewName: string;
		previewUrl: string | null;
		eventType: string;
		executionId: string | null;
		workflowId: string | null;
		workflowName: string | null;
		phase: string | null;
		progress: number | null;
		status: 'running' | 'completed' | 'failed' | 'unknown';
		message: string | null;
		at: string;
	};

	const MAX_RUNS = 100;

	let runs = $state<RunEvent[]>([]);
	let previews = $state<{ name: string; url: string | null }[]>([]);
	let connected = $state(false);
	let error = $state<string | null>(null);
	let source: EventSource | null = null;

	function statusVariant(status: RunEvent['status']) {
		if (status === 'failed') return 'destructive' as const;
		if (status === 'completed') return 'secondary' as const;
		return 'default' as const;
	}

	onMount(() => {
		source = new EventSource('/api/dev-environments/cross-preview-runs');
		source.addEventListener('open', () => (connected = true));
		source.addEventListener('error', () => (connected = false));
		source.addEventListener('previews', (e) => {
			try {
				previews = JSON.parse((e as MessageEvent).data).previews ?? [];
			} catch {
				/* ignore malformed frame */
			}
		});
		source.addEventListener('run', (e) => {
			try {
				const run = JSON.parse((e as MessageEvent).data) as RunEvent;
				runs = [run, ...runs].slice(0, MAX_RUNS);
			} catch {
				/* ignore malformed frame */
			}
		});
		source.addEventListener('feed-error', (e) => {
			try {
				error = JSON.parse((e as MessageEvent).data).error ?? null;
			} catch {
				/* ignore */
			}
		});
	});

	onDestroy(() => source?.close());
</script>

<section class="rounded-lg border bg-card p-4">
	<header class="flex items-center justify-between gap-2">
		<div class="flex items-center gap-2">
			<Activity class="h-4 w-4 text-muted-foreground" />
			<h2 class="text-sm font-semibold">Runs across environments</h2>
			<span
				class="h-2 w-2 rounded-full {connected ? 'bg-green-500' : 'bg-muted-foreground/40'}"
				title={connected ? 'Live' : 'Connecting…'}
			></span>
		</div>
		<span class="text-xs text-muted-foreground">{previews.length} preview{previews.length === 1 ? '' : 's'}</span>
	</header>

	{#if previews.length > 0}
		<div class="mt-2 flex flex-wrap gap-1">
			{#each previews as preview (preview.name)}
				<Badge variant="outline" class="gap-1 text-xs">
					{preview.name}
					{#if preview.url}
						<a href={preview.url} target="_blank" rel="noreferrer" class="inline-flex">
							<ExternalLink class="h-3 w-3" />
						</a>
					{/if}
				</Badge>
			{/each}
		</div>
	{/if}

	{#if error}
		<p class="mt-2 text-xs text-destructive">{error}</p>
	{/if}

	<ul class="mt-3 max-h-80 space-y-1 overflow-y-auto text-xs">
		{#each runs as run (run.previewName + run.executionId + run.at + run.eventType)}
			<li class="flex items-center gap-2 border-b py-1 last:border-b-0">
				<Badge variant={statusVariant(run.status)} class="shrink-0 text-[10px]">{run.status}</Badge>
				<span class="shrink-0 font-mono text-muted-foreground">{run.previewName}</span>
				<span class="min-w-0 flex-1 truncate">
					{run.workflowName ?? run.workflowId ?? run.executionId ?? 'run'}
					<span class="text-muted-foreground">· {run.eventType.replace('workflow.', '')}</span>
					{#if run.phase}<span class="text-muted-foreground"> · {run.phase}</span>{/if}
					{#if run.progress != null}<span class="text-muted-foreground"> · {run.progress}%</span>{/if}
				</span>
				<time class="shrink-0 text-muted-foreground" datetime={run.at}>
					{new Date(run.at).toLocaleTimeString()}
				</time>
			</li>
		{:else}
			<li class="py-2 text-center text-muted-foreground">Waiting for runs…</li>
		{/each}
	</ul>
</section>
