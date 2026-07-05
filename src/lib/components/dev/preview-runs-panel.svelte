<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { ExternalLink, Loader2, RefreshCw } from '@lucide/svelte';
	import { previewRunEvents } from '$lib/stores/preview-run-events.svelte';

	type ProxiedExecution = {
		id: string;
		workflowId: string | null;
		workflowName: string | null;
		status: string;
		phase: string | null;
		progress: number | null;
		error: string | null;
		startedAt: string | null;
		completedAt: string | null;
		durationMs: number | null;
	};

	type ProxyResponse = {
		preview: { name: string; url: string | null };
		result:
			| { ok: true; data: { executions: ProxiedExecution[]; total: number } }
			| { ok: false; reason: string; message?: string };
	};

	let {
		name,
		url = null,
		limit = 10
	}: { name: string; url?: string | null; limit?: number } = $props();

	let executions = $state<ProxiedExecution[]>([]);
	let total = $state(0);
	let loading = $state(true);
	let failure = $state<string | null>(null);
	let refreshTimer: ReturnType<typeof setInterval> | null = null;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	async function load() {
		try {
			const res = await fetch(
				`/api/dev-environments/previews/${encodeURIComponent(name)}/executions?limit=${limit}`
			);
			if (!res.ok) {
				failure = `proxy unavailable (${res.status})`;
				return;
			}
			const body = (await res.json()) as ProxyResponse;
			if (body.result.ok) {
				executions = body.result.data.executions;
				total = body.result.data.total;
				failure = null;
			} else {
				failure = `preview unreachable (${body.result.reason})`;
			}
		} catch (err) {
			failure = err instanceof Error ? err.message : 'proxy request failed';
		} finally {
			loading = false;
		}
	}

	// E1 feed → E2 refresh: when the live feed sees an event for THIS preview,
	// re-pull the proxied list (debounced — bursts collapse to one fetch).
	const eventCount = $derived(previewRunEvents.countFor(name));
	$effect(() => {
		if (eventCount === 0) return;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => void load(), 1500);
	});

	/** Deep link into the preview's own UI for full run detail/interaction. */
	function runLink(run: ProxiedExecution): string | null {
		if (!url) return null;
		return `${url}/workspaces/default/workflows/runs/${run.id}`;
	}

	function statusVariant(status: string) {
		if (status === 'error' || status === 'cancelled') return 'destructive' as const;
		if (status === 'success') return 'secondary' as const;
		return 'default' as const;
	}

	function duration(run: ProxiedExecution): string | null {
		if (run.durationMs == null) return null;
		if (run.durationMs < 1000) return `${run.durationMs}ms`;
		if (run.durationMs < 60_000) return `${Math.round(run.durationMs / 1000)}s`;
		return `${Math.round(run.durationMs / 60_000)}m`;
	}

	onMount(() => {
		void load();
		refreshTimer = setInterval(load, 30_000);
	});
	onDestroy(() => {
		if (refreshTimer) clearInterval(refreshTimer);
		if (debounceTimer) clearTimeout(debounceTimer);
	});
</script>

<div class="rounded-md border bg-muted/20 p-2 text-xs">
	<div class="flex items-center justify-between gap-2">
		<span class="font-medium text-muted-foreground">
			Recent runs{total > 0 ? ` (${total})` : ''}
		</span>
		<button
			type="button"
			class="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
			onclick={() => void load()}
			title="Refresh"
		>
			{#if loading}<Loader2 class="size-3 animate-spin" />{:else}<RefreshCw class="size-3" />{/if}
		</button>
	</div>

	{#if failure}
		<p class="mt-1 text-muted-foreground">{failure}</p>
	{:else if executions.length === 0}
		<p class="mt-1 text-muted-foreground">{loading ? 'Loading…' : 'No runs yet.'}</p>
	{:else}
		<ul class="mt-1 space-y-1">
			{#each executions as run (run.id)}
				{@const link = runLink(run)}
				<li class="flex items-center gap-2">
					<Badge variant={statusVariant(run.status)} class="shrink-0 text-[10px]">
						{run.status}
					</Badge>
					<svelte:element
						this={link ? 'a' : 'span'}
						href={link ?? undefined}
						target={link ? '_blank' : undefined}
						rel={link ? 'noreferrer' : undefined}
						class="min-w-0 flex-1 truncate {link ? 'hover:underline' : ''}"
					>
						{run.workflowName ?? run.workflowId ?? run.id}
						{#if run.phase}<span class="text-muted-foreground"> · {run.phase}</span>{/if}
					</svelte:element>
					{#if duration(run)}
						<span class="shrink-0 text-muted-foreground">{duration(run)}</span>
					{/if}
					{#if run.startedAt}
						<time class="shrink-0 text-muted-foreground" datetime={run.startedAt}>
							{new Date(run.startedAt).toLocaleTimeString()}
						</time>
					{/if}
					{#if link}
						<ExternalLink class="size-3 shrink-0 text-muted-foreground" />
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>
