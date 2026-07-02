<script lang="ts">
	import { goto } from '$app/navigation';
	import type { PageData } from './$types';
	import {
		Activity,
		AlertTriangle,
		ArrowRight,
		Bot,
		CheckCircle2,
		Clock3,
		ExternalLink,
		GitBranch,
		KeyRound,
		Layers,
		MessageSquare,
		PlayCircle,
		Radar,
		ServerCog,
		Workflow,
		Zap
	} from '@lucide/svelte';

	let { data } = $props<{ data: PageData }>();

	const slug = 'default';

	const healthCopy = {
		healthy: { label: 'Healthy', icon: CheckCircle2 },
		attention: { label: 'Attention', icon: AlertTriangle },
		degraded: { label: 'Degraded', icon: AlertTriangle }
	} as const;

	function formatRelative(iso: string | null | undefined): string {
		if (!iso) return 'No timestamp';
		const then = new Date(iso).getTime();
		if (!Number.isFinite(then)) return 'Unknown time';
		const diff = Date.now() - then;
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		return new Date(iso).toLocaleDateString();
	}

	function formatNumber(value: number | null | undefined): string {
		if (value === null || value === undefined || !Number.isFinite(value)) return 'Unavailable';
		return Intl.NumberFormat(undefined, { notation: value > 999_999 ? 'compact' : 'standard' }).format(
			value
		);
	}

	function formatCost(value: number | null | undefined): string {
		if (value === null || value === undefined || !Number.isFinite(value)) return 'Unavailable';
		return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value);
	}

	function pressureLabel(value: number | null | undefined): string {
		if (value === null || value === undefined) return 'Unavailable';
		if (value >= 0.9) return 'Critical pressure';
		if (value >= 0.75) return 'High pressure';
		if (value >= 0.55) return 'Moderate pressure';
		return 'Headroom available';
	}

	function itemIcon(kind: string) {
		if (kind === 'session') return Bot;
		if (kind === 'run') return Workflow;
		if (kind === 'preview') return Layers;
		if (kind === 'deploy') return GitBranch;
		return Activity;
	}

	function statusTone(status: string | null | undefined): string {
		const normalized = String(status ?? '').toLowerCase();
		if (['success', 'ready', 'healthy', 'published'].includes(normalized)) return 'good';
		if (['error', 'failed', 'degraded'].includes(normalized)) return 'bad';
		if (['pending', 'running', 'progressing', 'active', 'starting'].includes(normalized)) return 'live';
		return 'neutral';
	}

	const radarSlots = [
		{ label: 'Sessions', value: data.counts.activeSessions, kind: 'session', x: 67, y: 26 },
		{ label: 'Runs', value: data.counts.liveRuns, kind: 'run', x: 75, y: 62 },
		{ label: 'Previews', value: data.counts.livePreviews, kind: 'preview', x: 32, y: 72 },
		{ label: 'Deploys', value: data.counts.activeDeploys, kind: 'deploy', x: 26, y: 34 }
	];
</script>

<svelte:head>
	<title>Dashboard | Operations Command Center</title>
</svelte:head>

<div class="command-shell">
	<header class="health-ribbon {data.health}">
		<div class="health-state">
			<svelte:component this={healthCopy[data.health].icon} class="health-icon" aria-hidden="true" />
			<div>
				<p class="eyebrow">Unified system health</p>
				<h1>{healthCopy[data.health].label}: {data.narrative}</h1>
			</div>
		</div>
		<div class="health-meta">
			<span>Updated {formatRelative(data.loadedAt)}</span>
			<span>Last signal {formatRelative(data.lastSignalAt)}</span>
		</div>
		{#if data.healthReasons.length > 0}
			<ul class="reason-list" aria-label="Health reasons">
				{#each data.healthReasons as reason}
					<li>{reason}</li>
				{/each}
			</ul>
		{/if}
	</header>

	<section class="hero-grid" aria-label="Current operations">
		<div class="radar-panel">
			<div class="section-head">
				<div>
					<p class="eyebrow">Running now</p>
					<h2>Ops radar</h2>
				</div>
				<Radar class="section-icon" aria-hidden="true" />
			</div>

			<div class="radar" aria-label="Live work by resource type">
				<div class="radar-core {data.health}">
					<strong>{data.liveWork.length}</strong>
					<span>live items</span>
				</div>
				{#each radarSlots as slot}
					<div
						class="radar-node {slot.kind} {slot.value > 0 ? 'active' : ''}"
						style={`left:${slot.x}%; top:${slot.y}%; --magnitude:${Math.min(1, Math.max(0.28, slot.value / Math.max(1, data.liveWork.length)))};`}
						aria-label={`${slot.label}: ${slot.value}`}
					>
						<span>{slot.value}</span>
					</div>
				{/each}
			</div>

			<div class="radar-legend">
				{#each radarSlots as slot}
					<div>
						<span class="legend-dot {slot.kind}"></span>
						<strong>{slot.value}</strong>
						<small>{slot.label}</small>
					</div>
				{/each}
			</div>
		</div>

		<div class="live-panel">
			<div class="section-head">
				<div>
					<p class="eyebrow">Priority queue</p>
					<h2>What is running right now</h2>
				</div>
				<a class="subtle-link" href="/workspaces/{slug}/runs">All runs <ExternalLink /></a>
			</div>

			{#if data.liveWork.length === 0}
				<div class="empty-state">
					<Clock3 aria-hidden="true" />
					<p>No active sessions, runs, previews, or deploys are reporting right now.</p>
				</div>
			{:else}
				<div class="live-list">
					{#each data.liveWork.slice(0, 7) as item}
						<details class="live-row">
							<summary>
								<svelte:component this={itemIcon(item.kind)} class="row-icon" aria-hidden="true" />
								<span class="row-main">
									<strong>{item.title}</strong>
									<small>{item.meta} · {formatRelative(item.at)}</small>
								</span>
								<span class="status {statusTone(item.status)}">{item.status}</span>
							</summary>
							<div class="row-detail">
								<span>ID {item.id}</span>
								<a href={item.href}>Open detail <ArrowRight /></a>
							</div>
						</details>
					{/each}
				</div>
			{/if}
		</div>
	</section>

	<section class="capacity-strip" aria-label="Capacity and usage">
		<div class="pressure-cell">
			<ServerCog aria-hidden="true" />
			<div>
				<span>Capacity pressure</span>
				<strong>{pressureLabel(data.capacity.resourcePressure)}</strong>
				<small>
					{#if data.capacity.available}
						{data.capacity.pendingWorkloads ?? 'Unavailable'} pending · {data.capacity.blockedWorkloads ?? 'Unavailable'} blocked
					{:else}
						{data.capacity.error ?? 'Capacity observer unavailable'}
					{/if}
				</small>
			</div>
		</div>
		<div>
			<span>Admitted work</span>
			<strong>{formatNumber(data.capacity.admittedWorkloads)}</strong>
			<small>
				{#if data.capacity.available}
					{data.capacity.inactiveQueues ?? 'Unavailable'} inactive queues
				{:else}
					Queue state unavailable
				{/if}
			</small>
		</div>
		<div>
			<span>Tokens 7d</span>
			<strong>{formatNumber((data.usage.tokensIn7d ?? 0) + (data.usage.tokensOut7d ?? 0))}</strong>
			<small>{formatNumber(data.usage.toolCalls7d)} tool calls</small>
		</div>
		<div>
			<span>Cost 30d</span>
			<strong>{formatCost(data.usage.cost30d)}</strong>
			<small>{data.usage.topModel ?? 'Model mix unavailable'}</small>
		</div>
	</section>

	<section class="lower-grid">
		<div class="timeline-panel">
			<div class="section-head">
				<div>
					<p class="eyebrow">Recent signal</p>
					<h2>What happened recently</h2>
				</div>
				<Activity class="section-icon" aria-hidden="true" />
			</div>

			{#if data.timeline.length === 0}
				<div class="empty-state compact">
					<p>No recent runs, published changes, or GitOps events are available.</p>
				</div>
			{:else}
				<ol class="timeline">
					{#each data.timeline as event}
						<li class={statusTone(event.status)}>
							<span class="timeline-pin"></span>
							<div>
								<a href={event.href}>{event.title}</a>
								<p>{event.detail ?? event.kind}</p>
							</div>
							<span class="status {statusTone(event.status)}">{event.status}</span>
							<time>{formatRelative(event.at)}</time>
						</li>
					{/each}
				</ol>
			{/if}
		</div>

		<aside class="operator-panel" aria-label="Operator actions and source status">
			<div class="section-head">
				<div>
					<p class="eyebrow">Operator lane</p>
					<h2>Act or drill down</h2>
				</div>
				<Zap class="section-icon" aria-hidden="true" />
			</div>

			<div class="action-grid">
				<button type="button" onclick={() => goto(`/workspaces/${slug}/sessions/new`)}>
					<PlayCircle aria-hidden="true" /> New session
				</button>
				<button type="button" onclick={() => goto(`/workspaces/${slug}/agents/quickstart`)}>
					<Bot aria-hidden="true" /> Agent quickstart
				</button>
				<button type="button" onclick={() => goto('/workbench')}>
					<MessageSquare aria-hidden="true" /> Prompt workbench
				</button>
				<button type="button" onclick={() => goto(`/workspaces/${slug}/settings/keys`)}>
					<KeyRound aria-hidden="true" /> API keys
				</button>
			</div>

			<details class="source-disclosure">
				<summary>Telemetry sources</summary>
				<ul>
					{#each Object.entries(data.sources) as [name, source]}
						<li class:offline={!source.ok}>
							<span>{name}</span>
							<strong>{source.ok ? 'online' : source.error}</strong>
						</li>
					{/each}
				</ul>
			</details>

			{#if data.capacity.warnings.length > 0}
				<details class="source-disclosure" open>
					<summary>Capacity warnings</summary>
					<ul>
						{#each data.capacity.warnings as warning}
							<li class="offline"><span>{warning}</span></li>
						{/each}
					</ul>
				</details>
			{/if}
		</aside>
	</section>
</div>

<style>
	:global(body) {
		background: #111417;
	}

	.command-shell {
		min-height: 100%;
		min-width: 0;
		overflow-y: auto;
		background:
			linear-gradient(135deg, rgba(55, 200, 214, 0.12), transparent 34rem),
			linear-gradient(180deg, #111417 0%, #181b1e 48%, #f4f1e8 48%, #f4f1e8 100%);
		color: #f4f1e8;
		padding: 24px;
	}

	.health-ribbon,
	.radar-panel,
	.live-panel,
	.timeline-panel,
	.operator-panel,
	.capacity-strip {
		border: 1px solid rgba(244, 241, 232, 0.16);
		background: rgba(17, 20, 23, 0.88);
		box-shadow: 0 24px 70px rgba(0, 0, 0, 0.28);
	}

	.health-ribbon {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 18px;
		max-width: 1440px;
		margin: 0 auto 18px;
		padding: 18px;
		border-left: 6px solid #4fb06d;
	}

	.health-ribbon.attention {
		border-left-color: #d99a2b;
	}

	.health-ribbon.degraded {
		border-left-color: #d94a3a;
	}

	.health-state {
		display: flex;
		gap: 14px;
		align-items: flex-start;
	}

	.health-icon {
		width: 30px;
		height: 30px;
		color: #37c8d6;
		flex: 0 0 auto;
	}

	h1,
	h2,
	p {
		margin: 0;
	}

	h1 {
		max-width: 980px;
		font-size: clamp(1.25rem, 2.2vw, 2rem);
		line-height: 1.15;
		font-weight: 650;
		letter-spacing: 0;
	}

	h2 {
		font-size: 1.05rem;
		font-weight: 650;
		letter-spacing: 0;
	}

	.eyebrow {
		color: rgba(244, 241, 232, 0.62);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.72rem;
		text-transform: uppercase;
		margin-bottom: 5px;
	}

	.health-meta {
		display: flex;
		flex-direction: column;
		gap: 4px;
		align-items: flex-end;
		color: rgba(244, 241, 232, 0.68);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.75rem;
		white-space: nowrap;
	}

	.reason-list {
		grid-column: 1 / -1;
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		padding: 0;
		margin: 0;
		list-style: none;
	}

	.reason-list li {
		border: 1px solid rgba(217, 154, 43, 0.38);
		background: rgba(217, 154, 43, 0.12);
		color: #f4f1e8;
		padding: 7px 10px;
		font-size: 0.78rem;
	}

	.hero-grid,
	.lower-grid {
		display: grid;
		grid-template-columns: minmax(360px, 0.92fr) minmax(0, 1.35fr);
		gap: 18px;
		max-width: 1440px;
		margin: 0 auto 18px;
	}

	.radar-panel,
	.live-panel,
	.timeline-panel,
	.operator-panel {
		padding: 18px;
	}

	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 16px;
	}

	.section-icon,
	.subtle-link svg {
		width: 18px;
		height: 18px;
		color: #37c8d6;
	}

	.subtle-link {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: rgba(244, 241, 232, 0.72);
		font-size: 0.82rem;
		text-decoration: none;
	}

	.radar {
		position: relative;
		aspect-ratio: 1;
		min-height: 320px;
		border: 1px solid rgba(244, 241, 232, 0.14);
		background:
			repeating-radial-gradient(circle, rgba(244, 241, 232, 0.11) 0 1px, transparent 1px 64px),
			linear-gradient(135deg, rgba(55, 200, 214, 0.08), rgba(79, 176, 109, 0.06));
		overflow: hidden;
	}

	.radar::before,
	.radar::after {
		content: '';
		position: absolute;
		inset: 50% auto auto 50%;
		width: 1px;
		height: 100%;
		background: rgba(244, 241, 232, 0.13);
		transform-origin: top;
	}

	.radar::after {
		transform: rotate(90deg);
	}

	.radar-core,
	.radar-node {
		position: absolute;
		border-radius: 999px;
		display: grid;
		place-items: center;
	}

	.radar-core {
		inset: 50% auto auto 50%;
		width: 118px;
		height: 118px;
		transform: translate(-50%, -50%);
		border: 1px solid rgba(55, 200, 214, 0.58);
		background: #111417;
		z-index: 2;
	}

	.radar-core strong {
		font-size: 2.15rem;
		line-height: 1;
	}

	.radar-core span {
		color: rgba(244, 241, 232, 0.64);
		font-size: 0.75rem;
	}

	.radar-node {
		width: 58px;
		height: 58px;
		transform: translate(-50%, -50%);
		border: 1px solid rgba(244, 241, 232, 0.22);
		background: rgba(244, 241, 232, 0.08);
		color: rgba(244, 241, 232, 0.72);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	}

	.radar-node.active {
		border-color: #37c8d6;
		color: #f4f1e8;
		animation: pulse 2.8s ease-in-out infinite;
	}

	.radar-node.session.active {
		border-color: #37c8d6;
	}

	.radar-node.run.active {
		border-color: #4fb06d;
	}

	.radar-node.preview.active {
		border-color: #d99a2b;
	}

	.radar-node.deploy.active {
		border-color: #d94a3a;
	}

	.radar-legend {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 8px;
		margin-top: 12px;
	}

	.radar-legend div {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 2px 7px;
		align-items: center;
		color: rgba(244, 241, 232, 0.76);
	}

	.radar-legend small {
		grid-column: 2;
		font-size: 0.72rem;
	}

	.legend-dot {
		width: 9px;
		height: 9px;
		border-radius: 999px;
		background: #37c8d6;
	}

	.legend-dot.run {
		background: #4fb06d;
	}

	.legend-dot.preview {
		background: #d99a2b;
	}

	.legend-dot.deploy {
		background: #d94a3a;
	}

	.live-list {
		display: grid;
		gap: 8px;
	}

	.live-row {
		border: 1px solid rgba(244, 241, 232, 0.13);
		background: rgba(244, 241, 232, 0.045);
	}

	.live-row summary {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: 12px;
		align-items: center;
		padding: 12px;
		cursor: pointer;
		list-style: none;
	}

	.live-row summary::-webkit-details-marker {
		display: none;
	}

	.row-icon {
		width: 18px;
		height: 18px;
		color: #37c8d6;
	}

	.row-main {
		min-width: 0;
	}

	.row-main strong,
	.row-main small {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.row-main small,
	.timeline p,
	.capacity-strip small,
	.source-disclosure strong {
		color: rgba(244, 241, 232, 0.62);
		font-size: 0.75rem;
		font-weight: 400;
	}

	.status {
		border: 1px solid rgba(244, 241, 232, 0.16);
		padding: 4px 8px;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.68rem;
		text-transform: uppercase;
		white-space: nowrap;
	}

	.status.good {
		color: #92d8a7;
		border-color: rgba(79, 176, 109, 0.5);
	}

	.status.live {
		color: #8de7ef;
		border-color: rgba(55, 200, 214, 0.55);
	}

	.status.bad {
		color: #ff9c91;
		border-color: rgba(217, 74, 58, 0.58);
	}

	.row-detail {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		padding: 0 12px 12px 42px;
		color: rgba(244, 241, 232, 0.62);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.72rem;
	}

	.row-detail a {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		color: #37c8d6;
		text-decoration: none;
	}

	.row-detail svg {
		width: 13px;
		height: 13px;
	}

	.capacity-strip {
		display: grid;
		grid-template-columns: 1.25fr repeat(3, 1fr);
		gap: 1px;
		max-width: 1440px;
		margin: 0 auto 18px;
		background: rgba(244, 241, 232, 0.12);
	}

	.capacity-strip > div {
		min-width: 0;
		padding: 16px;
		background: #15191c;
	}

	.capacity-strip span {
		display: block;
		color: rgba(244, 241, 232, 0.62);
		font-size: 0.73rem;
		text-transform: uppercase;
	}

	.capacity-strip strong {
		display: block;
		margin: 6px 0 3px;
		font-size: 1.25rem;
	}

	.pressure-cell {
		display: flex;
		gap: 12px;
		align-items: flex-start;
	}

	.pressure-cell svg {
		width: 23px;
		height: 23px;
		color: #37c8d6;
	}

	.lower-grid {
		grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.55fr);
		align-items: start;
	}

	.timeline {
		position: relative;
		display: grid;
		gap: 10px;
		padding: 0;
		margin: 0;
		list-style: none;
	}

	.timeline li {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto auto;
		gap: 10px;
		align-items: center;
		border: 1px solid rgba(244, 241, 232, 0.12);
		background: rgba(244, 241, 232, 0.04);
		padding: 10px;
	}

	.timeline-pin {
		width: 10px;
		height: 10px;
		border-radius: 999px;
		background: #8de7ef;
	}

	.timeline li.good .timeline-pin {
		background: #4fb06d;
	}

	.timeline li.bad .timeline-pin {
		background: #d94a3a;
	}

	.timeline a {
		color: #f4f1e8;
		text-decoration: none;
		font-weight: 600;
	}

	.timeline time {
		color: rgba(244, 241, 232, 0.58);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.72rem;
		white-space: nowrap;
	}

	.action-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
	}

	.action-grid button {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 48px;
		border: 1px solid rgba(244, 241, 232, 0.15);
		background: rgba(244, 241, 232, 0.06);
		color: #f4f1e8;
		padding: 10px;
		font: inherit;
		cursor: pointer;
	}

	.action-grid svg {
		width: 17px;
		height: 17px;
		color: #37c8d6;
	}

	.source-disclosure {
		margin-top: 14px;
		border: 1px solid rgba(244, 241, 232, 0.13);
		padding: 10px;
	}

	.source-disclosure summary {
		cursor: pointer;
		font-weight: 650;
	}

	.source-disclosure ul {
		display: grid;
		gap: 8px;
		padding: 10px 0 0;
		margin: 0;
		list-style: none;
	}

	.source-disclosure li {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		font-size: 0.8rem;
	}

	.source-disclosure li.offline strong,
	.source-disclosure li.offline span {
		color: #ffb1a8;
	}

	.empty-state {
		display: grid;
		place-items: center;
		min-height: 220px;
		border: 1px dashed rgba(244, 241, 232, 0.2);
		color: rgba(244, 241, 232, 0.68);
		text-align: center;
		padding: 24px;
	}

	.empty-state.compact {
		min-height: 120px;
	}

	.empty-state svg {
		width: 26px;
		height: 26px;
		color: #37c8d6;
	}

	a:focus-visible,
	button:focus-visible,
	summary:focus-visible {
		outline: 3px solid #37c8d6;
		outline-offset: 3px;
	}

	@keyframes pulse {
		0%,
		100% {
			box-shadow: 0 0 0 rgba(55, 200, 214, 0);
		}
		50% {
			box-shadow: 0 0 30px rgba(55, 200, 214, 0.34);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.radar-node.active {
			animation: none;
		}
	}

	@media (max-width: 960px) {
		.command-shell {
			padding: 14px;
		}

		.health-ribbon,
		.hero-grid,
		.lower-grid,
		.capacity-strip {
			grid-template-columns: 1fr;
		}

		.health-meta {
			align-items: flex-start;
		}

		.radar {
			min-height: 280px;
		}

		.capacity-strip {
			gap: 1px;
		}
	}

	@media (max-width: 620px) {
		.command-shell {
			padding: 12px 10px 84px;
		}

		h1 {
			font-size: 1.16rem;
		}

		.live-row summary,
		.timeline li {
			grid-template-columns: auto minmax(0, 1fr);
		}

		.status,
		.timeline time {
			grid-column: 2;
			justify-self: start;
		}

		.radar-legend,
		.action-grid {
			grid-template-columns: 1fr 1fr;
		}

		.row-detail {
			flex-direction: column;
			padding-left: 12px;
			overflow-wrap: anywhere;
		}

		.health-ribbon,
		.radar-panel,
		.live-panel,
		.timeline-panel,
		.operator-panel {
			padding: 14px;
		}
	}
</style>
