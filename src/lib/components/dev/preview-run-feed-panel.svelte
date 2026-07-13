<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Activity, CheckCircle2, CircleDotDashed, ExternalLink, XCircle } from '@lucide/svelte';
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

	function eventLabel(eventType: string): string {
		return eventType.replace(/^workflow\./, '').replaceAll('_', ' ');
	}

	/** Deep link into the preview's own UI for this run (E2 adds the read-proxy). */
	function runLink(group: { url: string | null }, run: RunEvent): string | null {
		if (!group.url) return null;
		return run.executionId ? `${group.url}/workspaces/default/dev/${run.executionId}` : group.url;
	}

	onMount(() => {
		source = new EventSource('/api/dev-environments/preview-run-feed');
		source.addEventListener('open', () => {
			connected = true;
			error = null;
		});
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

<section aria-labelledby="preview-activity-heading">
	<header class="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
		<div class="flex items-start gap-3">
			<div class="flex size-9 shrink-0 items-center justify-center rounded-md border bg-emerald-500/5">
				<Activity class="size-5 text-emerald-600 dark:text-emerald-400" />
			</div>
			<div>
				<h2 id="preview-activity-heading" class="text-sm font-semibold">Workflow activity</h2>
				<p class="mt-1 text-xs text-muted-foreground">Durable workflow events reported by isolated environments.</p>
			</div>
		</div>
		<div class="flex items-center gap-2 text-xs" aria-live="polite">
			<span class="relative flex size-2" aria-hidden="true">
				{#if connected}<span class="absolute inline-flex size-full rounded-full bg-emerald-400 opacity-60 motion-safe:animate-ping"></span>{/if}
				<span class="relative inline-flex size-2 rounded-full {connected ? 'bg-emerald-500' : 'bg-muted-foreground/40'}"></span>
			</span>
			<span class={connected ? 'text-foreground' : 'text-muted-foreground'}>{connected ? 'Live feed connected' : 'Connecting to feed'}</span>
			<span class="text-muted-foreground">· {groups.length} preview{groups.length === 1 ? '' : 's'}</span>
		</div>
	</header>

	{#if error}
		<p class="mt-2 text-xs text-destructive">{error}</p>
	{/if}

	{#if groups.length === 0}
		<div class="flex min-h-48 flex-col items-center justify-center gap-2 border border-dashed px-5 text-center">
			<CircleDotDashed class="size-5 text-muted-foreground" />
			<p class="text-sm font-medium">No active preview activity</p>
			<p class="text-xs text-muted-foreground">Provision an environment or start a workflow to populate this feed.</p>
		</div>
	{:else}
		<div class="mt-4 grid gap-3 lg:grid-cols-2">
			{#each groups as group (group.name)}
				<article class="min-w-0 rounded-md border bg-card">
					<header class="flex min-h-11 items-center justify-between gap-2 border-b px-3">
						<div class="flex min-w-0 items-center gap-2">
							<span class="size-1.5 shrink-0 rounded-full {group.runs.some((run) => run.status === 'running') ? 'bg-emerald-500' : 'bg-muted-foreground/40'}"></span>
							<span class="truncate font-mono text-xs font-medium">{group.name}</span>
						</div>
						{#if group.url}
							<a
								href={group.url}
								target="_blank"
								rel="noreferrer"
								class="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								aria-label={`Open ${group.name} preview`}
								title="Open preview"
							>
								<ExternalLink class="size-3.5" />
							</a>
						{/if}
					</header>
					<ul class="divide-y text-xs">
						{#each group.runs as run (run.executionId + run.at + run.eventType)}
							{@const link = runLink(group, run)}
							<li class="flex min-h-11 items-center gap-2 px-3 py-2">
								{#if run.status === 'completed'}
									<CheckCircle2 class="size-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
								{:else if run.status === 'failed'}
									<XCircle class="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
								{:else}
									<CircleDotDashed class="size-3.5 shrink-0 text-cyan-500 {run.status === 'running' ? 'motion-safe:animate-pulse' : ''}" aria-hidden="true" />
								{/if}
								<span class="sr-only">{run.status}</span>
								<svelte:element
									this={link ? 'a' : 'span'}
									href={link ?? undefined}
									target={link ? '_blank' : undefined}
									rel={link ? 'noreferrer' : undefined}
									class="min-w-0 flex-1 truncate {link ? 'hover:underline' : ''}"
								>
									<span class="font-medium">{run.workflowName ?? run.workflowId ?? run.executionId ?? 'run'}</span>
									<span class="text-muted-foreground"> · {eventLabel(run.eventType)}</span>
									{#if run.phase}<span class="text-muted-foreground"> · {run.phase}</span>{/if}
									{#if run.progress != null}<span class="text-muted-foreground"> · {run.progress}%</span>{/if}
								</svelte:element>
								<Badge variant={statusVariant(run.status)} class="hidden shrink-0 text-[10px] sm:inline-flex">{run.status}</Badge>
								<time class="w-20 shrink-0 text-right tabular-nums text-muted-foreground" datetime={run.at}>
									{new Date(run.at).toLocaleTimeString()}
								</time>
							</li>
						{:else}
							<li class="flex min-h-20 items-center justify-center px-3 text-muted-foreground">Waiting for workflow events…</li>
						{/each}
					</ul>
				</article>
			{/each}
		</div>
	{/if}
</section>
