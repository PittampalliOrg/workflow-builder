<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { DEFAULT_WORKSPACE_SLUG } from '$lib/utils/workspace-path';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import {
		Activity,
		Archive,
		Bot,
		Clock3,
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

	// Signature element data: derive an overall operational posture from the
	// live feeds so the command bar reflects real system state, not a static label.
	let runningRuns = $derived(
		recentRuns.filter((r) => r.status === 'running' || r.status === 'pending').length
	);
	let failedRuns = $derived(recentRuns.filter((r) => r.status === 'error').length);
	let systemState = $derived(
		failedRuns > 0 ? 'alert' : runningRuns > 0 ? 'active' : 'nominal'
	);
	let systemLabel = $derived(
		failedRuns > 0
			? `${failedRuns} run${failedRuns === 1 ? '' : 's'} failing`
			: runningRuns > 0
				? `${runningRuns} run${runningRuns === 1 ? '' : 's'} in flight`
				: 'All systems nominal'
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

	function runTone(status: RecentRun['status']): string {
		if (status === 'running' || status === 'pending') return 'running';
		if (status === 'success') return 'success';
		if (status === 'error') return 'error';
		return 'idle';
	}

	onMount(load);
</script>

<div class="cmd h-full w-full overflow-y-auto">
	<div class="cmd-shell flex flex-col gap-6 p-6 max-w-7xl mx-auto w-full">
		<!-- ── Signature element: System Pulse command bar ──────────────── -->
		<header class="cmd-hero" data-state={systemState}>
			<div class="cmd-hero__grid" aria-hidden="true"></div>
			<div class="cmd-hero__content">
				<div class="cmd-hero__lead">
					<span class="cmd-status" data-state={systemState}>
						<span class="cmd-status__orb"></span>
						<span class="cmd-status__label">{systemLabel}</span>
					</span>
					<h1 class="cmd-hero__title">{greeting}, {displayName}</h1>
					<p class="cmd-hero__sub">Create, run, and monitor your Managed Agents.</p>
				</div>
				<div class="cmd-actions">
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
			</div>

			{#if data}
				<dl class="cmd-vitals">
					<div class="cmd-vital">
						<dt>Online sessions</dt>
						<dd>{data.stats.activeSessions}</dd>
					</div>
					<div class="cmd-vital">
						<dt>Started today</dt>
						<dd>{data.stats.sessionsToday}</dd>
					</div>
					<div class="cmd-vital">
						<dt>Managed agents</dt>
						<dd>{data.stats.totalAgents}</dd>
					</div>
					<div class="cmd-vital">
						<dt>Environments</dt>
						<dd>{data.stats.totalEnvironments}</dd>
					</div>
				</dl>
			{/if}
		</header>

		{#if errorMessage}
			<Alert variant="destructive">
				<AlertDescription>{errorMessage}</AlertDescription>
			</Alert>
		{/if}

		{#if loading}
			<div class="cmd-kpis">
				{#each Array(4) as _, i (i)}
					<Skeleton class="h-28 rounded-[14px]" />
				{/each}
			</div>
			<Skeleton class="h-64 rounded-[14px]" />
		{:else if data}
			<!-- ── Telemetry: signature KPI tiles ───────────────────────── -->
			<div class="cmd-kpis">
				<article class="cmd-tile" data-accent="cyan">
					<div class="cmd-tile__head">
						<span class="cmd-tile__label">Active sessions</span>
						<MessagesSquare class="size-4" />
					</div>
					<div class="cmd-tile__value">{data.stats.activeSessions}</div>
					<div class="cmd-tile__sub">{data.stats.sessionsToday} started today</div>
				</article>
				<article class="cmd-tile" data-accent="blue">
					<div class="cmd-tile__head">
						<span class="cmd-tile__label">Tokens out · 7d</span>
						<Activity class="size-4" />
					</div>
					<div class="cmd-tile__value">{data.stats.tokensOut7d.toLocaleString()}</div>
					<div class="cmd-tile__sub">{data.stats.tokensIn7d.toLocaleString()} in</div>
				</article>
				<article class="cmd-tile" data-accent="green">
					<div class="cmd-tile__head">
						<span class="cmd-tile__label">Agents</span>
						<Bot class="size-4" />
					</div>
					<div class="cmd-tile__value">{data.stats.totalAgents}</div>
					<div class="cmd-tile__sub">
						{data.stats.totalEnvironments} environments · {data.stats.totalVaults} vaults
					</div>
				</article>
				<article class="cmd-tile" data-accent="amber">
					<div class="cmd-tile__head">
						<span class="cmd-tile__label">Archived · 24h</span>
						<Archive class="size-4" />
					</div>
					<div class="cmd-tile__value">{data.stats.archivedLast24h}</div>
					<div class="cmd-tile__sub">sessions cleaned up</div>
				</article>
			</div>

			<!-- Quick start (only when there are no agents yet) -->
			{#if data.stats.totalAgents === 0}
				<section class="cmd-panel cmd-panel--accent">
					<div class="cmd-panel__body cmd-empty-cta">
						<div>
							<h2 class="cmd-panel__title">Start with an agent</h2>
							<p class="cmd-panel__desc">
								Pick a template to create your first agent, or describe what you want to build.
							</p>
						</div>
						<Button size="lg" onclick={() => goto(`/workspaces/${slug}/agents/quickstart`)}>
							<Sparkles class="size-4" /> Go to Quickstart
						</Button>
					</div>
				</section>
			{/if}

			<!-- Recent runs (workflow executions) -->
			{#if recentRuns.length > 0}
				<section class="cmd-panel">
					<div class="cmd-panel__head">
						<div>
							<h2 class="cmd-panel__title"><Activity /> Recent runs</h2>
							<p class="cmd-panel__desc">Workflow executions across this workspace.</p>
						</div>
						<Button variant="ghost" size="sm" onclick={() => goto(`/workspaces/${slug}/runs`)}>
							View all <ExternalLink class="size-3" />
						</Button>
					</div>
					<div class="cmd-panel__body">
						<ul class="cmd-list">
							{#each recentRuns as r, i (r.executionId + '-' + i)}
								<li>
									<a
										href="/workspaces/{slug}/workflows/{r.workflowId}/runs/{r.executionId}"
										class="cmd-row"
									>
										<span class="cmd-row__main">
											<span class="cmd-row__title" title={r.workflowName}>{r.workflowName}</span>
											{#if r.sessionCount > 0}
												<span class="cmd-tag">
													{r.sessionCount} session{r.sessionCount === 1 ? '' : 's'}
												</span>
											{/if}
										</span>
										<span class="cmd-pill" data-tone={runTone(r.status)}>
											<span class="cmd-pill__dot"></span>{r.status}
										</span>
										<span class="cmd-ts">{formatRelative(r.startedAt)}</span>
									</a>
								</li>
							{/each}
						</ul>
					</div>
				</section>
			{/if}

			<!-- Two-column: active sessions + recent changes -->
			<div class="cmd-cols">
				<section class="cmd-panel">
					<div class="cmd-panel__head">
						<div>
							<h2 class="cmd-panel__title"><MessagesSquare /> Active sessions</h2>
							<p class="cmd-panel__desc">Running + idle; click to open the live stream.</p>
						</div>
						<Button variant="ghost" size="sm" onclick={() => goto(`/workspaces/${slug}/sessions`)}>
							View all <ExternalLink class="size-3" />
						</Button>
					</div>
					<div class="cmd-panel__body">
						{#if data.activeSessions.length === 0}
							<p class="cmd-blank">
								No active sessions right now.
								<button
									type="button"
									class="cmd-linktext"
									onclick={() => goto(`/workspaces/${slug}/sessions/new`)}
								>
									Start one
								</button>
								.
							</p>
						{:else}
							<ul class="cmd-list">
								{#each data.activeSessions as s (s.id)}
									<li>
										<a href="/workspaces/{slug}/sessions/{s.id}" class="cmd-row">
											<span class="cmd-row__main">
												<span class="cmd-avatar">{s.agentAvatar ?? '🤖'}</span>
												<span class="cmd-row__stack">
													<span class="cmd-row__title">{s.title ?? 'Untitled session'}</span>
													<span class="cmd-row__meta">
														{s.agentName} · {formatRelative(s.updatedAt)}
													</span>
												</span>
											</span>
											<span
												class="cmd-pill"
												data-tone={s.status === 'running' ? 'running' : 'warning'}
											>
												<span class="cmd-pill__dot"></span>{s.status}
											</span>
										</a>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				</section>

				<section class="cmd-panel">
					<div class="cmd-panel__head">
						<div>
							<h2 class="cmd-panel__title"><Clock3 /> Recent changes</h2>
							<p class="cmd-panel__desc">Published versions of agents + environments.</p>
						</div>
					</div>
					<div class="cmd-panel__body">
						{#if data.recentChanges.length === 0}
							<p class="cmd-blank">Nothing yet.</p>
						{:else}
							<ul class="cmd-list cmd-list--changes">
								{#each data.recentChanges as change, i (change.kind + ':' + change.resourceId + ':' + change.version + ':' + i)}
									<li>
										<a
											href={change.kind === 'agent'
												? `/workspaces/${slug}/agents/${change.resourceId}`
												: `/workspaces/${slug}/environments/${change.resourceId}`}
											class="cmd-row cmd-row--change"
										>
											<span class="cmd-chip cmd-chip--sm">
												{#if change.kind === 'agent'}
													<Bot class="size-3.5" />
												{:else}
													<Layers class="size-3.5" />
												{/if}
											</span>
											<span class="cmd-row__stack">
												<span class="cmd-row__title cmd-row__title--sm">{change.resourceName}</span>
												<span class="cmd-row__meta">
													{change.publishedAt ? formatRelative(change.publishedAt) : 'unpublished'}
												</span>
											</span>
											<span class="cmd-tag cmd-tag--ver">v{change.version}</span>
										</a>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				</section>
			</div>

			<!-- Resource quick links -->
			<div>
				<p class="cmd-sectionlabel"><Zap class="size-3.5" /> Quick actions</p>
				<div class="cmd-links">
					<button
						type="button"
						class="cmd-link"
						onclick={() => goto(`/workspaces/${slug}/agents/new`)}
					>
						<span class="cmd-chip"><Bot class="size-4" /></span>
						<span class="cmd-link__title">Create agent</span>
						<span class="cmd-link__sub">Persistent config, versioned.</span>
					</button>
					<button
						type="button"
						class="cmd-link"
						onclick={() => goto(`/workspaces/${slug}/sessions/new`)}
					>
						<span class="cmd-chip"><MessagesSquare class="size-4" /></span>
						<span class="cmd-link__title">New session</span>
						<span class="cmd-link__sub">Chat directly with an agent.</span>
					</button>
					<button
						type="button"
						class="cmd-link"
						onclick={() => goto(`/workspaces/${slug}/environments/new`)}
					>
						<span class="cmd-chip"><Layers class="size-4" /></span>
						<span class="cmd-link__title">Define environment</span>
						<span class="cmd-link__sub">Sandbox template + networking.</span>
					</button>
					<button
						type="button"
						class="cmd-link"
						onclick={() => goto(`/workspaces/${slug}/credentials`)}
					>
						<span class="cmd-chip"><KeyRound class="size-4" /></span>
						<span class="cmd-link__title">Add vault</span>
						<span class="cmd-link__sub">Store MCP credentials securely.</span>
					</button>
				</div>
			</div>
		{/if}
	</div>
</div>

<style>
	/* ============================================================
	   /dashboard — "Mission Control" command center
	   Scoped accent system layered on the app's shadcn tokens so
	   contrast + chrome stay cohesive while the page gains a
	   distinct, branded operator identity.
	   ============================================================ */
	.cmd {
		--c-accent: 190 95% 40%;
		--c-info: 211 90% 48%;
		--c-success: 158 78% 36%;
		--c-warning: 33 92% 46%;
		--c-danger: 0 78% 54%;
		--c-violet: 256 72% 60%;
		--cmd-radius: 14px;
	}
	:global(.dark) .cmd {
		--c-accent: 187 94% 54%;
		--c-info: 207 92% 62%;
		--c-success: 156 72% 50%;
		--c-warning: 38 95% 60%;
		--c-danger: 0 84% 66%;
		--c-violet: 256 86% 74%;
	}

	/* ── Signature command bar ─────────────────────────────────── */
	.cmd-hero {
		position: relative;
		overflow: hidden;
		border: 1px solid hsl(var(--c-accent) / 0.22);
		border-radius: var(--cmd-radius);
		padding: 1.5rem 1.5rem 1.25rem;
		background:
			radial-gradient(125% 145% at 0% 0%, hsl(var(--c-accent) / 0.16), transparent 52%),
			radial-gradient(110% 150% at 100% 0%, hsl(var(--c-violet) / 0.12), transparent 48%),
			hsl(var(--card));
		box-shadow:
			inset 0 1px 0 0 hsl(var(--c-accent) / 0.18),
			0 20px 44px -30px hsl(var(--c-accent) / 0.6);
	}
	.cmd-hero[data-state='alert'] {
		border-color: hsl(var(--c-danger) / 0.3);
		background:
			radial-gradient(125% 145% at 0% 0%, hsl(var(--c-danger) / 0.16), transparent 52%),
			radial-gradient(110% 150% at 100% 0%, hsl(var(--c-warning) / 0.1), transparent 48%),
			hsl(var(--card));
	}
	.cmd-hero__grid {
		position: absolute;
		inset: 0;
		pointer-events: none;
		background-image:
			linear-gradient(hsl(var(--foreground) / 0.05) 1px, transparent 1px),
			linear-gradient(90deg, hsl(var(--foreground) / 0.05) 1px, transparent 1px);
		background-size: 26px 26px;
		mask-image: radial-gradient(120% 100% at 50% -10%, black, transparent 72%);
		-webkit-mask-image: radial-gradient(120% 100% at 50% -10%, black, transparent 72%);
		opacity: 0.6;
	}
	.cmd-hero__content {
		position: relative;
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.cmd-hero__title {
		font-size: 1.6rem;
		font-weight: 650;
		letter-spacing: -0.02em;
		margin-top: 0.6rem;
		line-height: 1.15;
	}
	.cmd-hero__sub {
		font-size: 0.85rem;
		color: hsl(var(--muted-foreground));
		margin-top: 0.2rem;
	}
	.cmd-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	/* Status pill + pulsing orb */
	.cmd-status {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0.65rem;
		border-radius: 999px;
		font-size: 0.6875rem;
		font-weight: 600;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: hsl(var(--c-success));
		background: hsl(var(--c-success) / 0.12);
		border: 1px solid hsl(var(--c-success) / 0.28);
	}
	.cmd-status[data-state='active'] {
		color: hsl(var(--c-info));
		background: hsl(var(--c-info) / 0.12);
		border-color: hsl(var(--c-info) / 0.28);
	}
	.cmd-status[data-state='alert'] {
		color: hsl(var(--c-danger));
		background: hsl(var(--c-danger) / 0.12);
		border-color: hsl(var(--c-danger) / 0.3);
	}
	.cmd-status__orb {
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: currentColor;
		box-shadow: 0 0 0 0 currentColor;
		animation: cmd-pulse 2.4s ease-out infinite;
	}

	/* Vitals ticker */
	.cmd-vitals {
		position: relative;
		display: flex;
		flex-wrap: wrap;
		gap: 0 2rem;
		margin-top: 1.1rem;
		padding-top: 0.9rem;
		border-top: 1px solid hsl(var(--c-accent) / 0.14);
	}
	.cmd-vital {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.cmd-vital dt {
		font-size: 0.625rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: hsl(var(--muted-foreground));
		font-weight: 600;
	}
	.cmd-vital dd {
		font-family: 'Geist Mono', ui-monospace, monospace;
		font-size: 1.15rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		line-height: 1.2;
	}

	/* ── KPI tiles ─────────────────────────────────────────────── */
	.cmd-kpis {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
	}
	@media (min-width: 1024px) {
		.cmd-kpis {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}
	.cmd-tile {
		position: relative;
		overflow: hidden;
		border: 1px solid hsl(var(--border));
		border-radius: var(--cmd-radius);
		background: hsl(var(--card));
		padding: 1rem 1rem 1.1rem 1.15rem;
		transition:
			transform 0.16s ease,
			border-color 0.16s ease,
			box-shadow 0.16s ease;
	}
	.cmd-tile[data-accent='cyan'] {
		--tile: var(--c-accent);
	}
	.cmd-tile[data-accent='blue'] {
		--tile: var(--c-info);
	}
	.cmd-tile[data-accent='green'] {
		--tile: var(--c-success);
	}
	.cmd-tile[data-accent='amber'] {
		--tile: var(--c-warning);
	}
	.cmd-tile::before {
		content: '';
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 3px;
		background: hsl(var(--tile));
	}
	.cmd-tile::after {
		content: '';
		position: absolute;
		inset: 0;
		background: radial-gradient(75% 120% at 0% 0%, hsl(var(--tile) / 0.1), transparent 58%);
		pointer-events: none;
	}
	.cmd-tile:hover {
		transform: translateY(-2px);
		border-color: hsl(var(--tile) / 0.5);
		box-shadow: 0 14px 32px -22px hsl(var(--tile) / 0.8);
	}
	.cmd-tile__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.65rem;
	}
	.cmd-tile__label {
		font-size: 0.6875rem;
		text-transform: uppercase;
		letter-spacing: 0.09em;
		font-weight: 600;
		color: hsl(var(--muted-foreground));
	}
	.cmd-tile__head :global(svg) {
		color: hsl(var(--tile));
		opacity: 0.9;
	}
	.cmd-tile__value {
		font-family: 'Geist Mono', ui-monospace, monospace;
		font-size: 2rem;
		font-weight: 600;
		line-height: 1.05;
		letter-spacing: -0.02em;
		font-variant-numeric: tabular-nums;
	}
	.cmd-tile__sub {
		font-size: 0.75rem;
		color: hsl(var(--muted-foreground));
		margin-top: 0.25rem;
	}

	/* ── Panels ────────────────────────────────────────────────── */
	.cmd-cols {
		display: grid;
		grid-template-columns: 1fr;
		gap: 1rem;
	}
	@media (min-width: 1024px) {
		.cmd-cols {
			grid-template-columns: 2fr 1fr;
		}
	}
	.cmd-panel {
		border: 1px solid hsl(var(--border));
		border-radius: var(--cmd-radius);
		background: hsl(var(--card));
		overflow: hidden;
	}
	.cmd-panel--accent {
		border-color: hsl(var(--c-accent) / 0.4);
		background:
			radial-gradient(120% 130% at 0% 0%, hsl(var(--c-accent) / 0.08), transparent 60%),
			hsl(var(--card));
	}
	.cmd-panel__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.8rem 1rem;
		border-bottom: 1px solid hsl(var(--border));
		background: linear-gradient(180deg, hsl(var(--muted) / 0.45), transparent);
	}
	.cmd-panel__title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9rem;
		font-weight: 600;
	}
	.cmd-panel__title :global(svg) {
		width: 1rem;
		height: 1rem;
		color: hsl(var(--c-accent));
	}
	.cmd-panel__desc {
		font-size: 0.7rem;
		color: hsl(var(--muted-foreground));
		margin-top: 0.15rem;
	}
	.cmd-panel__body {
		padding: 0.5rem 0.75rem 0.85rem;
	}
	.cmd-empty-cta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		padding: 1.1rem 1rem;
	}

	/* ── Lists / rows ──────────────────────────────────────────── */
	.cmd-list {
		display: flex;
		flex-direction: column;
	}
	.cmd-list--changes {
		gap: 0.15rem;
	}
	.cmd-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.55rem 0.5rem;
		border-radius: 9px;
		transition: background 0.12s ease;
	}
	.cmd-row:hover {
		background: hsl(var(--muted) / 0.55);
	}
	.cmd-list:not(.cmd-list--changes) li + li .cmd-row {
		border-top: 1px solid hsl(var(--border));
		border-top-left-radius: 0;
		border-top-right-radius: 0;
	}
	.cmd-row__main {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		min-width: 0;
		flex: 1;
	}
	.cmd-row__stack {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}
	.cmd-row__title {
		font-size: 0.85rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
		max-width: 100%;
	}
	.cmd-row__title--sm {
		font-size: 0.8rem;
	}
	.cmd-row__meta {
		font-size: 0.6875rem;
		color: hsl(var(--muted-foreground));
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.cmd-row--change {
		gap: 0.5rem;
	}
	.cmd-avatar {
		font-size: 1.1rem;
		line-height: 1;
		flex-shrink: 0;
	}

	/* Status pills */
	.cmd-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.12rem 0.5rem;
		border-radius: 999px;
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: capitalize;
		white-space: nowrap;
		flex-shrink: 0;
		border: 1px solid transparent;
		color: hsl(var(--muted-foreground));
		background: hsl(var(--muted) / 0.7);
	}
	.cmd-pill__dot {
		width: 6px;
		height: 6px;
		border-radius: 999px;
		background: currentColor;
	}
	.cmd-pill[data-tone='running'] {
		color: hsl(var(--c-info));
		background: hsl(var(--c-info) / 0.12);
		border-color: hsl(var(--c-info) / 0.25);
	}
	.cmd-pill[data-tone='success'] {
		color: hsl(var(--c-success));
		background: hsl(var(--c-success) / 0.12);
		border-color: hsl(var(--c-success) / 0.25);
	}
	.cmd-pill[data-tone='error'] {
		color: hsl(var(--c-danger));
		background: hsl(var(--c-danger) / 0.12);
		border-color: hsl(var(--c-danger) / 0.28);
	}
	.cmd-pill[data-tone='warning'] {
		color: hsl(var(--c-warning));
		background: hsl(var(--c-warning) / 0.12);
		border-color: hsl(var(--c-warning) / 0.25);
	}

	.cmd-ts {
		font-family: 'Geist Mono', ui-monospace, monospace;
		font-size: 0.7rem;
		color: hsl(var(--muted-foreground));
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
	}

	/* Tags */
	.cmd-tag {
		display: inline-flex;
		align-items: center;
		padding: 0.05rem 0.4rem;
		border-radius: 6px;
		font-size: 0.625rem;
		font-weight: 600;
		color: hsl(var(--muted-foreground));
		border: 1px solid hsl(var(--border));
		white-space: nowrap;
		flex-shrink: 0;
	}
	.cmd-tag--ver {
		font-family: 'Geist Mono', ui-monospace, monospace;
		color: hsl(var(--c-accent));
		border-color: hsl(var(--c-accent) / 0.3);
		background: hsl(var(--c-accent) / 0.08);
	}

	/* Chips */
	.cmd-chip {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: 9px;
		color: hsl(var(--c-accent));
		background: hsl(var(--c-accent) / 0.12);
		border: 1px solid hsl(var(--c-accent) / 0.2);
		flex-shrink: 0;
	}
	.cmd-chip--sm {
		width: 1.65rem;
		height: 1.65rem;
		border-radius: 7px;
	}

	.cmd-blank {
		font-size: 0.85rem;
		color: hsl(var(--muted-foreground));
		text-align: center;
		padding: 1.5rem 0;
	}
	.cmd-linktext {
		color: hsl(var(--c-accent));
		font-weight: 500;
	}
	.cmd-linktext:hover {
		text-decoration: underline;
	}

	/* Section label */
	.cmd-sectionlabel {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.09em;
		color: hsl(var(--muted-foreground));
		margin-bottom: 0.65rem;
	}
	.cmd-sectionlabel :global(svg) {
		color: hsl(var(--c-accent));
	}

	/* ── Quick links ───────────────────────────────────────────── */
	.cmd-links {
		display: grid;
		grid-template-columns: 1fr;
		gap: 0.75rem;
	}
	@media (min-width: 768px) {
		.cmd-links {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}
	.cmd-link {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		text-align: left;
		padding: 0.9rem;
		border: 1px solid hsl(var(--border));
		border-radius: 12px;
		background: hsl(var(--card));
		transition:
			transform 0.14s ease,
			border-color 0.14s ease,
			background 0.14s ease;
	}
	.cmd-link:hover {
		transform: translateY(-1px);
		border-color: hsl(var(--c-accent) / 0.5);
		background: hsl(var(--c-accent) / 0.05);
	}
	.cmd-link .cmd-chip {
		margin-bottom: 0.55rem;
	}
	.cmd-link__title {
		font-size: 0.85rem;
		font-weight: 600;
	}
	.cmd-link__sub {
		font-size: 0.6875rem;
		color: hsl(var(--muted-foreground));
		margin-top: 0.1rem;
	}

	@keyframes cmd-pulse {
		0% {
			box-shadow: 0 0 0 0 hsl(var(--c-accent) / 0);
		}
		35% {
			box-shadow: 0 0 0 0 currentColor;
		}
		100% {
			box-shadow: 0 0 0 7px hsl(var(--c-accent) / 0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.cmd-status__orb {
			animation: none;
		}
		.cmd-tile,
		.cmd-link {
			transition: none;
		}
	}
</style>
