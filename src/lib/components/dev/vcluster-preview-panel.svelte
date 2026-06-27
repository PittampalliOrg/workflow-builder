<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Boxes, Plus, ExternalLink, Loader2, Trash2 } from '@lucide/svelte';

	type Preview = {
		name: string;
		phase: string;
		ready: boolean;
		tailnetHost: string | null;
		url: string | null;
	};

	let previews = $state<Preview[]>([]);
	let name = $state('');
	let launching = $state(false);
	let errorMessage = $state<string | null>(null);
	let busy = $state<string | null>(null);
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	async function load() {
		try {
			const res = await fetch('/api/dev-environments/vcluster');
			if (res.ok) previews = ((await res.json()).previews ?? []) as Preview[];
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
		if (phase === 'provisioning' || phase === 'pending')
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
				A fully-isolated vcluster running the whole stack (BFF + orchestrator + function-router) on
				its own database — for end-to-end workflow runs. Takes a few minutes to provision. Log in
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
			{#if launching}<Loader2 class="size-4 animate-spin" />{:else}<Plus class="size-4" />{/if}
			Launch
		</Button>
	</div>

	{#if errorMessage}
		<p class="text-sm text-destructive">{errorMessage}</p>
	{/if}

	{#if previews.length > 0}
		<ul class="divide-y rounded-lg border">
			{#each previews as p (p.name)}
				<li class="flex items-center justify-between gap-3 px-3 py-2">
					<div class="flex items-center gap-2 min-w-0">
						<span class="font-medium truncate">{p.name}</span>
						<span class="text-xs px-1.5 py-0.5 rounded {tone(p.phase)}">{p.phase}</span>
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
				</li>
			{/each}
		</ul>
	{/if}
</section>
