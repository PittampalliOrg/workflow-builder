<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import HeadlampLogo from '$lib/components/gitops/icons/HeadlampLogo.svelte';
	import { DEFAULT_HEADLAMP_URL, headlampCustomResourceUrl, headlampResourceUrl } from '$lib/headlamp/links';

	type Runtime = {
		name: string;
		namespace?: string;
		slug: string | null;
		appId: string;
		phase: string;
		replicas: number;
		readyReplicas: number;
		lastActiveAt: string | null;
		imageTag: string | null;
		mcpServers: string[];
		idleTtlSeconds: number;
		browserSidecarEnabled?: boolean;
		pod?: { name: string; containers: Array<{ name: string; ready: boolean }> } | null;
	};

	let runtimes = $state<Runtime[]>([]);
	let loading = $state(true);
	let err = $state<string | null>(null);
	let busy = $state<Record<string, 'wake' | 'sleep' | null>>({});
	let timer: ReturnType<typeof setInterval> | null = null;
	let filter = $state<'all' | 'active' | 'sleeping' | 'browser'>('all');

	async function refresh() {
		try {
			const res = await fetch('/api/v1/agent-runtimes');
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			const body = (await res.json()) as { runtimes: Runtime[] };
			runtimes = body.runtimes;
			err = null;
		} catch (e) {
			err = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	async function action(slug: string, verb: 'wake' | 'sleep') {
		busy = { ...busy, [slug]: verb };
		try {
			await fetch(`/api/v1/agent-runtimes/${encodeURIComponent(slug)}/${verb}`, {
				method: 'POST'
			});
			await refresh();
		} finally {
			busy = { ...busy, [slug]: null };
		}
	}

	function phaseColor(phase: string): string {
		switch (phase) {
			case 'Active':
				return 'bg-emerald-500';
			case 'Starting':
				return 'bg-amber-500 animate-pulse';
			case 'Sleeping':
				return 'bg-slate-500';
			case 'Failed':
				return 'bg-red-600';
			default:
				return 'bg-slate-400';
		}
	}

	function relativeTime(iso: string | null): string {
		if (!iso) return '—';
		const diff = Math.max(0, Date.now() - new Date(iso).getTime());
		const sec = Math.floor(diff / 1000);
		if (sec < 60) return `${sec}s ago`;
		const min = Math.floor(sec / 60);
		if (min < 60) return `${min}m ago`;
		const hr = Math.floor(min / 60);
		if (hr < 24) return `${hr}h ago`;
		return `${Math.floor(hr / 24)}d ago`;
	}

	function runtimePoolUrl(rt: Runtime): string | null {
		return headlampCustomResourceUrl({
			headlampBase: DEFAULT_HEADLAMP_URL,
			cluster: 'ryzen',
			crd: 'sandboxwarmpools.extensions.agents.x-k8s.io',
			namespace: rt.namespace ?? 'workflow-builder',
			name: rt.name
		});
	}

	function runtimePodUrl(rt: Runtime): string | null {
		if (!rt.pod?.name) return null;
		return headlampResourceUrl({
			headlampBase: DEFAULT_HEADLAMP_URL,
			cluster: 'ryzen',
			kind: 'Pod',
			namespace: rt.namespace ?? 'workflow-builder',
			name: rt.pod.name
		});
	}

	const filtered = $derived(
		filter === 'all'
			? runtimes
			: filter === 'active'
				? runtimes.filter((r) => r.phase === 'Active' || r.phase === 'Starting')
				: filter === 'sleeping'
					? runtimes.filter((r) => r.phase === 'Sleeping')
					: runtimes.filter((r) => r.browserSidecarEnabled === true),
	);

	const stats = $derived({
		total: runtimes.length,
		active: runtimes.filter((r) => r.phase === 'Active').length,
		sleeping: runtimes.filter((r) => r.phase === 'Sleeping').length,
		failed: runtimes.filter((r) => r.phase === 'Failed').length,
		browser: runtimes.filter((r) => r.browserSidecarEnabled === true).length,
	});

	onMount(() => {
		void refresh();
		timer = setInterval(() => void refresh(), 10_000);
	});

	onDestroy(() => {
		if (timer) clearInterval(timer);
	});
</script>

<div class="h-full overflow-y-auto p-6 space-y-4">
	<div class="flex items-baseline justify-between">
		<div>
			<h1 class="text-2xl font-semibold">Agent Runtimes</h1>
			<p class="text-sm text-muted-foreground">
				One Kubernetes Deployment per published agent. Scales to 0 when idle.
			</p>
		</div>
		<Button variant="outline" onclick={refresh} disabled={loading}>Refresh</Button>
	</div>

	<div class="grid grid-cols-5 gap-3">
		{#each [['Total', stats.total, 'bg-slate-400'], ['Active', stats.active, 'bg-emerald-500'], ['Sleeping', stats.sleeping, 'bg-slate-500'], ['Failed', stats.failed, 'bg-red-600'], ['Browser', stats.browser, 'bg-sky-500']] as [label, n, color]}
			<div class="rounded-lg border bg-card p-3">
				<div class="flex items-center gap-1.5">
					<span class={`h-1.5 w-1.5 rounded-full ${color as string}`}></span>
					<span class="text-xs text-muted-foreground">{label}</span>
				</div>
				<div class="text-2xl font-semibold mt-1">{n}</div>
			</div>
		{/each}
	</div>

	<div class="flex gap-2">
		<Button variant={filter === 'all' ? 'default' : 'outline'} size="sm" onclick={() => (filter = 'all')}>
			All
		</Button>
		<Button
			variant={filter === 'active' ? 'default' : 'outline'}
			size="sm"
			onclick={() => (filter = 'active')}
		>
			Active / Starting
		</Button>
		<Button
			variant={filter === 'sleeping' ? 'default' : 'outline'}
			size="sm"
			onclick={() => (filter = 'sleeping')}
		>
			Sleeping
		</Button>
		<Button
			variant={filter === 'browser' ? 'default' : 'outline'}
			size="sm"
			onclick={() => (filter = 'browser')}
			title="Only show agents with a chromium + playwright-mcp sidecar"
		>
			🌐 Browser
		</Button>
	</div>

	{#if err}
		<div class="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
			{err}
		</div>
	{/if}

	<div class="rounded-lg border overflow-hidden">
		<table class="w-full text-sm">
			<thead class="bg-muted/50">
				<tr class="text-left">
					<th class="px-3 py-2 font-medium">Slug</th>
					<th class="px-3 py-2 font-medium">Phase</th>
					<th class="px-3 py-2 font-medium">Replicas</th>
					<th class="px-3 py-2 font-medium">MCPs</th>
					<th class="px-3 py-2 font-medium w-8" title="Browser sidecar (chromium + playwright-mcp)">🌐</th>
					<th class="px-3 py-2 font-medium">K8s</th>
					<th class="px-3 py-2 font-medium">Last active</th>
					<th class="px-3 py-2 font-medium">Idle TTL</th>
					<th class="px-3 py-2 font-medium text-right">Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each filtered as rt (rt.name)}
					<tr class="border-t">
						<td class="px-3 py-2 font-mono text-xs">{rt.slug}</td>
						<td class="px-3 py-2">
							<span class="inline-flex items-center gap-1.5">
								<span class={`h-1.5 w-1.5 rounded-full ${phaseColor(rt.phase)}`}></span>
								{rt.phase}
							</span>
						</td>
						<td class="px-3 py-2">{rt.readyReplicas}/{rt.replicas}</td>
						<td class="px-3 py-2 text-xs">
							{rt.mcpServers.length ? rt.mcpServers.join(', ') : '—'}
						</td>
						<td class="px-3 py-2 text-center">
							{#if rt.browserSidecarEnabled}
								<span aria-label="Browser sidecar enabled" title="chromium + playwright-mcp">🌐</span>
							{:else}
								<span class="text-muted-foreground/40">—</span>
							{/if}
						</td>
						<td class="px-3 py-2 text-xs">
							<div class="flex flex-wrap gap-1">
								<a
									href={runtimePoolUrl(rt) ?? undefined}
									target="_blank"
									rel="noopener noreferrer"
									class="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
									title="Open SandboxWarmPool in Headlamp"
								>
									<HeadlampLogo class="h-3 w-3" />
									Pool
								</a>
								{#if runtimePodUrl(rt)}
									<a
										href={runtimePodUrl(rt) ?? undefined}
										target="_blank"
										rel="noopener noreferrer"
										class="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
										title="Open active runtime Pod in Headlamp"
									>
										<HeadlampLogo class="h-3 w-3" />
										Pod
									</a>
								{/if}
							</div>
						</td>
						<td class="px-3 py-2 text-xs">{relativeTime(rt.lastActiveAt)}</td>
						<td class="px-3 py-2 text-xs">{(rt.idleTtlSeconds / 60).toFixed(0)}m</td>
						<td class="px-3 py-2 text-right">
							<div class="inline-flex gap-1">
								<Button
									size="sm"
									variant="outline"
									disabled={!rt.slug || (busy[rt.slug] !== undefined && busy[rt.slug] !== null)}
									onclick={() => rt.slug && action(rt.slug, 'wake')}
								>
									{rt.slug && busy[rt.slug] === 'wake' ? '…' : 'Wake'}
								</Button>
								<Button
									size="sm"
									variant="outline"
									disabled={!rt.slug || (busy[rt.slug] !== undefined && busy[rt.slug] !== null)}
									onclick={() => rt.slug && action(rt.slug, 'sleep')}
								>
									{rt.slug && busy[rt.slug] === 'sleep' ? '…' : 'Sleep'}
								</Button>
							</div>
						</td>
					</tr>
				{/each}
				{#if filtered.length === 0}
					<tr>
						<td colspan="9" class="px-3 py-6 text-center text-sm text-muted-foreground">
							{loading ? 'Loading…' : 'No runtimes match this filter.'}
						</td>
					</tr>
				{/if}
			</tbody>
		</table>
	</div>
</div>
