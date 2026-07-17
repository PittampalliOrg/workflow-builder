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
		Bot,
		ExternalLink,
		KeyRound,
		Layers,
		MessageSquare,
		MessagesSquare,
		Plus,
		Sparkles
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
	<header class="flex items-start justify-between gap-4 flex-wrap">
		<div>
			<h1 class="text-2xl font-semibold">{greeting}, {displayName}</h1>
			<p class="text-sm text-muted-foreground mt-1">
				Create, run, and monitor your Managed Agents.
			</p>
		</div>
		<div class="flex items-center gap-2">
			<Button onclick={() => goto(`/workspaces/${slug}/agents/quickstart`)}>
				<Sparkles class="size-4" /> Get started with agents
			</Button>
			<Button variant="outline" onclick={() => goto('/workbench')}>
				<MessageSquare class="size-4" /> Generate a prompt
			</Button>
			<Button variant="outline" onclick={() => goto(`/workspaces/${slug}/settings/keys`)}>
				<KeyRound class="size-4" /> Get API Key
			</Button>
		</div>
	</header>

	{#if errorMessage}
		<Alert variant="destructive">
			<AlertDescription>{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	<!-- Preview lifecycle PR proof panel: compact, demonstrable marker
	     that HMR live-sync is active. Uses dashboard data when loaded,
	     otherwise renders a graceful static/empty state. -->
	<Card class="border-primary/40 bg-primary/5">
		<CardHeader class="pb-2">
			<CardTitle class="text-sm flex items-center gap-2">
				<Activity class="size-4" /> Preview lifecycle PR proof
			</CardTitle>
		</CardHeader>
		<CardContent class="text-xs text-muted-foreground">
			<div class="flex items-center gap-2 flex-wrap">
				<Badge variant="outline" class="bg-emerald-500/10 text-emerald-600">
					HMR live-sync active
				</Badge>
				{#if loading}
					<span>Dashboard loading…</span>
				{:else if data}
					<span>
						{data.stats.totalAgents} agent{data.stats.totalAgents === 1 ? '' : 's'} ·
						{data.stats.activeSessions} active session{data.stats.activeSessions === 1 ? '' : 's'}
					</span>
				{:else}
					<span>No dashboard data yet — empty state.</span>
				{/if}
			</div>
		</CardContent>
	</Card>

	{#if loading}
		<div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
			{#each Array(4) as _, i (i)}
				<Skeleton class="h-24" />
			{/each}
		</div>
		<Skeleton class="h-64" />
	{:else if data}
		<!-- Stats row -->
		<div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
			<Card>
				<CardHeader class="pb-2">
					<CardDescription class="text-[11px] uppercase tracking-wide">
						Active sessions
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div class="text-3xl font-semibold">{data.stats.activeSessions}</div>
					<div class="text-xs text-muted-foreground">
						{data.stats.sessionsToday} started today
					</div>
				</CardContent>
			</Card>
			<Card>
				<CardHeader class="pb-2">
					<CardDescription class="text-[11px] uppercase tracking-wide">
						Tokens out (7d)
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div class="text-3xl font-semibold">
						{data.stats.tokensOut7d.toLocaleString()}
					</div>
					<div class="text-xs text-muted-foreground">
						{data.stats.tokensIn7d.toLocaleString()} in
					</div>
				</CardContent>
			</Card>
			<Card>
				<CardHeader class="pb-2">
					<CardDescription class="text-[11px] uppercase tracking-wide">
						Agents
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div class="text-3xl font-semibold">{data.stats.totalAgents}</div>
					<div class="text-xs text-muted-foreground">
						{data.stats.totalEnvironments} environments · {data.stats.totalVaults} vaults
					</div>
				</CardContent>
			</Card>
			<Card>
				<CardHeader class="pb-2">
					<CardDescription class="text-[11px] uppercase tracking-wide">
						Archived (24h)
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div class="text-3xl font-semibold">{data.stats.archivedLast24h}</div>
					<div class="text-xs text-muted-foreground">sessions cleaned up</div>
				</CardContent>
			</Card>
		</div>

		<!-- Quick start grid -->
		{#if data.stats.totalAgents === 0}
			<Card class="border-primary/40 bg-primary/5">
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
			<Card>
				<CardHeader class="pb-2 flex-row items-center justify-between">
					<div>
						<CardTitle class="text-base flex items-center gap-2">
							<Activity class="size-4" /> Recent runs
						</CardTitle>
						<CardDescription class="text-xs">
							Workflow executions across this workspace.
						</CardDescription>
					</div>
					<Button variant="ghost" size="sm" onclick={() => goto(`/workspaces/${slug}/runs`)}>
						View all <ExternalLink class="size-3" />
					</Button>
				</CardHeader>
				<CardContent>
					<ul class="divide-y">
						{#each recentRuns as r (r.executionId)}
							<li class="py-2">
								<a
									href="/workspaces/{slug}/workflows/{r.workflowId}/runs/{r.executionId}"
									class="flex items-center justify-between gap-2 hover:bg-muted/40 rounded px-2 -mx-2"
								>
									<div class="flex items-center gap-2 min-w-0 flex-1">
										<span class="text-sm truncate" title={r.workflowName}>
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
									<span class="text-[11px] text-muted-foreground whitespace-nowrap">
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
			<Card>
				<CardHeader class="pb-2 flex-row items-center justify-between">
					<div>
						<CardTitle class="text-base flex items-center gap-2">
							<MessagesSquare class="size-4" /> Active sessions
						</CardTitle>
						<CardDescription class="text-xs">
							Running + idle; click to open the live stream.
						</CardDescription>
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
						<ul class="divide-y">
							{#each data.activeSessions as s}
								<li class="py-2">
									<a
										href="/workspaces/{slug}/sessions/{s.id}"
										class="flex items-center justify-between gap-2 hover:bg-muted/40 rounded px-2 -mx-2"
									>
										<div class="flex items-center gap-2 min-w-0 flex-1">
											<span class="text-lg">{s.agentAvatar ?? '🤖'}</span>
											<div class="min-w-0">
												<div class="text-sm truncate">
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

			<Card>
				<CardHeader class="pb-2">
					<CardTitle class="text-base">Recent changes</CardTitle>
					<CardDescription class="text-xs">
						Published versions of agents + environments.
					</CardDescription>
				</CardHeader>
				<CardContent>
					{#if data.recentChanges.length === 0}
						<p class="text-sm text-muted-foreground py-6 text-center">
							Nothing yet.
						</p>
					{:else}
						<ul class="space-y-2">
							{#each data.recentChanges as change}
								<li class="text-xs">
									<a
										href={change.kind === 'agent'
											? `/workspaces/${slug}/agents/${change.resourceId}`
											: `/workspaces/${slug}/environments/${change.resourceId}`}
										class="flex items-center gap-2 hover:underline"
									>
										{#if change.kind === 'agent'}
											<Bot class="size-3 text-muted-foreground" />
										{:else}
											<Layers class="size-3 text-muted-foreground" />
										{/if}
										<span class="flex-1 truncate">{change.resourceName}</span>
										<Badge variant="outline" class="text-[9px]">v{change.version}</Badge>
									</a>
									<div class="text-[10px] text-muted-foreground pl-5">
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
				class="rounded border p-3 text-left hover:border-primary/50 hover:bg-muted/30 transition-colors"
				onclick={() => goto(`/workspaces/${slug}/agents/new`)}
			>
				<Bot class="size-4 mb-1" />
				<div class="text-sm font-medium">Create agent</div>
				<div class="text-[10px] text-muted-foreground">Persistent config, versioned.</div>
			</button>
			<button
				type="button"
				class="rounded border p-3 text-left hover:border-primary/50 hover:bg-muted/30 transition-colors"
				onclick={() => goto(`/workspaces/${slug}/sessions/new`)}
			>
				<MessagesSquare class="size-4 mb-1" />
				<div class="text-sm font-medium">New session</div>
				<div class="text-[10px] text-muted-foreground">Chat directly with an agent.</div>
			</button>
			<button
				type="button"
				class="rounded border p-3 text-left hover:border-primary/50 hover:bg-muted/30 transition-colors"
				onclick={() => goto(`/workspaces/${slug}/environments/new`)}
			>
				<Layers class="size-4 mb-1" />
				<div class="text-sm font-medium">Define environment</div>
				<div class="text-[10px] text-muted-foreground">
					Sandbox template + networking.
				</div>
			</button>
			<button
				type="button"
				class="rounded border p-3 text-left hover:border-primary/50 hover:bg-muted/30 transition-colors"
				onclick={() => goto(`/workspaces/${slug}/credentials`)}
			>
				<KeyRound class="size-4 mb-1" />
				<div class="text-sm font-medium">Add vault</div>
				<div class="text-[10px] text-muted-foreground">
					Store MCP credentials securely.
				</div>
			</button>
		</div>
	{/if}
</div>
