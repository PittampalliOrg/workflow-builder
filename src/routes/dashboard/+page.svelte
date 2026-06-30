<script lang="ts">
	import { onMount } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { DEFAULT_WORKSPACE_SLUG } from '$lib/utils/workspace-path';
	import { Button } from '$lib/components/ui/button';
	import {
		Boxes,
		Cpu,
		GitBranch,
		MessagesSquare,
		Workflow,
		ExternalLink,
		RefreshCw,
		Sparkles,
		KeyRound,
		MessageSquare,
		Radio,
		ShieldAlert,
		Bot,
		Layers
	} from '@lucide/svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const slug = DEFAULT_WORKSPACE_SLUG;

	let displayName = $derived(
		data.user?.name?.split(' ')[0] ?? data.user?.email?.split('@')[0] ?? 'operator'
	);
	let greeting = $derived.by(() => {
		const hour = new Date().getHours();
		if (hour < 12) return 'Good morning';
		if (hour < 18) return 'Good afternoon';
		return 'Good evening';
	});

	// --- Signature live clock (cosmetic) -----------------------------------
	let now = $state(new Date());
	let refreshing = $state(false);
	onMount(() => {
		const t = setInterval(() => (now = new Date()), 1000);
		return () => clearInterval(t);
	});
	let utc = $derived(`${now.toISOString().slice(11, 19)} UTC`);

	async function refresh() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}

	function formatRelative(iso: string | null): string {
		if (!iso) return '—';
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		return new Date(iso).toLocaleDateString();
	}
	function compact(n: number | null | undefined): string {
		if (n == null) return '—';
		if (n < 1000) return String(n);
		if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
		return `${(n / 1_000_000).toFixed(1)}m`;
	}

	// --- Status → tone mapping ---------------------------------------------
	type Tone = 'good' | 'run' | 'warn' | 'bad' | 'idle';
	const toneClass: Record<Tone, string> = {
		good: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30',
		run: 'text-sky-500 bg-sky-500/10 border-sky-500/30',
		warn: 'text-amber-500 bg-amber-500/10 border-amber-500/30',
		bad: 'text-rose-500 bg-rose-500/10 border-rose-500/30',
		idle: 'text-muted-foreground bg-muted border-border'
	};
	const dotClass: Record<Tone, string> = {
		good: 'bg-emerald-500',
		run: 'bg-sky-500',
		warn: 'bg-amber-500',
		bad: 'bg-rose-500',
		idle: 'bg-muted-foreground/50'
	};

	function runTone(status: string): Tone {
		if (status === 'success') return 'good';
		if (status === 'running' || status === 'pending') return 'run';
		if (status === 'error') return 'bad';
		return 'idle';
	}
	function sessionTone(status: string): Tone {
		if (status === 'running') return 'run';
		if (status === 'idle') return 'warn';
		return 'idle';
	}
	function fleetTone(phase: string): Tone {
		if (phase === 'Active') return 'good';
		if (phase === 'Starting') return 'run';
		if (phase === 'Sleeping') return 'idle';
		return 'warn';
	}
	function gitopsTone(phase: string | null, type: string): Tone {
		const p = (phase ?? type ?? '').toLowerCase();
		if (/(health|sync|succeed|complete|ready|active)/.test(p)) return 'good';
		if (/(progress|running|reconcil|pending|wait)/.test(p)) return 'run';
		if (/(degrad|fail|error|unhealth)/.test(p)) return 'bad';
		if (/(outofsync|drift|warn|missing|suspend)/.test(p)) return 'warn';
		return 'idle';
	}

	// --- Per-domain identity (signature numerals + anchors) ----------------
	type Domain = {
		idx: string;
		key: string;
		label: string;
		anchor: string;
		accent: string;
		health: () => Tone;
		metric: () => string;
		sub: () => string;
	};

	const domains: Domain[] = [
		{
			idx: '01',
			key: 'sessions',
			label: 'Sessions',
			anchor: 'sec-sessions',
			accent: 'text-sky-500',
			health: () =>
				!data.sessions.ok ? 'idle' : data.sessions.counts.running > 0 ? 'run' : 'idle',
			metric: () =>
				String(data.sessions.stats?.activeSessions ?? data.sessions.counts.running),
			sub: () => 'active'
		},
		{
			idx: '02',
			key: 'workflows',
			label: 'Workflows',
			anchor: 'sec-workflows',
			accent: 'text-violet-500',
			health: () => {
				if (!data.workflows.ok) return 'idle';
				if ((data.workflows.counts.error ?? 0) > 0) return 'bad';
				return data.workflows.running > 0 ? 'run' : 'good';
			},
			metric: () => String(data.workflows.running),
			sub: () => 'running'
		},
		{
			idx: '03',
			key: 'fleet',
			label: 'Fleet',
			anchor: 'sec-fleet',
			accent: 'text-emerald-500',
			health: () => {
				if ((data.fleet.capacity?.blockedWorkloads ?? 0) > 0) return 'warn';
				return (data.fleet.phaseCounts['Active'] ?? 0) > 0 ? 'good' : 'idle';
			},
			metric: () => String(data.fleet.readyReplicas),
			sub: () => 'ready pods'
		},
		{
			idx: '04',
			key: 'previews',
			label: 'Previews',
			anchor: 'sec-previews',
			accent: 'text-amber-500',
			health: () =>
				!data.previews.ok
					? 'idle'
					: data.previews.building > 0
						? 'run'
						: data.previews.ready > 0
							? 'good'
							: 'idle',
			metric: () => String(data.previews.ready),
			sub: () => 'live'
		},
		{
			idx: '05',
			key: 'gitops',
			label: 'GitOps',
			anchor: 'sec-gitops',
			accent: 'text-rose-500',
			health: () => {
				if (data.gitops.restricted || !data.gitops.ok) return 'idle';
				const bad = data.gitops.events.some(
					(e) => gitopsTone(e.phase, e.activityType) === 'bad'
				);
				return bad ? 'bad' : data.gitops.events.length > 0 ? 'good' : 'idle';
			},
			metric: () => String(data.gitops.events.length),
			sub: () => 'events'
		}
	];

	function scrollTo(id: string) {
		document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}
	function eventLabel(ref: { kind: string | null; name: string | null }): string {
		return ref.name ?? ref.kind ?? 'resource';
	}
</script>

<div class="cc-root h-full overflow-y-auto">
	<div class="mx-auto w-full max-w-[1500px] px-5 pb-16 sm:px-7">
		<!-- ============================================================== -->
		<!-- SIGNATURE: command ridge                                       -->
		<!-- ============================================================== -->
		<header
			class="cc-ridge sticky top-0 z-20 -mx-5 mb-6 border-b border-border/70 px-5 py-3 sm:-mx-7 sm:px-7"
		>
			<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
				<div class="flex items-center gap-2.5">
					<span class="relative flex size-2.5">
						<span
							class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/70"
						></span>
						<span class="relative inline-flex size-2.5 rounded-full bg-emerald-500"></span>
					</span>
					<span class="font-mono text-[13px] font-semibold tracking-[0.2em] text-foreground">
						COMMAND&nbsp;CENTER
					</span>
					<span
						class="hidden font-mono text-[10px] tracking-[0.25em] text-emerald-500 sm:inline"
					>
						// OPERATIONAL
					</span>
				</div>

				<nav
					class="order-3 flex w-full flex-wrap items-center gap-1.5 lg:order-2 lg:w-auto"
				>
					{#each domains as d (d.key)}
						{@const tone = d.health()}
						<button
							type="button"
							onclick={() => scrollTo(d.anchor)}
							class="group inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/40 px-2.5 py-1 font-mono text-[10px] tracking-wider text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
						>
							<span class="size-1.5 rounded-full {dotClass[tone]}"></span>
							<span class="uppercase">{d.label}</span>
							<span class="tabular-nums text-foreground/80">{d.metric()}</span>
						</button>
					{/each}
				</nav>

				<div class="order-2 ml-auto flex items-center gap-2 lg:order-3">
					<span
						class="hidden font-mono text-[11px] tabular-nums tracking-wider text-muted-foreground sm:inline"
					>
						{utc}
					</span>
					<Button
						variant="outline"
						size="sm"
						class="h-7 gap-1.5 font-mono text-[11px] tracking-wider"
						onclick={refresh}
						disabled={refreshing}
					>
						<RefreshCw class="size-3 {refreshing ? 'animate-spin' : ''}" />
						SYNC
					</Button>
				</div>
			</div>
		</header>

		<!-- greeting + primary actions -->
		<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
			<div>
				<h1 class="text-2xl font-semibold tracking-tight">{greeting}, {displayName}</h1>
				<p class="mt-1 font-mono text-[11px] tracking-wide text-muted-foreground">
					PLATFORM SNAPSHOT · {data.fleet.capacity?.cluster ?? 'workflow-builder'} ·
					LAST&nbsp;SYNC&nbsp;{formatRelative(data.generatedAt)}
				</p>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<Button size="sm" onclick={() => goto(`/workspaces/${slug}/agents/quickstart`)}>
					<Sparkles class="size-4" /> New agent
				</Button>
				<Button variant="outline" size="sm" onclick={() => goto('/workbench')}>
					<MessageSquare class="size-4" /> Prompt
				</Button>
				<Button
					variant="outline"
					size="sm"
					onclick={() => goto(`/workspaces/${slug}/settings/keys`)}
				>
					<KeyRound class="size-4" /> API key
				</Button>
			</div>
		</div>

		<!-- ============================================================== -->
		<!-- VITAL SIGNS — one tile per domain                              -->
		<!-- ============================================================== -->
		<section class="mb-7 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
			{#each domains as d (d.key)}
				{@const tone = d.health()}
				<button
					type="button"
					onclick={() => scrollTo(d.anchor)}
					class="cc-tile group relative overflow-hidden rounded-xl border border-border/70 bg-card p-4 text-left transition-all hover:border-foreground/25 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
				>
					<span class="cc-numeral {d.accent}">{d.idx}</span>
					<div class="relative flex items-center gap-1.5">
						<span class="size-1.5 rounded-full {dotClass[tone]}"></span>
						<span
							class="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"
						>
							{d.label}
						</span>
					</div>
					<div class="relative mt-2 flex items-baseline gap-1.5">
						<span class="text-3xl font-semibold tabular-nums leading-none">{d.metric()}</span>
						<span class="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
							{d.sub()}
						</span>
					</div>
				</button>
			{/each}
		</section>

		<!-- ============================================================== -->
		<!-- SECTIONS                                                       -->
		<!-- ============================================================== -->
		<div class="grid grid-cols-1 gap-5 xl:grid-cols-2">
			<!-- 01 · SESSIONS -->
			<section id="sec-sessions" class="cc-panel cc-rail-sky scroll-mt-20">
				<div class="cc-head">
					<div class="flex items-center gap-2.5">
						<span class="cc-idx text-sky-500">01</span>
						<MessagesSquare class="size-4 text-sky-500" />
						<h2 class="cc-title">Sessions</h2>
					</div>
					<div class="flex items-center gap-1.5">
						<span class="cc-chip {toneClass.run}">{data.sessions.counts.running} running</span>
						<span class="cc-chip {toneClass.warn}">{data.sessions.counts.idle} idle</span>
						<a class="cc-viewall" href="/workspaces/{slug}/sessions">
							all <ExternalLink class="size-3" />
						</a>
					</div>
				</div>
				<div class="cc-body">
					{#if data.sessions.stats}
						<div class="mb-3 grid grid-cols-3 gap-2 border-b border-border/60 pb-3 font-mono">
							<div>
								<div class="text-lg font-semibold tabular-nums">
									{data.sessions.stats.sessionsToday}
								</div>
								<div class="text-[10px] uppercase tracking-wide text-muted-foreground">today</div>
							</div>
							<div>
								<div class="text-lg font-semibold tabular-nums">
									{compact(data.sessions.stats.tokensOut7d)}
								</div>
								<div class="text-[10px] uppercase tracking-wide text-muted-foreground">
									tok out 7d
								</div>
							</div>
							<div>
								<div class="text-lg font-semibold tabular-nums">
									{data.sessions.stats.archivedLast24h}
								</div>
								<div class="text-[10px] uppercase tracking-wide text-muted-foreground">
									archived 24h
								</div>
							</div>
						</div>
					{/if}
					{#if data.sessions.active.length === 0}
						<p class="cc-empty">
							No active sessions.
							<a class="text-primary hover:underline" href="/workspaces/{slug}/sessions/new">
								Start one →
							</a>
						</p>
					{:else}
						<ul class="divide-y divide-border/60">
							{#each data.sessions.active as s (s.id)}
								{@const tone = sessionTone(s.status)}
								<li>
									<a
										href="/workspaces/{slug}/sessions/{s.id}"
										class="-mx-2 flex items-center gap-2.5 rounded-md px-2 py-2 hover:bg-muted/50"
									>
										<span class="text-base leading-none">{s.agentAvatar ?? '🤖'}</span>
										<div class="min-w-0 flex-1">
											<div class="truncate text-sm">{s.title ?? 'Untitled session'}</div>
											<div class="truncate font-mono text-[10px] text-muted-foreground">
												{s.agentName} · {formatRelative(s.updatedAt)}
											</div>
										</div>
										<span class="cc-chip {toneClass[tone]}">
											<span class="size-1.5 rounded-full {dotClass[tone]}"></span>
											{s.status}
										</span>
									</a>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</section>

			<!-- 02 · WORKFLOWS -->
			<section id="sec-workflows" class="cc-panel cc-rail-violet scroll-mt-20">
				<div class="cc-head">
					<div class="flex items-center gap-2.5">
						<span class="cc-idx text-violet-500">02</span>
						<Workflow class="size-4 text-violet-500" />
						<h2 class="cc-title">Workflows</h2>
					</div>
					<div class="flex items-center gap-1.5">
						{#if (data.workflows.counts.success ?? 0) > 0}
							<span class="cc-chip {toneClass.good}">{data.workflows.counts.success} ok</span>
						{/if}
						{#if (data.workflows.counts.error ?? 0) > 0}
							<span class="cc-chip {toneClass.bad}">{data.workflows.counts.error} err</span>
						{/if}
						<a class="cc-viewall" href="/workspaces/{slug}/runs">
							all <ExternalLink class="size-3" />
						</a>
					</div>
				</div>
				<div class="cc-body">
					{#if data.workflows.runs.length === 0}
						<p class="cc-empty">No recent workflow runs.</p>
					{:else}
						<ul class="divide-y divide-border/60">
							{#each data.workflows.runs as r (r.executionId)}
								{@const tone = runTone(r.status)}
								<li>
									<a
										href="/workspaces/{slug}/workflows/{r.workflowId}/runs/{r.executionId}"
										class="-mx-2 flex items-center gap-2.5 rounded-md px-2 py-2 hover:bg-muted/50"
									>
										<span class="size-2 shrink-0 rounded-full {dotClass[tone]}"></span>
										<div class="min-w-0 flex-1">
											<div class="truncate text-sm" title={r.workflowName}>{r.workflowName}</div>
											<div class="font-mono text-[10px] text-muted-foreground">
												{formatRelative(r.startedAt)}{#if r.sessionCount > 0}
													· {r.sessionCount} session{r.sessionCount === 1 ? '' : 's'}{/if}{#if r.durationMs != null}
													· {(r.durationMs / 1000).toFixed(1)}s{/if}
											</div>
										</div>
										<span class="cc-chip {toneClass[tone]}">{r.status}</span>
									</a>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</section>

			<!-- 03 · FLEET -->
			<section id="sec-fleet" class="cc-panel cc-rail-emerald scroll-mt-20">
				<div class="cc-head">
					<div class="flex items-center gap-2.5">
						<span class="cc-idx text-emerald-500">03</span>
						<Cpu class="size-4 text-emerald-500" />
						<h2 class="cc-title">Fleet</h2>
					</div>
					<div class="flex items-center gap-1.5">
						<span class="cc-chip {toneClass.good}">
							{data.fleet.phaseCounts['Active'] ?? 0} active
						</span>
						<span class="cc-chip {toneClass.idle}">
							{data.fleet.phaseCounts['Sleeping'] ?? 0} asleep
						</span>
						<a class="cc-viewall" href="/admin/runtimes">
							all <ExternalLink class="size-3" />
						</a>
					</div>
				</div>
				<div class="cc-body">
					{#if data.fleet.capacity}
						<div class="mb-3 grid grid-cols-3 gap-2 border-b border-border/60 pb-3 font-mono">
							<div>
								<div class="text-lg font-semibold tabular-nums">
									{data.fleet.readyReplicas}/{data.fleet.desiredReplicas}
								</div>
								<div class="text-[10px] uppercase tracking-wide text-muted-foreground">
									pods ready
								</div>
							</div>
							<div>
								<div
									class="text-lg font-semibold tabular-nums {(data.fleet.capacity
										.blockedWorkloads ?? 0) > 0
										? 'text-amber-500'
										: ''}"
								>
									{data.fleet.capacity.blockedWorkloads}
								</div>
								<div class="text-[10px] uppercase tracking-wide text-muted-foreground">blocked</div>
							</div>
							<div>
								<div class="text-lg font-semibold tabular-nums">
									{data.fleet.capacity.activeWork ?? '—'}
								</div>
								<div class="text-[10px] uppercase tracking-wide text-muted-foreground">
									active work
								</div>
							</div>
						</div>
					{:else if data.fleet.capacityError}
						<p class="mb-3 border-b border-border/60 pb-3 font-mono text-[10px] text-muted-foreground">
							capacity observer offline — {data.fleet.capacityError}
						</p>
					{/if}

					{#if data.fleet.runtimes.length === 0 && (!data.fleet.capacity || data.fleet.capacity.queues.length === 0)}
						<p class="cc-empty">No agent runtimes provisioned.</p>
					{:else}
						{#if data.fleet.runtimes.length > 0}
							<ul class="divide-y divide-border/60">
								{#each data.fleet.runtimes.slice(0, 5) as rt (rt.name)}
									{@const tone = fleetTone(rt.phase)}
									<li class="-mx-2 flex items-center gap-2.5 rounded-md px-2 py-2">
										<span class="size-2 shrink-0 rounded-full {dotClass[tone]}"></span>
										<div class="min-w-0 flex-1">
											<div class="truncate font-mono text-xs">{rt.slug ?? rt.name}</div>
											<div class="font-mono text-[10px] text-muted-foreground">
												{rt.readyReplicas}/{rt.desiredReplicas} replicas{#if rt.browserSidecarEnabled}
													· browser{/if}
											</div>
										</div>
										<span class="cc-chip {toneClass[tone]}">{rt.phase}</span>
									</li>
								{/each}
							</ul>
						{/if}
						{#if data.fleet.capacity && data.fleet.capacity.queues.length > 0}
							<div class="mt-2 flex flex-wrap gap-1.5 border-t border-border/60 pt-3">
								{#each data.fleet.capacity.queues.slice(0, 6) as q (q.name)}
									<span class="cc-chip {q.pending > 0 ? toneClass.warn : toneClass.idle}">
										{q.name}: {q.admitted}▲{#if q.pending > 0} {q.pending}⧖{/if}
									</span>
								{/each}
							</div>
						{/if}
					{/if}
				</div>
			</section>

			<!-- 04 · PREVIEW ENVIRONMENTS -->
			<section id="sec-previews" class="cc-panel cc-rail-amber scroll-mt-20">
				<div class="cc-head">
					<div class="flex items-center gap-2.5">
						<span class="cc-idx text-amber-500">04</span>
						<Boxes class="size-4 text-amber-500" />
						<h2 class="cc-title">Preview Environments</h2>
					</div>
					<div class="flex items-center gap-1.5">
						<span class="cc-chip {toneClass.good}">{data.previews.ready} ready</span>
						{#if data.previews.building > 0}
							<span class="cc-chip {toneClass.run}">{data.previews.building} building</span>
						{/if}
						<a class="cc-viewall" href="/workspaces/{slug}/dev">
							all <ExternalLink class="size-3" />
						</a>
					</div>
				</div>
				<div class="cc-body">
					{#if data.previews.environments.length === 0}
						<p class="cc-empty">No active preview environments.</p>
					{:else}
						<ul class="grid grid-cols-1 gap-2 sm:grid-cols-2">
							{#each data.previews.environments.slice(0, 6) as env (env.executionId + env.service)}
								{@const tone = env.ready ? 'good' : 'run'}
								<li class="rounded-lg border border-border/60 bg-muted/20 p-2.5">
									<div class="flex items-center justify-between gap-2">
										<span class="truncate font-mono text-xs font-medium">{env.service}</span>
										<span class="cc-chip {toneClass[tone]}">
											<span class="size-1.5 rounded-full {dotClass[tone]}"></span>
											{env.ready ? 'ready' : 'building'}
										</span>
									</div>
									<div class="mt-1 truncate font-mono text-[10px] text-muted-foreground">
										{env.workspaceRef} · {formatRelative(env.createdAt)}
									</div>
									<div class="mt-2 flex items-center gap-2">
										{#if env.browseUrl}
											<a
												href={env.browseUrl}
												target="_blank"
												rel="noopener noreferrer"
												class="inline-flex items-center gap-1 font-mono text-[10px] text-amber-600 hover:underline dark:text-amber-400"
											>
												open <ExternalLink class="size-2.5" />
											</a>
										{/if}
										{#if env.sessionUrl}
											<a
												href={env.sessionUrl}
												class="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground hover:underline"
											>
												session
											</a>
										{/if}
									</div>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</section>

			<!-- 05 · GITOPS PIPELINE — full width -->
			<section id="sec-gitops" class="cc-panel cc-rail-rose scroll-mt-20 xl:col-span-2">
				<div class="cc-head">
					<div class="flex items-center gap-2.5">
						<span class="cc-idx text-rose-500">05</span>
						<GitBranch class="size-4 text-rose-500" />
						<h2 class="cc-title">GitOps Pipeline</h2>
					</div>
					<div class="flex items-center gap-1.5">
						{#if !data.gitops.restricted && data.gitops.ok}
							<span class="cc-chip {toneClass.idle}">
								<Radio class="size-3" /> {data.gitops.events.length} events
							</span>
						{/if}
						<a class="cc-viewall" href="/admin/gitops">
							console <ExternalLink class="size-3" />
						</a>
					</div>
				</div>
				<div class="cc-body">
					{#if data.gitops.restricted}
						<p class="cc-empty flex items-center justify-center gap-2">
							<ShieldAlert class="size-4 text-muted-foreground" />
							GitOps activity is restricted to platform admins.
						</p>
					{:else if data.gitops.events.length === 0}
						<p class="cc-empty">No recent build / deploy / sync activity.</p>
					{:else}
						<ol class="grid grid-cols-1 gap-x-6 md:grid-cols-2">
							{#each data.gitops.events.slice(0, 12) as ev (ev.eventId)}
								{@const tone = gitopsTone(ev.phase, ev.activityType)}
								<li class="cc-tl-item">
									<span class="cc-tl-dot {dotClass[tone]}"></span>
									<div class="min-w-0 flex-1 pb-3">
										<div class="flex items-center gap-2">
											<span class="truncate font-mono text-xs font-medium">
												{eventLabel(ev.resourceRef)}
											</span>
											<span class="cc-chip {toneClass[tone]} shrink-0">
												{ev.phase ?? ev.activityType}
											</span>
										</div>
										<div class="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
											{ev.activityType}{#if ev.resourceRef.kind}
												· {ev.resourceRef.kind}{/if} · {ev.source} · {formatRelative(ev.observedAt)}
										</div>
										{#if ev.message}
											<div class="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground/80">
												{ev.message}
											</div>
										{/if}
									</div>
								</li>
							{/each}
						</ol>
					{/if}
				</div>
			</section>
		</div>

		<!-- quick-launch rail (preserved actions) -->
		<section class="mt-7">
			<div class="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
				Quick launch
			</div>
			<div class="grid grid-cols-2 gap-2 md:grid-cols-4">
				<button type="button" class="cc-launch" onclick={() => goto(`/workspaces/${slug}/agents/new`)}>
					<Bot class="size-4" />
					<span>Create agent</span>
				</button>
				<button
					type="button"
					class="cc-launch"
					onclick={() => goto(`/workspaces/${slug}/sessions/new`)}
				>
					<MessagesSquare class="size-4" />
					<span>New session</span>
				</button>
				<button
					type="button"
					class="cc-launch"
					onclick={() => goto(`/workspaces/${slug}/environments/new`)}
				>
					<Layers class="size-4" />
					<span>Define environment</span>
				</button>
				<button
					type="button"
					class="cc-launch"
					onclick={() => goto(`/workspaces/${slug}/credentials`)}
				>
					<KeyRound class="size-4" />
					<span>Add vault</span>
				</button>
			</div>
		</section>
	</div>
</div>

<style>
	/* ---- backdrop: faint tactical grid -------------------------------- */
	.cc-root {
		background-image: radial-gradient(
			circle at 1px 1px,
			color-mix(in oklab, var(--foreground) 7%, transparent) 1px,
			transparent 0
		);
		background-size: 22px 22px;
	}
	.cc-ridge {
		backdrop-filter: blur(10px);
		background: color-mix(in oklab, var(--background) 82%, transparent);
	}

	/* ---- vital-sign tiles --------------------------------------------- */
	.cc-numeral {
		position: absolute;
		top: -0.35rem;
		right: 0.25rem;
		font-family: 'Geist Mono', ui-monospace, monospace;
		font-size: 3.4rem;
		font-weight: 700;
		line-height: 1;
		opacity: 0.1;
		pointer-events: none;
		letter-spacing: -0.04em;
	}
	.cc-tile:hover .cc-numeral {
		opacity: 0.18;
	}

	/* ---- section panels ----------------------------------------------- */
	.cc-panel {
		position: relative;
		border: 1px solid color-mix(in oklab, var(--border) 80%, transparent);
		border-radius: 0.85rem;
		background: var(--card);
		overflow: hidden;
	}
	.cc-panel::before {
		content: '';
		position: absolute;
		inset: 0 auto 0 0;
		width: 3px;
	}
	.cc-rail-sky::before {
		background: var(--color-sky-500, #0ea5e9);
	}
	.cc-rail-violet::before {
		background: var(--color-violet-500, #8b5cf6);
	}
	.cc-rail-emerald::before {
		background: var(--color-emerald-500, #10b981);
	}
	.cc-rail-amber::before {
		background: var(--color-amber-500, #f59e0b);
	}
	.cc-rail-rose::before {
		background: var(--color-rose-500, #f43f5e);
	}

	.cc-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.75rem 1rem 0.75rem 1.1rem;
		border-bottom: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
		background: color-mix(in oklab, var(--muted) 35%, transparent);
	}
	.cc-body {
		padding: 0.85rem 1rem 1rem 1.1rem;
	}
	:global(.cc-idx) {
		font-family: 'Geist Mono', ui-monospace, monospace;
		font-size: 0.75rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		opacity: 0.85;
	}
	.cc-title {
		font-size: 0.8rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.12em;
	}

	/* ---- chips / pills ------------------------------------------------- */
	:global(.cc-chip) {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		border-radius: 9999px;
		border-width: 1px;
		padding: 0.05rem 0.45rem;
		font-family: 'Geist Mono', ui-monospace, monospace;
		font-size: 0.625rem;
		line-height: 1.2;
		white-space: nowrap;
	}
	:global(.cc-viewall) {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		font-family: 'Geist Mono', ui-monospace, monospace;
		font-size: 0.625rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted-foreground);
		padding: 0.1rem 0.35rem;
		border-radius: 0.35rem;
	}
	:global(.cc-viewall:hover) {
		color: var(--foreground);
		background: color-mix(in oklab, var(--muted) 60%, transparent);
	}
	.cc-empty {
		padding: 1.5rem 0;
		text-align: center;
		font-size: 0.8rem;
		color: var(--muted-foreground);
	}

	/* ---- gitops timeline ---------------------------------------------- */
	.cc-tl-item {
		position: relative;
		display: flex;
		gap: 0.65rem;
		padding-left: 0.25rem;
	}
	.cc-tl-dot {
		position: relative;
		margin-top: 0.35rem;
		height: 0.55rem;
		width: 0.55rem;
		flex-shrink: 0;
		border-radius: 9999px;
		box-shadow: 0 0 0 3px var(--card);
	}

	/* ---- quick launch -------------------------------------------------- */
	:global(.cc-launch) {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		border: 1px solid color-mix(in oklab, var(--border) 80%, transparent);
		border-radius: 0.6rem;
		padding: 0.6rem 0.75rem;
		font-size: 0.8rem;
		font-weight: 500;
		text-align: left;
		transition: all 0.15s ease;
	}
	:global(.cc-launch:hover) {
		border-color: color-mix(in oklab, var(--foreground) 30%, transparent);
		background: color-mix(in oklab, var(--muted) 40%, transparent);
	}

	/* ---- cohesive keyboard focus ring --------------------------------- */
	:global(.cc-launch:focus-visible),
	:global(.cc-viewall:focus-visible) {
		outline: none;
		box-shadow:
			0 0 0 2px var(--background),
			0 0 0 4px var(--ring);
	}
</style>
