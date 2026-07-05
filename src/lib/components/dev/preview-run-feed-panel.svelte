<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Activity, ExternalLink } from '@lucide/svelte';
	import { previewRunEvents } from '$lib/stores/preview-run-events.svelte';

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

	// Client buffer is bounded (drop-oldest); the server stream isn't replayed.
	const MAX_RUNS = 200;
	const MAX_RUNS_PER_PREVIEW = 8;

	let runs = $state<RunEvent[]>([]);
	let previews = $state<{ name: string; url: string | null }[]>([]);
	let connected = $state(false);
	let error = $state<string | null>(null);
	let source: EventSource | null = null;

	// Group newest-first runs by preview, seeding from the preview list so an
	// idle preview still shows a card.
	type PreviewGroup = { name: string; url: string | null; runs: RunEvent[] };
	const groups = $derived.by(() => {
		const order: string[] = [];
		const byName: Record<string, PreviewGroup> = {};
		const ensure = (name: string, url: string | null): PreviewGroup => {
			if (!byName[name]) {
				byName[name] = { name, url, runs: [] };
				order.push(name);
			}
			return byName[name];
		};
		for (const p of previews) ensure(p.name, p.url);
		for (const run of runs) {
			const entry = ensure(run.previewName, run.previewUrl);
			if (!entry.url && run.previewUrl) entry.url = run.previewUrl;
			if (entry.runs.length < MAX_RUNS_PER_PREVIEW) entry.runs.push(run);
		}
		return order.map((name) => byName[name]);
	});

	function statusVariant(status: RunEvent['status']) {
		if (status === 'failed') return 'destructive' as const;
		if (status === 'completed') return 'secondary' as const;
		return 'default' as const;
	}

	/** Deep link into the preview's own UI for this run (E2 adds the read-proxy). */
	function runLink(group: { url: string | null }, run: RunEvent): string | null {
		if (!group.url) return null;
		return run.executionId ? `${group.url}/workspaces/default/dev/${run.executionId}` : group.url;
	}

	onMount(() => {
		source = new EventSource('/api/dev-environments/preview-run-feed');
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
				// E2: nudge any per-preview runs panel (read proxy) to re-fetch.
				previewRunEvents.publish({
					previewName: run.previewName,
					eventType: run.eventType,
					executionId: run.executionId,
					at: Date.now()
				});
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
		<span class="text-xs text-muted-foreground">{groups.length} preview{groups.length === 1 ? '' : 's'}</span>
	</header>

	{#if error}
		<p class="mt-2 text-xs text-destructive">{error}</p>
	{/if}

	{#if groups.length === 0}
		<p class="mt-3 text-center text-xs text-muted-foreground">No active previews.</p>
	{:else}
		<div class="mt-3 grid gap-3 sm:grid-cols-2">
			{#each groups as group (group.name)}
				<div class="rounded-md border p-2">
					<div class="flex items-center justify-between gap-2">
						<span class="truncate font-mono text-xs font-medium">{group.name}</span>
						{#if group.url}
							<a
								href={group.url}
								target="_blank"
								rel="noreferrer"
								class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
							>
								open <ExternalLink class="h-3 w-3" />
							</a>
						{/if}
					</div>
					<ul class="mt-2 space-y-1 text-xs">
						{#each group.runs as run (run.executionId + run.at + run.eventType)}
							{@const link = runLink(group, run)}
							<li class="flex items-center gap-2">
								<Badge variant={statusVariant(run.status)} class="shrink-0 text-[10px]">{run.status}</Badge>
								<svelte:element
									this={link ? 'a' : 'span'}
									href={link ?? undefined}
									target={link ? '_blank' : undefined}
									rel={link ? 'noreferrer' : undefined}
									class="min-w-0 flex-1 truncate {link ? 'hover:underline' : ''}"
								>
									{run.workflowName ?? run.workflowId ?? run.executionId ?? 'run'}
									<span class="text-muted-foreground">· {run.eventType.replace('workflow.', '')}</span>
									{#if run.phase}<span class="text-muted-foreground"> · {run.phase}</span>{/if}
									{#if run.progress != null}<span class="text-muted-foreground"> · {run.progress}%</span>{/if}
								</svelte:element>
								<time class="shrink-0 text-muted-foreground" datetime={run.at}>
									{new Date(run.at).toLocaleTimeString()}
								</time>
							</li>
						{:else}
							<li class="text-muted-foreground">Waiting for runs…</li>
						{/each}
					</ul>
				</div>
			{/each}
		</div>
	{/if}
</section>
