<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Boxes, ChevronDown, ChevronRight, Plus, ExternalLink, Loader2, Trash2, Zap } from '@lucide/svelte';
	import PreviewRunsPanel from '$lib/components/dev/preview-runs-panel.svelte';
	import { teardownConfirmMessage } from '$lib/components/dev/vcluster-preview-teardown-confirm';

	type Preview = {
		name: string;
		targetCluster?: string;
		fallbackCluster?: string;
		isolationTier?: string;
		phase: string;
		ready: boolean;
		tailnetHost: string | null;
		url: string | null;
		/** A3: the backing warm-pool member id when this preview was CLAIMED (instant). */
		pool?: string | null;
		/** A4/D1 lifecycle origin: "user" | "pr" | null (legacy/human preview). */
		origin?: string | null;
	};

	// E2: when the read proxy is enabled, each ready preview grows an
	// expandable "Recent runs" panel (proxied from the preview's own BFF).
	let { readProxyEnabled = false }: { readProxyEnabled?: boolean } = $props();
	let expandedRuns = $state<Record<string, boolean>>({});

	// A3: number of free warm-pool members (from the list counts) — surfaced so a user knows a
	// launch will be instant. 0 (or pool off) = cold provision (a few minutes).
	let poolFree = $state(0);

	let previews = $state<Preview[]>([]);
	let name = $state('');
	let launching = $state(false);
	let errorMessage = $state<string | null>(null);
	let busy = $state<string | null>(null);
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	async function load() {
		try {
			const res = await fetch('/api/dev-environments/vcluster');
			if (res.ok) {
				const body = await res.json();
				previews = (body.previews ?? []) as Preview[];
				poolFree = Number(body.counts?.free ?? 0) || 0;
			}
		} catch {
			/* transient */
		}
	}

	async function launch() {
		const n = name.trim();
		if (!n) return;
		launching = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/dev-environments/vcluster', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: n })
			});
			if (!res.ok) {
				errorMessage = `Launch failed (${res.status})`;
			} else {
				name = '';
				await load();
			}
		} catch (e) {
			errorMessage = e instanceof Error ? e.message : 'Launch failed';
		} finally {
			launching = false;
		}
	}

	async function teardown(p: Preview) {
		// #29: a one-click delete once took out a warm-pool member AND a claimed PR
		// preview in a single session — always confirm, with the alias/backing-member/
		// origin context spelled out.
		if (!confirm(teardownConfirmMessage(p))) return;
		busy = p.name;
		try {
			await fetch(`/api/dev-environments/vcluster/${encodeURIComponent(p.name)}`, {
				method: 'DELETE'
			});
			await load();
		} finally {
			busy = null;
		}
	}

	function tone(phase: string) {
		if (phase === 'ready') return 'bg-green-500/15 text-green-600 dark:text-green-400';
		if (phase === 'failed') return 'bg-red-500/15 text-red-600 dark:text-red-400';
		if (phase === 'provisioning' || phase === 'pending' || phase === 'claiming')
			return 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
		return 'bg-muted text-muted-foreground';
	}

	onMount(() => {
		load();
		pollTimer = setInterval(load, 8000);
	});
	onDestroy(() => pollTimer && clearInterval(pollTimer));
</script>

<section class="rounded-xl border bg-card p-4 space-y-3">
	<div class="flex items-start gap-3">
		<div class="size-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
			<Boxes class="size-5 text-primary" />
		</div>
		<div class="min-w-0">
			<h2 class="text-base font-semibold">Full environments (vcluster)</h2>
			<p class="text-sm text-muted-foreground">
				A dev-primary vcluster running the whole stack (BFF + orchestrator + function-router) on
				its own database. Ryzen remains a canary/fallback path. Takes a few minutes to provision. Log in
				with <code class="text-xs">preview@local</code> / <code class="text-xs">preview-access</code>.
			</p>
		</div>
	</div>

	<div class="flex items-center gap-2">
		<input
			class="flex h-9 w-48 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			placeholder="preview name (e.g. feat-x)"
			bind:value={name}
			onkeydown={(e) => e.key === 'Enter' && launch()}
			disabled={launching}
		/>
		<Button size="sm" onclick={launch} disabled={launching || !name.trim()}>
			{#if launching}<Loader2 class="size-4 animate-spin" />{:else if poolFree > 0}<Zap
					class="size-4"
				/>{:else}<Plus class="size-4" />{/if}
			Launch
		</Button>
		{#if poolFree > 0}
			<span
				class="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-green-500/15 text-green-600 dark:text-green-400"
				title="A warm vcluster is pre-baked — your launch is claimed instantly instead of a multi-minute cold provision"
			>
				<Zap class="size-3" /> instant · {poolFree} warm
			</span>
		{/if}
	</div>

	{#if errorMessage}
		<p class="text-sm text-destructive">{errorMessage}</p>
	{/if}

	{#if previews.length > 0}
		<ul class="divide-y rounded-lg border">
			{#each previews as p (p.name)}
				<li class="px-3 py-2">
					<div class="flex items-center justify-between gap-3">
						<div class="flex items-center gap-2 min-w-0">
							{#if readProxyEnabled && p.ready}
								<button
									type="button"
									class="shrink-0 text-muted-foreground hover:text-foreground"
									onclick={() => (expandedRuns = { ...expandedRuns, [p.name]: !expandedRuns[p.name] })}
									title="Recent runs"
								>
									{#if expandedRuns[p.name]}<ChevronDown class="size-4" />{:else}<ChevronRight
											class="size-4"
										/>{/if}
								</button>
							{/if}
							<span class="font-medium truncate">{p.name}</span>
							<span class="text-xs px-1.5 py-0.5 rounded {tone(p.phase)}">{p.phase}</span>
							{#if p.pool}
								<span
									class="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-green-500/15 text-green-600 dark:text-green-400"
									title="Claimed instantly from the warm pool ({p.pool})"
								>
									<Zap class="size-3" /> pooled
								</span>
							{/if}
							<span class="text-xs text-muted-foreground">{p.targetCluster ?? 'dev'}</span>
						</div>
						<div class="flex items-center gap-1 shrink-0">
							{#if p.ready && p.url}
								<a
									href={p.url}
									target="_blank"
									rel="noopener noreferrer"
									class="inline-flex items-center gap-1 text-sm text-primary hover:underline"
								>
									Open <ExternalLink class="size-3.5" />
								</a>
							{/if}
							<Button
								size="icon"
								variant="ghost"
								class="size-8"
								onclick={() => teardown(p)}
								disabled={busy === p.name}
								title="Tear down"
							>
								{#if busy === p.name}<Loader2 class="size-4 animate-spin" />{:else}<Trash2
										class="size-4"
									/>{/if}
							</Button>
						</div>
					</div>
					{#if readProxyEnabled && p.ready && expandedRuns[p.name]}
						<div class="mt-2">
							<PreviewRunsPanel name={p.name} url={p.url} />
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>
