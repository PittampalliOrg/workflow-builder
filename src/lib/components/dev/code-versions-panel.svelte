<!--
	Code versions → Promote to PR (docs/code-version-persistence.md).

	Lists the durable, promotable `source-bundle` versions a run produced — for a
	dev-pod-as-source GAN run, one `tar-overlay` version per loop iteration — and
	offers a MANUAL "Promote → PR" per version (the human picks; nothing
	auto-merges). Promote provisions a helper pod, reconstructs the code onto the
	base repo, pushes a branch and opens a PR, then renders the PR link.
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { GitPullRequest, RefreshCw, ExternalLink, Loader2 } from '@lucide/svelte';

	type VersionPayload = {
		tier?: string;
		iteration?: number | null;
		repoUrl?: string | null;
		repoSubdir?: string | null;
		syncPaths?: string[] | null;
	} | null;
	type Promotion = {
		prUrl?: string | null;
		branch?: string | null;
		mode?: string;
		promotedAt?: string;
	} | null;
	type Version = {
		artifactId: string;
		executionId: string;
		nodeId: string | null;
		fileId: string | null;
		sizeBytes: number | null;
		title: string | null;
		payload: VersionPayload;
		promotion: Promotion;
		createdAt: string;
	};

	let {
		executionId,
		live = false,
		onoutstanding
	}: {
		executionId: string;
		live?: boolean;
		/** Called after each load with the count of versions not yet pushed to a GitHub PR. */
		onoutstanding?: (count: number) => void;
	} = $props();

	let versions = $state<Version[]>([]);
	let loading = $state(true);
	let promoting = $state<string | null>(null);
	let results = $state<Record<string, { prUrl?: string | null; branch?: string | null; error?: string }>>(
		{}
	);
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	/** Versions with no GitHub PR yet — un-pushed work to promote before teardown. */
	const outstandingCount = $derived(versions.filter((v) => !v.promotion?.prUrl).length);

	function fmtBytes(n: number | null): string {
		if (!n) return '—';
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}

	async function load() {
		try {
			const res = await fetch(`/api/workflows/executions/${executionId}/versions`);
			if (!res.ok) return;
			const body = (await res.json()) as { versions: Version[] };
			versions = body.versions ?? [];
			onoutstanding?.(versions.filter((v) => !v.promotion?.prUrl).length);
		} catch {
			/* transient */
		} finally {
			loading = false;
		}
	}

	async function promote(v: Version) {
		if (promoting) return;
		promoting = v.artifactId;
		try {
			const res = await fetch(
				`/api/workflows/executions/${executionId}/versions/${v.artifactId}/promote`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ mode: 'pr' })
				}
			);
			const body = (await res.json().catch(() => ({}))) as {
				ok?: boolean;
				prUrl?: string | null;
				branch?: string | null;
				prError?: string | null;
				error?: string;
			};
			if (!res.ok || body.ok === false) {
				results[v.artifactId] = { error: body.error || body.prError || `Promote failed (${res.status})` };
			} else {
				results[v.artifactId] = {
					prUrl: body.prUrl,
					branch: body.branch,
					error: body.prError ?? undefined
				};
			}
			// Refresh so the durable promotion status (PR link, outstanding count) updates
			// immediately rather than waiting for the next poll.
			await load();
		} catch (err) {
			results[v.artifactId] = { error: err instanceof Error ? err.message : String(err) };
		} finally {
			promoting = null;
		}
	}

	onMount(() => {
		void load();
		if (live) pollTimer = setInterval(load, 6000);
	});
	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
	});
</script>

<div class="space-y-2">
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-2">
			<h3 class="text-sm font-medium">Code versions</h3>
			{#if !loading && versions.length > 0}
				{#if outstandingCount > 0}
					<Badge
						variant="outline"
						class="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
						title="Not yet pushed to a GitHub PR — promote before tearing down this preview"
					>
						{outstandingCount} not pushed
					</Badge>
				{:else}
					<Badge variant="outline" class="border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
						all pushed
					</Badge>
				{/if}
			{/if}
		</div>
		<Button variant="ghost" size="sm" onclick={load} title="Refresh">
			<RefreshCw class="size-3.5" />
		</Button>
	</div>

	{#if loading}
		<p class="text-xs text-muted-foreground">Loading versions…</p>
	{:else if versions.length === 0}
		<p class="text-xs text-muted-foreground">
			No code versions captured yet. Each design iteration is snapshotted as it's produced.
		</p>
	{:else}
		<ul class="space-y-2">
			{#each versions as v (v.artifactId)}
				{@const r = results[v.artifactId]}
				{@const prUrl = v.promotion?.prUrl ?? r?.prUrl ?? null}
				<li class="rounded-md border p-2.5 text-xs space-y-1.5">
					<div class="flex items-center gap-2 flex-wrap">
						{#if v.payload?.iteration != null}
							<Badge variant="secondary">iter {v.payload.iteration}</Badge>
						{/if}
						<Badge variant="outline">{v.payload?.tier ?? 'full'}</Badge>
						<span class="text-muted-foreground">{fmtBytes(v.sizeBytes)}</span>
						<span class="text-muted-foreground ml-auto">
							{new Date(v.createdAt).toLocaleTimeString()}
						</span>
					</div>
					<div class="flex items-center gap-2">
						{#if prUrl}
							<a
								href={prUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="inline-flex items-center gap-1 font-medium text-emerald-600 hover:underline dark:text-emerald-400"
							>
								<GitPullRequest class="size-3.5" /> Pushed → PR <ExternalLink class="size-3" />
							</a>
							<Button
								variant="ghost"
								size="sm"
								class="h-7 text-muted-foreground"
								disabled={promoting === v.artifactId || !v.fileId}
								onclick={() => promote(v)}
							>
								{#if promoting === v.artifactId}
									<Loader2 class="size-3.5 animate-spin" /> …
								{:else}
									Promote again
								{/if}
							</Button>
						{:else}
							<Button
								variant="outline"
								size="sm"
								class="h-7"
								disabled={promoting === v.artifactId || !v.fileId}
								onclick={() => promote(v)}
							>
								{#if promoting === v.artifactId}
									<Loader2 class="size-3.5 animate-spin" /> Promoting…
								{:else}
									<GitPullRequest class="size-3.5" /> Promote → PR
								{/if}
							</Button>
							<span class="text-amber-600 dark:text-amber-400">not pushed to GitHub</span>
						{/if}
						{#if r?.branch && !prUrl}
							<span class="text-muted-foreground">branch <code>{r.branch}</code></span>
						{/if}
					</div>
					{#if r?.error}
						<p class="text-destructive">{r.error}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>
