<script lang="ts">
	import type { PageData } from './$types';
	import { DEFAULT_WORKSPACE_SLUG } from '$lib/utils/workspace-path';
	import {
		ExternalLink,
		Bot,
		KeyRound,
		Layers,
		MessagesSquare,
		Plus,
		Sparkles,
		Terminal,
		Vault
	} from '@lucide/svelte';

	let { data }: { data: PageData } = $props();

	// Dashboard is platform-scoped (no [slug] in URL). The magic default slug
	// resolves server-side to the caller's active workspace.
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

	let liveLine = $derived.by(() => {
		const n = data.stats.activeSessions;
		if (n === 0) return 'nothing running right now';
		return `${n} session${n === 1 ? '' : 's'} live now`;
	});

	function formatRelative(iso: string): string {
		const t = Date.parse(iso);
		if (!Number.isFinite(t)) return '—';
		const diff = Date.now() - t;
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
		return new Date(t).toLocaleDateString();
	}

	function formatCount(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
		return `${n}`;
	}

	function formatDuration(ms: number | null): string {
		if (ms == null || !Number.isFinite(ms)) return '';
		if (ms < 1000) return `${ms}ms`;
		const s = Math.round(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m ${s % 60}s`;
		const h = Math.floor(m / 60);
		return `${h}h ${m % 60}m`;
	}

	// Status → { tone, label }. Tone drives the spine/dot colour and the
	// darkened text-safe label colour (all AA on Bone). Status is never colour
	// alone — every row carries the text label plus a dot.
	type Tone = 'signal' | 'verdant' | 'alert' | 'slate';

	function runTone(status: string): Tone {
		switch (status) {
			case 'running':
			case 'pending':
				return 'signal';
			case 'success':
				return 'verdant';
			case 'error':
				return 'alert';
			default:
				return 'slate';
		}
	}

	function sessionTone(status: string): Tone {
		const s = status.toLowerCase();
		if (s === 'running' || s === 'active' || s === 'live') return 'signal';
		if (s === 'idle' || s === 'paused' || s === 'waiting') return 'slate';
		if (s === 'error' || s === 'failed') return 'alert';
		if (s === 'done' || s === 'completed' || s === 'success') return 'verdant';
		return 'slate';
	}
</script>

<div class="cockpit-dash">
	<div class="cd-shell">
		<!-- ── Header ─────────────────────────────────────────────────────── -->
		<header class="cd-header">
			<div class="cd-header-lede">
				<p class="cd-eyebrow">Workspace overview</p>
				<h1 class="cd-title font-display">{greeting}, {displayName}</h1>
				<p class="cd-subtitle">
					<span class="cd-live-dot" class:is-live={data.stats.activeSessions > 0} aria-hidden="true"
					></span>
					{liveLine}
				</p>
			</div>
			<nav class="cd-cta" aria-label="Primary actions">
				<a class="cd-btn cd-btn--solid" href="/workspaces/{slug}/agents/quickstart">
					<Sparkles class="size-4" aria-hidden="true" /> Quickstart
				</a>
				<a class="cd-btn" href="/workbench">
					<Terminal class="size-4" aria-hidden="true" /> Generate a prompt
				</a>
				<a class="cd-btn" href="/workspaces/{slug}/settings/keys">
					<KeyRound class="size-4" aria-hidden="true" /> API key
				</a>
			</nav>
		</header>

		<!-- ── Region 1: headline counts ──────────────────────────────────── -->
		<section aria-label="Headline counts" class="cd-counts">
			<div class="cd-stat">
				<p class="cd-stat-label">Active</p>
				<p class="cd-stat-value hud-nums">{data.stats.activeSessions}</p>
				<p class="cd-stat-sub hud-nums">{data.stats.sessionsToday} started today</p>
			</div>
			<div class="cd-stat">
				<p class="cd-stat-label">Runs · 24h</p>
				<p class="cd-stat-value hud-nums">{data.runsHeadline.runs24h}</p>
				<p class="cd-stat-sub hud-nums" class:cd-sub-alert={data.runsHeadline.failed24h > 0}>
					{data.runsHeadline.failed24h} failed
				</p>
			</div>
			<div class="cd-stat">
				<p class="cd-stat-label">Agents</p>
				<p class="cd-stat-value hud-nums">{data.stats.totalAgents}</p>
				<p class="cd-stat-sub hud-nums">{data.stats.totalEnvironments} environments</p>
			</div>
			<div class="cd-stat">
				<p class="cd-stat-label">Tokens · 7d out</p>
				<p class="cd-stat-value hud-nums">{formatCount(data.stats.tokensOut7d)}</p>
				<p class="cd-stat-sub hud-nums">{formatCount(data.stats.tokensIn7d)} in</p>
			</div>
		</section>

		<!-- Zero-agent quickstart nudge (preserves the original CTA). -->
		{#if data.dashboardOk && data.stats.totalAgents === 0}
			<a class="cd-quickstart" href="/workspaces/{slug}/agents/quickstart">
				<div>
					<p class="cd-quickstart-title font-display">Build your first agent</p>
					<p class="cd-quickstart-sub">
						Pick a template or describe what you want — you're one step from a running session.
					</p>
				</div>
				<span class="cd-btn cd-btn--solid">
					<Sparkles class="size-4" aria-hidden="true" /> Go to Quickstart
				</span>
			</a>
		{/if}

		<!-- ── Region 2: recent runs ──────────────────────────────────────── -->
		<section class="cd-panel" aria-label="Recent runs">
			<div class="cd-panel-head">
				<h2 class="cd-panel-title font-display">Recent runs</h2>
				<a class="cd-viewall" href="/workspaces/{slug}/runs">
					View all <ExternalLink class="size-3.5" aria-hidden="true" />
				</a>
			</div>
			{#if data.recentRuns.length === 0}
				<div class="cd-empty">
					<p class="cd-empty-title">No runs yet.</p>
					<p class="cd-empty-body">
						Launch a workflow and its executions stream in here.
						<a class="cd-inline-link" href="/workspaces/{slug}/workflows">Open workflows</a>
					</p>
				</div>
			{:else}
				<ul class="cd-rows">
					{#each data.recentRuns as r, i (`${r.executionId}:${i}`)}
						{@const tone = runTone(r.status)}
						<li>
							<a
								class="cd-row cd-spine cd-spine--{tone}"
								href="/workspaces/{slug}/workflows/{r.workflowId}/runs/{r.executionId}"
							>
								<span class="cd-row-main">
									<span class="cd-status-dot cd-dot--{tone}" aria-hidden="true"></span>
									<span class="cd-row-name" title={r.workflowName}>{r.workflowName}</span>
									<span class="cd-status-label cd-label--{tone}">{r.status}</span>
								</span>
								<span class="cd-row-meta hud-nums">
									{#if r.durationMs != null}
										<span class="cd-row-dur">{formatDuration(r.durationMs)}</span>
									{/if}
									{#if r.sessionCount > 0}
										<span class="cd-row-tag">{r.sessionCount} sess</span>
									{/if}
									<span class="cd-row-time">{formatRelative(r.startedAt)}</span>
								</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<!-- ── Regions 3 + 4: active sessions | recent changes ────────────── -->
		<div class="cd-split">
			<section class="cd-panel" aria-label="Active sessions">
				<div class="cd-panel-head">
					<h2 class="cd-panel-title font-display">Active sessions</h2>
					<a class="cd-viewall" href="/workspaces/{slug}/sessions">
						View all <ExternalLink class="size-3.5" aria-hidden="true" />
					</a>
				</div>
				{#if data.activeSessions.length === 0}
					<div class="cd-empty">
						<p class="cd-empty-title">Nothing running.</p>
						<p class="cd-empty-body">
							Start a session to chat with an agent live.
							<a class="cd-inline-link" href="/workspaces/{slug}/sessions/new">Start a session</a>
						</p>
					</div>
				{:else}
					<ul class="cd-rows">
						{#each data.activeSessions as s, i (`${s.id}:${i}`)}
							{@const tone = sessionTone(s.status)}
							<li>
								<a
									class="cd-row cd-spine cd-spine--{tone}"
									href="/workspaces/{slug}/sessions/{s.id}"
								>
									<span class="cd-row-main">
										<span class="cd-status-dot cd-dot--{tone}" aria-hidden="true"></span>
										<span class="cd-row-stack">
											<span class="cd-row-name" title={s.title ?? 'Untitled session'}>
												{s.title ?? 'Untitled session'}
											</span>
											<span class="cd-row-agent">{s.agentName}</span>
										</span>
									</span>
									<span class="cd-row-meta hud-nums">
										<span class="cd-status-label cd-label--{tone}">{s.status}</span>
										<span class="cd-row-time">{formatRelative(s.updatedAt)}</span>
									</span>
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<section class="cd-panel" aria-label="Recent changes">
				<div class="cd-panel-head">
					<h2 class="cd-panel-title font-display">Recent changes</h2>
					<a class="cd-viewall" href="/workspaces/{slug}/agents">
						View all <ExternalLink class="size-3.5" aria-hidden="true" />
					</a>
				</div>
				{#if data.recentChanges.length === 0}
					<div class="cd-empty">
						<p class="cd-empty-title">No recent changes.</p>
						<p class="cd-empty-body">
							Published agent and environment versions land here.
						</p>
					</div>
				{:else}
					<ul class="cd-changes">
						{#each data.recentChanges as c, i (`${c.kind}:${c.resourceId}:${c.version}:${i}`)}
							<li>
								<a
									class="cd-change"
									href={c.kind === 'agent'
										? `/workspaces/${slug}/agents/${c.resourceId}`
										: `/workspaces/${slug}/environments/${c.resourceId}`}
								>
									{#if c.kind === 'agent'}
										<Bot class="size-3.5 cd-change-icon" aria-hidden="true" />
									{:else}
										<Layers class="size-3.5 cd-change-icon" aria-hidden="true" />
									{/if}
									<span class="cd-change-name" title={c.resourceName}>{c.resourceName}</span>
									<span class="cd-change-ver hud-nums">v{c.version}</span>
									<span class="cd-change-time hud-nums">
										{c.publishedAt ? formatRelative(c.publishedAt) : 'draft'}
									</span>
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		</div>

		<!-- ── Resource quick-links ───────────────────────────────────────── -->
		<nav class="cd-tiles" aria-label="Create resources">
			<a class="cd-tile" href="/workspaces/{slug}/agents/new">
				<Bot class="size-4 cd-tile-icon" aria-hidden="true" />
				<span class="cd-tile-title">Create agent</span>
				<span class="cd-tile-sub">Persistent config, versioned.</span>
				<Plus class="size-4 cd-tile-plus" aria-hidden="true" />
			</a>
			<a class="cd-tile" href="/workspaces/{slug}/sessions/new">
				<MessagesSquare class="size-4 cd-tile-icon" aria-hidden="true" />
				<span class="cd-tile-title">New session</span>
				<span class="cd-tile-sub">Chat directly with an agent.</span>
				<Plus class="size-4 cd-tile-plus" aria-hidden="true" />
			</a>
			<a class="cd-tile" href="/workspaces/{slug}/environments/new">
				<Layers class="size-4 cd-tile-icon" aria-hidden="true" />
				<span class="cd-tile-title">Define environment</span>
				<span class="cd-tile-sub">Sandbox template + networking.</span>
				<Plus class="size-4 cd-tile-plus" aria-hidden="true" />
			</a>
			<a class="cd-tile" href="/workspaces/{slug}/credentials">
				<Vault class="size-4 cd-tile-icon" aria-hidden="true" />
				<span class="cd-tile-title">Add vault</span>
				<span class="cd-tile-sub">Store MCP credentials securely.</span>
				<Plus class="size-4 cd-tile-plus" aria-hidden="true" />
			</a>
		</nav>
	</div>
</div>

<style>
	/* ── Operator-console palette (contract design tokens) ────────────────
	 * Ink / Bone editorial base; Signal / Slate / Verdant / Alert status
	 * semantics. Raw Signal/Verdant are reserved for the spine + dots
	 * (3px / non-text graphical, AA at the 3:1 UI threshold). Label TEXT uses
	 * darkened text-safe variants (>=4.5:1 on Bone) per the design review. */
	.cockpit-dash {
		--ink: #12151c;
		--bone: #f4f1e9;
		--bone-panel: #fbf9f4;
		--signal: #b8621b;
		--slate: #59616e;
		--verdant: #2e7d57;
		--alert: #b23a3a;
		/* Text-safe (darkened) status hues — AA on Bone. */
		--signal-ink: #8a4712;
		--verdant-ink: #1f6045;
		--alert-ink: #9a2f2f;
		--line: #dfd8c9;
		--line-strong: #cabfa8;

		background-color: var(--bone);
		color: var(--ink);
		min-height: 100%;
		height: 100%;
		overflow-y: auto;
		font-family: 'Inter', system-ui, sans-serif;
	}

	.cd-shell {
		max-width: 78rem;
		margin: 0 auto;
		padding: 2rem 1.5rem 3rem;
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	/* ── Header ──────────────────────────────────────────────────────────── */
	.cd-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 1.5rem;
		flex-wrap: wrap;
		padding-bottom: 1.25rem;
		border-bottom: 2px solid var(--ink);
	}
	.cd-eyebrow {
		font-family: 'Space Grotesk', system-ui, sans-serif;
		text-transform: uppercase;
		letter-spacing: 0.16em;
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--slate);
		margin: 0 0 0.35rem;
	}
	.cd-title {
		font-size: clamp(1.6rem, 3.2vw, 2.25rem);
		font-weight: 700;
		line-height: 1.05;
		margin: 0;
		color: var(--ink);
	}
	.cd-subtitle {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0.55rem 0 0;
		font-size: 0.9rem;
		color: var(--slate);
	}
	.cd-live-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 999px;
		background: var(--slate);
		flex: none;
	}
	.cd-live-dot.is-live {
		background: var(--verdant);
		box-shadow: 0 0 0 0 color-mix(in srgb, var(--verdant) 55%, transparent);
		animation: cd-pulse 1.8s ease-out infinite;
	}
	@keyframes cd-pulse {
		0% {
			box-shadow: 0 0 0 0 color-mix(in srgb, var(--verdant) 55%, transparent);
		}
		70% {
			box-shadow: 0 0 0 5px color-mix(in srgb, var(--verdant) 0%, transparent);
		}
		100% {
			box-shadow: 0 0 0 0 color-mix(in srgb, var(--verdant) 0%, transparent);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.cd-live-dot.is-live {
			animation: none;
		}
	}

	.cd-cta {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.cd-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.5rem 0.85rem;
		border-radius: 0.5rem;
		border: 1.5px solid var(--line-strong);
		background: var(--bone-panel);
		color: var(--ink);
		font-size: 0.85rem;
		font-weight: 550;
		text-decoration: none;
		transition:
			border-color 0.12s ease,
			background 0.12s ease,
			transform 0.06s ease;
	}
	.cd-btn:hover {
		border-color: var(--ink);
		background: #fff;
	}
	.cd-btn:active {
		transform: translateY(1px);
	}
	.cd-btn--solid {
		background: var(--ink);
		border-color: var(--ink);
		color: var(--bone);
	}
	.cd-btn--solid:hover {
		background: #000;
		color: #fff;
	}

	/* ── Region 1: counts ────────────────────────────────────────────────── */
	.cd-counts {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 1rem;
	}
	.cd-stat {
		background: var(--bone-panel);
		border: 1px solid var(--line);
		border-top: 3px solid var(--ink);
		border-radius: 0.5rem;
		padding: 1rem 1.1rem 1.1rem;
		min-width: 0;
	}
	.cd-stat-label {
		font-family: 'Space Grotesk', system-ui, sans-serif;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		font-size: 0.68rem;
		font-weight: 600;
		color: var(--slate);
		margin: 0 0 0.5rem;
	}
	.cd-stat-value {
		font-size: clamp(1.9rem, 4vw, 2.6rem);
		font-weight: 600;
		line-height: 1;
		letter-spacing: -0.02em;
		color: var(--ink);
		margin: 0;
	}
	.cd-stat-sub {
		font-size: 0.78rem;
		color: var(--slate);
		margin: 0.5rem 0 0;
	}
	.cd-sub-alert {
		color: var(--alert-ink);
		font-weight: 600;
	}

	/* ── Zero-agent quickstart ───────────────────────────────────────────── */
	.cd-quickstart {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		padding: 1.1rem 1.25rem;
		border-radius: 0.5rem;
		border: 1.5px solid var(--signal);
		background: color-mix(in srgb, var(--signal) 8%, var(--bone-panel));
		text-decoration: none;
		color: var(--ink);
	}
	.cd-quickstart-title {
		font-size: 1.1rem;
		font-weight: 700;
		margin: 0;
	}
	.cd-quickstart-sub {
		font-size: 0.85rem;
		color: var(--slate);
		margin: 0.25rem 0 0;
	}

	/* ── Panels ──────────────────────────────────────────────────────────── */
	.cd-panel {
		background: var(--bone-panel);
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		padding: 1.1rem 1.25rem 1.25rem;
	}
	.cd-panel-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 0.85rem;
		padding-bottom: 0.6rem;
		border-bottom: 1px solid var(--line);
	}
	.cd-panel-title {
		font-size: 0.82rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--ink);
		margin: 0;
	}
	.cd-viewall {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--signal-ink);
		text-decoration: none;
		white-space: nowrap;
	}
	.cd-viewall:hover {
		text-decoration: underline;
	}

	.cd-split {
		display: grid;
		grid-template-columns: 1.6fr 1fr;
		gap: 1.5rem;
		align-items: start;
	}

	/* ── Rows + status spine (the signature treatment) ───────────────────── */
	.cd-rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.cd-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.6rem 0.7rem;
		border-radius: 0.35rem;
		text-decoration: none;
		color: var(--ink);
		transition: background 0.1s ease;
	}
	.cd-spine {
		border-left: 3px solid var(--slate);
	}
	.cd-spine--signal {
		border-left-color: var(--signal);
	}
	.cd-spine--verdant {
		border-left-color: var(--verdant);
	}
	.cd-spine--alert {
		border-left-color: var(--alert);
	}
	.cd-spine--slate {
		border-left-color: var(--slate);
	}
	.cd-row:hover {
		background: color-mix(in srgb, var(--ink) 5%, transparent);
	}
	.cd-row-main {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		min-width: 0;
		flex: 1;
	}
	.cd-status-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 999px;
		flex: none;
		background: var(--slate);
	}
	.cd-dot--signal {
		background: var(--signal);
	}
	.cd-dot--verdant {
		background: var(--verdant);
	}
	.cd-dot--alert {
		background: var(--alert);
	}
	.cd-dot--slate {
		background: var(--slate);
	}
	.cd-row-stack {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.cd-row-name {
		font-size: 0.9rem;
		font-weight: 550;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.cd-row-agent {
		font-size: 0.75rem;
		color: var(--slate);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.cd-status-label {
		font-family: 'Space Grotesk', system-ui, sans-serif;
		font-size: 0.68rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		white-space: nowrap;
	}
	.cd-label--signal {
		color: var(--signal-ink);
	}
	.cd-label--verdant {
		color: var(--verdant-ink);
	}
	.cd-label--alert {
		color: var(--alert-ink);
	}
	.cd-label--slate {
		color: var(--slate);
	}
	.cd-row-meta {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		font-size: 0.75rem;
		color: var(--slate);
		white-space: nowrap;
		flex: none;
	}
	.cd-row-tag {
		padding: 0.05rem 0.4rem;
		border: 1px solid var(--line-strong);
		border-radius: 0.3rem;
		color: var(--slate);
	}
	.cd-row-time {
		color: var(--slate);
	}
	.cd-row-dur {
		color: var(--ink);
	}

	/* ── Recent changes ──────────────────────────────────────────────────── */
	.cd-changes {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	.cd-change {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4rem 0.4rem;
		border-radius: 0.35rem;
		text-decoration: none;
		color: var(--ink);
		font-size: 0.82rem;
		transition: background 0.1s ease;
	}
	.cd-change:hover {
		background: color-mix(in srgb, var(--ink) 5%, transparent);
	}
	.cd-change-icon {
		color: var(--slate);
		flex: none;
	}
	.cd-change-name {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.cd-change-ver {
		font-size: 0.72rem;
		color: var(--slate);
		padding: 0.02rem 0.35rem;
		border: 1px solid var(--line-strong);
		border-radius: 0.3rem;
	}
	.cd-change-time {
		font-size: 0.72rem;
		color: var(--slate);
		white-space: nowrap;
	}

	/* ── Empty states ────────────────────────────────────────────────────── */
	.cd-empty {
		padding: 1.4rem 0.5rem;
		text-align: center;
	}
	.cd-empty-title {
		font-family: 'Space Grotesk', system-ui, sans-serif;
		font-weight: 600;
		font-size: 0.9rem;
		color: var(--ink);
		margin: 0 0 0.3rem;
	}
	.cd-empty-body {
		font-size: 0.82rem;
		color: var(--slate);
		margin: 0;
		line-height: 1.5;
	}
	.cd-inline-link,
	.cd-change-name {
		color: inherit;
	}
	.cd-inline-link {
		color: var(--signal-ink);
		font-weight: 600;
		text-decoration: none;
	}
	.cd-inline-link:hover {
		text-decoration: underline;
	}

	/* ── Quick-link tiles ────────────────────────────────────────────────── */
	.cd-tiles {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0.85rem;
	}
	.cd-tile {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		padding: 0.95rem 1rem;
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		background: var(--bone-panel);
		text-decoration: none;
		color: var(--ink);
		transition:
			border-color 0.12s ease,
			background 0.12s ease;
	}
	.cd-tile:hover {
		border-color: var(--ink);
		background: #fff;
	}
	.cd-tile-icon {
		color: var(--signal-ink);
	}
	.cd-tile-title {
		font-weight: 600;
		font-size: 0.88rem;
		margin-top: 0.3rem;
	}
	.cd-tile-sub {
		font-size: 0.74rem;
		color: var(--slate);
	}
	.cd-tile-plus {
		position: absolute;
		top: 0.85rem;
		right: 0.85rem;
		color: var(--slate);
		opacity: 0;
		transition: opacity 0.12s ease;
	}
	.cd-tile:hover .cd-tile-plus {
		opacity: 1;
	}

	/* ── Focus: visible AA keyboard ring on every interactive element ────── */
	.cd-btn:focus-visible,
	.cd-viewall:focus-visible,
	.cd-row:focus-visible,
	.cd-change:focus-visible,
	.cd-tile:focus-visible,
	.cd-inline-link:focus-visible,
	.cd-quickstart:focus-visible {
		outline: 2px solid var(--ink);
		outline-offset: 2px;
		border-radius: 0.35rem;
	}

	/* ── Responsive ──────────────────────────────────────────────────────── */
	@media (max-width: 900px) {
		.cd-split {
			grid-template-columns: 1fr;
		}
	}
	@media (max-width: 768px) {
		.cd-counts {
			grid-template-columns: repeat(2, 1fr);
		}
		.cd-tiles {
			grid-template-columns: repeat(2, 1fr);
		}
	}
	@media (max-width: 480px) {
		.cd-shell {
			padding: 1.25rem 1rem 2.5rem;
		}
		.cd-counts,
		.cd-tiles {
			grid-template-columns: 1fr;
		}
		.cd-cta {
			width: 100%;
		}
		.cd-btn {
			flex: 1;
			justify-content: center;
		}
		.cd-row-meta {
			gap: 0.5rem;
		}
	}
</style>
