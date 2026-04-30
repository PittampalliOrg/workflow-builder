<script lang="ts">
	import { page } from '$app/state';
	import { Badge } from '$lib/components/ui/badge';
	import { Card, CardContent } from '$lib/components/ui/card';
	import { DEFAULT_WORKSPACE_SLUG } from '$lib/utils/workspace-path';
	import { Rocket, Sparkles, Key, MessageSquare, ExternalLink, LifeBuoy, Activity } from '@lucide/svelte';

	type RecentSession = {
		id: string;
		title: string | null;
		status: string;
		agentId: string;
		updatedAt: string | null;
	};

	type RecentRun = {
		executionId: string;
		workflowId: string;
		workflowName: string;
		status: 'pending' | 'running' | 'success' | 'error' | 'cancelled';
		startedAt: string;
		durationMs: number | null;
	};

	const {
		data,
	}: {
		data: {
			user: { name: string | null; email: string | null } | null;
			recentSessions: RecentSession[];
			recentRuns: RecentRun[];
		};
	} = $props();

	const slug = $derived(
		(page.params.slug as string | undefined) ?? DEFAULT_WORKSPACE_SLUG
	);

	// Time-of-day greeting — matches CMA's "Happy late night, vpittamp".
	function greeting(): string {
		const h = new Date().getHours();
		if (h < 5) return 'Happy late night';
		if (h < 12) return 'Good morning';
		if (h < 17) return 'Good afternoon';
		if (h < 21) return 'Good evening';
		return 'Happy late night';
	}

	const firstName = $derived.by(() => {
		if (!data.user?.name) return null;
		return data.user.name.split(/\s+/)[0];
	});

	function formatRelative(iso: string | null): string {
		if (!iso) return '';
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
		return new Date(iso).toLocaleDateString();
	}
</script>

<div class="h-full overflow-y-auto">
	<div class="mx-auto max-w-3xl px-6 py-16 space-y-8">
		<header class="text-center">
			<h1 class="text-3xl font-semibold tracking-tight">
				{greeting()}{firstName ? `, ${firstName}` : ''}
			</h1>
			{#if !data.user}
				<p class="text-sm text-muted-foreground mt-2">
					Sign in to see your recent sessions.
				</p>
			{/if}
		</header>

		<div class="space-y-3">
			<a
				href="/workspaces/{slug}/agents"
				class="group block rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary hover:bg-accent"
			>
				<div class="flex items-center gap-3">
					<Rocket class="size-5 text-primary" />
					<div class="flex-1">
						<p class="text-sm font-medium">Get started with agents</p>
						<p class="text-xs text-muted-foreground">
							Pick a template, wire up an environment, and run your first managed-agent
							session.
						</p>
					</div>
				</div>
			</a>

			<a
				href="/workbench"
				class="group block rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary hover:bg-accent"
			>
				<div class="flex items-center gap-3">
					<Sparkles class="size-5 text-primary" />
					<div class="flex-1">
						<p class="text-sm font-medium">Generate a prompt</p>
						<p class="text-xs text-muted-foreground">
							Draft and iterate on prompts in the interactive workbench.
						</p>
					</div>
				</div>
			</a>

			<a
				href="/workspaces/{slug}/settings/keys"
				class="group block rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary hover:bg-accent"
			>
				<div class="flex items-center gap-3">
					<Key class="size-5 text-primary" />
					<div class="flex-1">
						<p class="text-sm font-medium">Get API Key</p>
						<p class="text-xs text-muted-foreground">
							Create a workspace-scoped <code class="text-[10px]">wfb_</code> key for
							programmatic access.
						</p>
					</div>
				</div>
			</a>
		</div>

		{#if data.recentRuns.length > 0}
			<section class="space-y-2">
				<div class="flex items-center justify-between">
					<h2 class="text-xs uppercase tracking-wider text-muted-foreground">Recent runs</h2>
					<a href="/workspaces/{slug}/runs" class="text-xs text-primary hover:underline">
						View all →
					</a>
				</div>
				<div class="space-y-2">
					{#each data.recentRuns as r (r.executionId)}
						<a
							href="/workspaces/{slug}/workflows/{r.workflowId}/runs/{r.executionId}"
							class="block rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-accent"
						>
							<div class="flex items-center justify-between gap-3">
								<div class="min-w-0 flex-1 flex items-center gap-2">
									<Activity class="size-3.5 text-muted-foreground shrink-0" />
									<p class="text-sm truncate" title={r.workflowName}>{r.workflowName}</p>
								</div>
								<div class="flex items-center gap-2 text-xs">
									<Badge variant="outline" class="text-[10px] capitalize">{r.status}</Badge>
									<span class="text-muted-foreground whitespace-nowrap">
										{formatRelative(r.startedAt)}
									</span>
								</div>
							</div>
						</a>
					{/each}
				</div>
			</section>
		{/if}

		{#if data.recentSessions.length > 0}
			<section class="space-y-2">
				<div class="flex items-center justify-between">
					<h2 class="text-xs uppercase tracking-wider text-muted-foreground">Recent sessions</h2>
					<a
						href="/workspaces/{slug}/sessions"
						class="text-xs text-primary hover:underline"
					>
						View all →
					</a>
				</div>
				<div class="space-y-2">
					{#each data.recentSessions as s (s.id)}
						<a
							href="/workspaces/{slug}/sessions/{s.id}"
							class="block rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-accent"
						>
							<div class="flex items-center justify-between gap-3">
								<div class="min-w-0 flex-1">
									<p class="text-sm truncate">{s.title || s.id}</p>
									<p class="text-[11px] text-muted-foreground font-mono truncate">
										{s.id}
									</p>
								</div>
								<div class="flex items-center gap-2 text-xs">
									<Badge variant="outline" class="text-[10px] capitalize">{s.status}</Badge>
									<span class="text-muted-foreground whitespace-nowrap">
										{formatRelative(s.updatedAt)}
									</span>
								</div>
							</div>
						</a>
					{/each}
				</div>
			</section>
		{/if}

		<footer class="flex items-center justify-center gap-6 pt-8 text-xs text-muted-foreground">
			<a
				href="https://status.claude.com/"
				target="_blank"
				rel="noreferrer"
				class="inline-flex items-center gap-1 hover:text-foreground"
			>
				API status <ExternalLink class="size-3" />
			</a>
			<a
				href="https://support.claude.com/en/"
				target="_blank"
				rel="noreferrer"
				class="inline-flex items-center gap-1 hover:text-foreground"
			>
				<LifeBuoy class="size-3" /> Help & support
			</a>
			<a
				href="https://github.com/PittampalliOrg/workflow-builder/issues"
				target="_blank"
				rel="noreferrer"
				class="inline-flex items-center gap-1 hover:text-foreground"
			>
				<MessageSquare class="size-3" /> Feedback
			</a>
		</footer>
	</div>
</div>
