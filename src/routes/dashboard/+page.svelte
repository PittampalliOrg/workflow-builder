<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
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
		Bot,
		ExternalLink,
		KeyRound,
		Layers,
		MessagesSquare,
		Plus,
		Sparkles
	} from 'lucide-svelte';

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

	let data = $state<DashboardPayload | null>(null);
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

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const [dRes, uRes] = await Promise.all([
				fetch('/api/v1/dashboard'),
				fetch('/api/v1/auth/session').catch(() => null)
			]);
			if (!dRes.ok) {
				errorMessage = `Failed to load dashboard (${dRes.status})`;
				return;
			}
			data = (await dRes.json()) as DashboardPayload;
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

<div class="flex flex-col gap-6 p-6 max-w-7xl mx-auto w-full">
	<header class="flex items-start justify-between gap-4 flex-wrap">
		<div>
			<h1 class="text-2xl font-semibold">{greeting}, {displayName}</h1>
			<p class="text-sm text-muted-foreground mt-1">
				Create, run, and monitor your Managed Agents.
			</p>
		</div>
		<div class="flex items-center gap-2">
			<Button onclick={() => goto('/workspaces/default/agents/quickstart')}>
				<Sparkles class="size-4" /> Get started with agents
			</Button>
			<Button variant="outline" onclick={() => goto('/settings/api-keys')}>
				Get API Key
			</Button>
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
					<Button size="lg" onclick={() => goto('/workspaces/default/agents/quickstart')}>
						<Sparkles class="size-4" /> Go to Quickstart
					</Button>
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
					<Button variant="ghost" size="sm" onclick={() => goto('/workspaces/default/sessions')}>
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
								onclick={() => goto('/workspaces/default/sessions/new')}
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
										href="/workspaces/default/sessions/{s.id}"
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
											? `/agents/${change.resourceId}`
											: `/environments/${change.resourceId}`}
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
				onclick={() => goto('/workspaces/default/agents/new')}
			>
				<Bot class="size-4 mb-1" />
				<div class="text-sm font-medium">Create agent</div>
				<div class="text-[10px] text-muted-foreground">Persistent config, versioned.</div>
			</button>
			<button
				type="button"
				class="rounded border p-3 text-left hover:border-primary/50 hover:bg-muted/30 transition-colors"
				onclick={() => goto('/workspaces/default/sessions/new')}
			>
				<MessagesSquare class="size-4 mb-1" />
				<div class="text-sm font-medium">New session</div>
				<div class="text-[10px] text-muted-foreground">Chat directly with an agent.</div>
			</button>
			<button
				type="button"
				class="rounded border p-3 text-left hover:border-primary/50 hover:bg-muted/30 transition-colors"
				onclick={() => goto('/workspaces/default/environments/new')}
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
				onclick={() => goto('/workspaces/default/vaults')}
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
