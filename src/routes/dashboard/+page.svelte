<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { DEFAULT_WORKSPACE_SLUG } from '$lib/utils/workspace-path';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import {
		Activity,
		ArrowUpRight,
		Bot,
		ExternalLink,
		KeyRound,
		Layers,
		MessageSquare,
		MessagesSquare,
		Sparkles,
		Zap
	} from '@lucide/svelte';

	type DashboardPayload = {
		stats: {
			activeSessions: number;
			sessionsToday: number;
			archivedLast24h: number;
			tokensOut7d: number;
			tokensIn7d: number;
			totalAgents: number;
			totalEnvironments: number;
			totalVaults: number;
		};
		activeSessions: Array<{
			id: string;
			title: string | null;
			status: string;
			agentId: string;
			agentName: string;
			agentAvatar: string | null;
			updatedAt: string;
			createdAt: string;
		}>;
		recentChanges: Array<{
			kind: 'agent' | 'environment';
			resourceId: string;
			resourceName: string;
			version: number;
			publishedAt: string | null;
		}>;
	};

	type RecentRun = {
		executionId: string;
		workflowId: string;
		workflowName: string;
		status: 'pending' | 'running' | 'success' | 'error' | 'cancelled';
		startedAt: string;
		durationMs: number | null;
		sessionCount: number;
	};

	let data = $state<DashboardPayload | null>(null);
	let recentRuns = $state<RecentRun[]>([]);
	let user = $state<{ name: string | null; email: string | null } | null>(null);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);

	let greeting = $derived.by(() => {
		const hour = new Date().getHours();
		if (hour < 12) return 'Good morning';
		if (hour < 18) return 'Good afternoon';
		return 'Good evening';
	});

	let displayName = $derived(
		user?.name?.split(' ')[0] ?? user?.email?.split('@')[0] ?? 'there'
	);

	// Dashboard is platform-scoped (no [slug] in URL). Use the magic default
	// slug — hooks.server.ts resolves it to the caller's active workspace.
	const slug = DEFAULT_WORKSPACE_SLUG;

	// Headline tiles for the command center — same numbers as before, each
	// keyed to a brand chart hue so the row reads as a set of gauges.
	let statTiles = $derived(
		data
			? [
					{
						label: 'Active sessions',
						value: data.stats.activeSessions.toLocaleString(),
						sub: `${data.stats.sessionsToday} started today`,
						accent: 'var(--chart-2)',
						icon: MessagesSquare
					},
					{
						label: 'Tokens out · 7d',
						value: data.stats.tokensOut7d.toLocaleString(),
						sub: `${data.stats.tokensIn7d.toLocaleString()} in`,
						accent: 'var(--chart-1)',
						icon: Zap
					},
					{
						label: 'Agents',
						value: data.stats.totalAgents.toLocaleString(),
						sub: `${data.stats.totalEnvironments} environments · ${data.stats.totalVaults} vaults`,
						accent: 'var(--chart-3)',
						icon: Bot
					},
					{
						label: 'Archived · 24h',
						value: data.stats.archivedLast24h.toLocaleString(),
						sub: 'sessions cleaned up',
						accent: 'var(--chart-4)',
						icon: Layers
					}
				]
			: []
	);

	// Inline "system vitals" for the Command Deck signature header.
	let vitals = $derived(
		data
			? [
					{ label: 'Active sessions', value: data.stats.activeSessions, icon: Activity },
					{ label: 'Agents', value: data.stats.totalAgents, icon: Bot },
					{ label: 'Environments', value: data.stats.totalEnvironments, icon: Layers }
				]
			: []
	);

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const [dRes, uRes, rRes] = await Promise.all([
				fetch('/api/v1/dashboard'),
				fetch('/api/v1/auth/session').catch(() => null),
				fetch('/api/v1/runs?limit=5').catch(() => null)
			]);
			if (!dRes.ok) {
				errorMessage = `Failed to load dashboard (${dRes.status})`;
				return;
			}
			data = (await dRes.json()) as DashboardPayload;
			if (rRes && rRes.ok) {
				const rPayload = (await rRes.json()) as { runs: RecentRun[] };
				recentRuns = rPayload.runs ?? [];
			}
			if (uRes && uRes.ok) {
				const payload = (await uRes.json()) as {
					user?: { name: string | null; email: string | null };
				};
				user = payload.user ?? null;
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	function formatRelative(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		return new Date(iso).toLocaleDateString();
	}

	onMount(load);
</script>

<div class="h-full overflow-y-auto flex flex-col gap-6 p-6 max-w-7xl mx-auto w-full">
	<!-- ───────────────────────────────────────────────────────────
	     Signature element: the "Command Deck" — a branded gradient
	     status banner with a live operational pulse, the time-aware
	     greeting, primary actions, and an inline system-vitals strip.
	     ─────────────────────────────────────────────────────────── -->
	<header
		class="command-deck relative overflow-hidden rounded-2xl px-6 py-6 text-white shadow-[var(--elevation-hover)] sm:px-8 sm:py-7"
	>
		<div class="relative flex flex-col gap-6">
			<div class="flex items-start justify-between gap-4 flex-wrap">
				<div class="space-y-2">
					<div class="flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.18em] text-white/75">
						<span class="relative flex size-2">
							<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-75"></span>
							<span class="relative inline-flex size-2 rounded-full bg-emerald-300"></span>
						</span>
						Systems nominal · Command center
					</div>
					<h1 class="text-3xl font-bold tracking-tight">{greeting}, {displayName}</h1>
					<p class="text-sm text-white/80 max-w-xl">
						Create, run, and monitor your Managed Agents.
					</p>
				</div>
				<div class="flex items-center gap-2 flex-wrap">
					<Button
						class="bg-white text-indigo-700 shadow-sm hover:bg-white/90"
						onclick={() => goto(`/workspaces/${slug}/agents/quickstart`)}
					>
						<Sparkles class="size-4" /> Get started with agents
					</Button>
					<Button
						variant="outline"
						class="border-white/30 bg-white/10 text-white hover:bg-white/20 hover:text-white"
						onclick={() => goto('/workbench')}
					>
						<MessageSquare class="size-4" /> Generate a prompt
					</Button>
					<Button
						variant="outline"
						class="border-white/30 bg-white/10 text-white hover:bg-white/20 hover:text-white"
						onclick={() => goto(`/workspaces/${slug}/settings/keys`)}
					>
						<KeyRound class="size-4" /> Get API Key
					</Button>
				</div>
			</div>

			{#if vitals.length > 0}
				<div class="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-white/15 bg-white/10">
					{#each vitals as v (v.label)}
						{@const Icon = v.icon}
						<div class="flex items-center gap-3 bg-white/5 px-4 py-3">
							<Icon class="size-4 text-white/70" />
							<div class="min-w-0">
								<div class="text-xl font-bold font-mono tabular-nums leading-none">
									{v.value.toLocaleString()}
								</div>
								<div class="mt-1 text-[10px] font-mono uppercase tracking-[0.14em] text-white/65 truncate">
									{v.label}
								</div>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</header>

	{#if errorMessage}
		<Alert variant="destructive">
			<AlertDescription>{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	{#if loading}
		<div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
			{#each Array(4) as _, i (i)}
				<Skeleton class="h-28 rounded-xl" />
			{/each}
		</div>
		<Skeleton class="h-64 rounded-xl" />
	{:else if data}
		<!-- Headline vitals row -->
		<div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
			{#each statTiles as tile (tile.label)}
				{@const Icon = tile.icon}
				<Card
					class="relative overflow-hidden shadow-[var(--elevation-card)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--elevation-hover)]"
				>
					<div class="absolute inset-x-0 top-0 h-1" style="background: {tile.accent}"></div>
					<CardHeader class="pb-2 flex-row items-center justify-between">
						<CardDescription
							class="text-[11px] font-mono uppercase tracking-[0.14em] text-muted-foreground"
						>
							{tile.label}
						</CardDescription>
						<span
							class="flex size-8 items-center justify-center rounded-lg"
							style="background: color-mix(in oklch, {tile.accent} 14%, transparent); color: {tile.accent}"
						>
							<Icon class="size-4" />
						</span>
					</CardHeader>
					<CardContent>
						<div class="text-3xl font-bold font-mono tabular-nums tracking-tight">
							{tile.value}
						</div>
						<div class="text-xs text-muted-foreground mt-1">
							{tile.sub}
						</div>
					</CardContent>
				</Card>
			{/each}
		</div>

		<!-- Quick start grid -->
		{#if data.stats.totalAgents === 0}
			<Card class="border-primary/40 bg-accent/40 shadow-[var(--elevation-card)]">
				<CardHeader>
					<CardTitle>Start with an agent</CardTitle>
					<CardDescription>
						Pick a template to create your first agent, or describe what you want to build.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Button size="lg" onclick={() => goto(`/workspaces/${slug}/agents/quickstart`)}>
						<Sparkles class="size-4" /> Go to Quickstart
					</Button>
				</CardContent>
			</Card>
		{/if}

		<!-- Recent runs (workflow executions) — added for Phase C to expose
		     the /runs feed without making users drill into a specific workflow. -->
		{#if recentRuns.length > 0}
			<Card class="shadow-[var(--elevation-card)]">
				<CardHeader class="pb-2 flex-row items-center justify-between">
					<div class="flex items-center gap-3">
						<span
							class="flex size-9 items-center justify-center rounded-lg"
							style="background: color-mix(in oklch, var(--chart-1) 14%, transparent); color: var(--chart-1)"
						>
							<Activity class="size-4" />
						</span>
						<div>
							<CardTitle class="text-base">Recent runs</CardTitle>
							<CardDescription class="text-xs">
								Workflow executions across this workspace.
							</CardDescription>
						</div>
					</div>
					<Button variant="ghost" size="sm" onclick={() => goto(`/workspaces/${slug}/runs`)}>
						View all <ExternalLink class="size-3" />
					</Button>
				</CardHeader>
				<CardContent>
					<ul class="divide-y divide-border/60">
						{#each recentRuns as r (r.executionId)}
							<li class="py-2">
								<a
									href="/workspaces/{slug}/workflows/{r.workflowId}/runs/{r.executionId}"
									class="flex items-center justify-between gap-2 hover:bg-accent/50 rounded-lg px-2 -mx-2 py-1.5 transition-colors"
								>
									<div class="flex items-center gap-2 min-w-0 flex-1">
										<span class="text-sm truncate font-medium" title={r.workflowName}>
											{r.workflowName}
										</span>
										{#if r.sessionCount > 0}
											<Badge variant="outline" class="text-[10px]">
												{r.sessionCount} session{r.sessionCount === 1 ? '' : 's'}
											</Badge>
										{/if}
									</div>
									<Badge
										variant="outline"
										class={r.status === 'running' || r.status === 'pending'
											? 'bg-blue-500/10 text-blue-600'
											: r.status === 'success'
												? 'bg-emerald-500/10 text-emerald-600'
												: r.status === 'error'
													? 'bg-red-500/10 text-red-600'
													: 'bg-muted text-muted-foreground'}
									>
										{r.status}
									</Badge>
									<span class="text-[11px] text-muted-foreground whitespace-nowrap font-mono tabular-nums">
										{formatRelative(r.startedAt)}
									</span>
								</a>
							</li>
						{/each}
					</ul>
				</CardContent>
			</Card>
		{/if}

		<!-- Two-column: active sessions + recent changes -->
		<div class="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4">
			<Card class="shadow-[var(--elevation-card)]">
				<CardHeader class="pb-2 flex-row items-center justify-between">
					<div class="flex items-center gap-3">
						<span
							class="flex size-9 items-center justify-center rounded-lg"
							style="background: color-mix(in oklch, var(--chart-2) 14%, transparent); color: var(--chart-2)"
						>
							<MessagesSquare class="size-4" />
						</span>
						<div>
							<CardTitle class="text-base">Active sessions</CardTitle>
							<CardDescription class="text-xs">
								Running + idle; click to open the live stream.
							</CardDescription>
						</div>
					</div>
					<Button variant="ghost" size="sm" onclick={() => goto(`/workspaces/${slug}/sessions`)}>
						View all <ExternalLink class="size-3" />
					</Button>
				</CardHeader>
				<CardContent>
					{#if data.activeSessions.length === 0}
						<p class="text-sm text-muted-foreground py-6 text-center">
							No active sessions right now.
							<button
								type="button"
								class="text-primary hover:underline"
								onclick={() => goto(`/workspaces/${slug}/sessions/new`)}
							>
								Start one
							</button>
							.
						</p>
					{:else}
						<ul class="divide-y divide-border/60">
							{#each data.activeSessions as s}
								<li class="py-2">
									<a
										href="/workspaces/{slug}/sessions/{s.id}"
										class="flex items-center justify-between gap-2 hover:bg-accent/50 rounded-lg px-2 -mx-2 py-1.5 transition-colors"
									>
										<div class="flex items-center gap-3 min-w-0 flex-1">
											<span
												class="flex size-9 items-center justify-center rounded-lg bg-secondary text-lg"
											>
												{s.agentAvatar ?? '🤖'}
											</span>
											<div class="min-w-0">
												<div class="text-sm truncate font-medium">
													{s.title ?? 'Untitled session'}
												</div>
												<div class="text-[11px] text-muted-foreground">
													{s.agentName} · {formatRelative(s.updatedAt)}
												</div>
											</div>
										</div>
										<Badge
											variant="outline"
											class={s.status === 'running'
												? 'bg-blue-500/10 text-blue-600'
												: 'bg-amber-500/10 text-amber-600'}
										>
											{s.status}
										</Badge>
									</a>
								</li>
							{/each}
						</ul>
					{/if}
				</CardContent>
			</Card>

			<Card class="shadow-[var(--elevation-card)]">
				<CardHeader class="pb-2">
					<div class="flex items-center gap-3">
						<span
							class="flex size-9 items-center justify-center rounded-lg"
							style="background: color-mix(in oklch, var(--chart-3) 14%, transparent); color: var(--chart-3)"
						>
							<Layers class="size-4" />
						</span>
						<div>
							<CardTitle class="text-base">Recent changes</CardTitle>
							<CardDescription class="text-xs">
								Published versions of agents + environments.
							</CardDescription>
						</div>
					</div>
				</CardHeader>
				<CardContent>
					{#if data.recentChanges.length === 0}
						<p class="text-sm text-muted-foreground py-6 text-center">
							Nothing yet.
						</p>
					{:else}
						<ul class="space-y-1">
							{#each data.recentChanges as change}
								<li class="rounded-lg px-2 -mx-2 py-1.5 hover:bg-accent/50 transition-colors">
									<a
										href={change.kind === 'agent'
											? `/workspaces/${slug}/agents/${change.resourceId}`
											: `/workspaces/${slug}/environments/${change.resourceId}`}
										class="flex items-center gap-2 text-xs"
									>
										{#if change.kind === 'agent'}
											<Bot class="size-3.5 text-muted-foreground" />
										{:else}
											<Layers class="size-3.5 text-muted-foreground" />
										{/if}
										<span class="flex-1 truncate font-medium">{change.resourceName}</span>
										<Badge variant="outline" class="text-[9px] font-mono">v{change.version}</Badge>
									</a>
									<div class="text-[10px] text-muted-foreground pl-5.5 font-mono">
										{change.publishedAt
											? formatRelative(change.publishedAt)
											: 'unpublished'}
									</div>
								</li>
							{/each}
						</ul>
					{/if}
				</CardContent>
			</Card>
		</div>

		<!-- Resource quick links -->
		<div class="grid grid-cols-1 md:grid-cols-4 gap-3">
			<button
				type="button"
				class="group/q relative overflow-hidden rounded-xl border bg-card p-4 text-left shadow-[var(--elevation-card)] transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[var(--elevation-hover)]"
				onclick={() => goto(`/workspaces/${slug}/agents/new`)}
			>
				<ArrowUpRight class="absolute right-3 top-3 size-4 text-muted-foreground/50 transition-transform group-hover/q:translate-x-0.5 group-hover/q:-translate-y-0.5" />
				<span
					class="mb-3 flex size-9 items-center justify-center rounded-lg"
					style="background: color-mix(in oklch, var(--chart-1) 14%, transparent); color: var(--chart-1)"
				>
					<Bot class="size-4" />
				</span>
				<div class="text-sm font-semibold">Create agent</div>
				<div class="text-[11px] text-muted-foreground mt-0.5">Persistent config, versioned.</div>
			</button>
			<button
				type="button"
				class="group/q relative overflow-hidden rounded-xl border bg-card p-4 text-left shadow-[var(--elevation-card)] transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[var(--elevation-hover)]"
				onclick={() => goto(`/workspaces/${slug}/sessions/new`)}
			>
				<ArrowUpRight class="absolute right-3 top-3 size-4 text-muted-foreground/50 transition-transform group-hover/q:translate-x-0.5 group-hover/q:-translate-y-0.5" />
				<span
					class="mb-3 flex size-9 items-center justify-center rounded-lg"
					style="background: color-mix(in oklch, var(--chart-2) 14%, transparent); color: var(--chart-2)"
				>
					<MessagesSquare class="size-4" />
				</span>
				<div class="text-sm font-semibold">New session</div>
				<div class="text-[11px] text-muted-foreground mt-0.5">Chat directly with an agent.</div>
			</button>
			<button
				type="button"
				class="group/q relative overflow-hidden rounded-xl border bg-card p-4 text-left shadow-[var(--elevation-card)] transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[var(--elevation-hover)]"
				onclick={() => goto(`/workspaces/${slug}/environments/new`)}
			>
				<ArrowUpRight class="absolute right-3 top-3 size-4 text-muted-foreground/50 transition-transform group-hover/q:translate-x-0.5 group-hover/q:-translate-y-0.5" />
				<span
					class="mb-3 flex size-9 items-center justify-center rounded-lg"
					style="background: color-mix(in oklch, var(--chart-3) 14%, transparent); color: var(--chart-3)"
				>
					<Layers class="size-4" />
				</span>
				<div class="text-sm font-semibold">Define environment</div>
				<div class="text-[11px] text-muted-foreground mt-0.5">
					Sandbox template + networking.
				</div>
			</button>
			<button
				type="button"
				class="group/q relative overflow-hidden rounded-xl border bg-card p-4 text-left shadow-[var(--elevation-card)] transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[var(--elevation-hover)]"
				onclick={() => goto(`/workspaces/${slug}/credentials`)}
			>
				<ArrowUpRight class="absolute right-3 top-3 size-4 text-muted-foreground/50 transition-transform group-hover/q:translate-x-0.5 group-hover/q:-translate-y-0.5" />
				<span
					class="mb-3 flex size-9 items-center justify-center rounded-lg"
					style="background: color-mix(in oklch, var(--chart-4) 14%, transparent); color: var(--chart-4)"
				>
					<KeyRound class="size-4" />
				</span>
				<div class="text-sm font-semibold">Add vault</div>
				<div class="text-[11px] text-muted-foreground mt-0.5">
					Store MCP credentials securely.
				</div>
			</button>
		</div>
	{/if}
</div>

<style>
	/* Command Deck — brand gradient + faint mission-control grid texture */
	.command-deck {
		background:
			radial-gradient(130% 150% at 0% 0%, oklch(1 0 0 / 0.16), transparent 52%),
			linear-gradient(
				115deg,
				var(--command-grad-from),
				var(--command-grad-via) 52%,
				var(--command-grad-to)
			);
	}
	.command-deck::before {
		content: '';
		position: absolute;
		inset: 0;
		background-image:
			linear-gradient(to right, oklch(1 0 0 / 0.06) 1px, transparent 1px),
			linear-gradient(to bottom, oklch(1 0 0 / 0.06) 1px, transparent 1px);
		background-size: 34px 34px;
		-webkit-mask-image: radial-gradient(120% 110% at 100% 0%, black, transparent 72%);
		mask-image: radial-gradient(120% 110% at 100% 0%, black, transparent 72%);
		pointer-events: none;
	}
</style>
