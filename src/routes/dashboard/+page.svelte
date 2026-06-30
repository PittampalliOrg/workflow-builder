<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import type { PageData } from './$types';
	import {
		Activity,
		AlertTriangle,
		OctagonAlert,
		CircleHelp,
		CircleCheck,
		CircleDot,
		Circle,
		LoaderCircle,
		Boxes,
		Coins,
		Cpu,
		Gauge,
		ChevronRight,
		Globe,
		Rocket,
		Workflow,
		MessageSquare,
		MessagesSquare,
		KeyRound,
		Bot,
		Layers,
		Sparkles,
		Plus,
		ExternalLink,
		Radio
	} from '@lucide/svelte';

	let { data }: { data: PageData } = $props();

	// Narrow the authed payload. When unauthenticated (the layout redirects
	// first, so this is defensive) we render nothing meaningful.
	const authed = data.authed === true;

	const displayName = $derived(
		(authed && data.user?.name?.split(' ')[0]) ||
			(authed && data.user?.email?.split('@')[0]) ||
			'operator'
	);

	const greeting = (() => {
		const h = new Date().getHours();
		if (h < 12) return 'Good morning';
		if (h < 18) return 'Good afternoon';
		return 'Good evening';
	})();

	// ---- Health presentation --------------------------------------------------
	const healthMeta = {
		healthy: { label: 'HEALTHY', icon: Activity, tone: 'ok' },
		degraded: { label: 'DEGRADED', icon: AlertTriangle, tone: 'warn' },
		critical: { label: 'CRITICAL', icon: OctagonAlert, tone: 'crit' },
		unknown: { label: 'UNKNOWN', icon: CircleHelp, tone: 'mute' }
	} as const;
	const health = $derived(authed ? data.health : null);
	const hMeta = $derived(health ? healthMeta[health.state] : healthMeta.unknown);

	// ---- Outcome badges (text + icon, never colour-only) ----------------------
	const outcomeMeta = {
		running: { icon: LoaderCircle, tone: 'info', label: 'running' },
		success: { icon: CircleCheck, tone: 'ok', label: 'ok' },
		error: { icon: OctagonAlert, tone: 'crit', label: 'error' },
		pending: { icon: CircleDot, tone: 'warn', label: 'pending' },
		info: { icon: Circle, tone: 'mute', label: '' }
	} as const;
	const kindIcon = { run: Workflow, session: MessageSquare, deploy: Rocket } as const;

	function relTime(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 45_000) return 'now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
		return `${Math.floor(diff / 86_400_000)}d`;
	}

	function fmt(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
		return `${n}`;
	}
	function fmtRate(n: number): string {
		return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`;
	}
	function cores(milli: number): string {
		return (milli / 1000).toFixed(milli >= 10_000 ? 0 : 1);
	}
	function gib(mib: number): string {
		return (mib / 1024).toFixed(1);
	}

	// ---- Live-now tiles -------------------------------------------------------
	const tiles = $derived(
		authed
			? [
					{
						key: 'sessions',
						n: data.liveNow.sessions,
						label: 'sessions',
						verb: 'running',
						icon: MessagesSquare,
						href: `/workspaces/${data.slug}/sessions`
					},
					{
						key: 'runs',
						n: data.liveNow.runs,
						label: 'runs',
						verb: 'in-flight',
						icon: Workflow,
						href: `/workspaces/${data.slug}/runs`
					},
					{
						key: 'previews',
						n: data.liveNow.previews,
						label: 'previews',
						verb: data.liveNow.previewsTotal > data.liveNow.previews
							? `live · ${data.liveNow.previewsTotal} total`
							: 'live',
						icon: Globe,
						href: `/workspaces/${data.slug}/dev`
					},
					{
						key: 'deploys',
						n: data.liveNow.deploys,
						label: 'deploys',
						verb: data.isAdmin ? 'rolling' : 'admin only',
						icon: Rocket,
						href: '/admin/gitops',
						muted: !data.isAdmin
					}
				]
			: []
	);

	// ---- Capacity bars --------------------------------------------------------
	const fleet = $derived(authed ? data.capacity.fleet : null);
	const fleetPct = $derived(
		fleet && fleet.desired > 0 ? Math.round((fleet.ready / fleet.desired) * 100) : null
	);
	// Resource pressure is shown as each class's share of the live total (no node
	// capacity is exposed by the API, so we never invent a "% of node" figure).
	const res = $derived(authed ? data.capacity.resources : null);
	const cpuMax = $derived(res ? Math.max(1, ...res.byClass.map((c) => c.cpuMillicores)) : 1);
	const memMax = $derived(res ? Math.max(1, ...res.byClass.map((c) => c.memoryMiB)) : 1);

	// =====================================================================
	// Signature: the System Pulse EKG ribbon, driven by real token rate.
	// =====================================================================
	const ratePerSec = $derived(authed ? data.pulse.ratePerSec : 0);

	// Build a heartbeat waveform whose amplitude/cadence reflect throughput.
	// One unit is drawn, then repeated, and the track scrolls by exactly one
	// unit width so the loop is seamless (transform-only → GPU cheap).
	const UNIT_W = 600;
	const MID = 24;
	function buildWave(rate: number): string {
		const energy = Math.max(0, Math.min(1, rate / 1500)); // 0..1 over 0..1.5k tok/s
		const amp = 6 + energy * 14;
		const beats = 3; // QRS complexes per unit
		const step = UNIT_W / beats;
		const pts: string[] = [];
		const push = (x: number, y: number) => pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
		push(0, MID);
		for (let b = 0; b < beats; b++) {
			const x0 = b * step;
			// calm baseline with faint ambient ripple
			push(x0 + step * 0.18, MID + Math.sin(b * 1.7) * 1.5);
			push(x0 + step * 0.34, MID - 1);
			// P wave
            push(x0 + step * 0.42, MID - amp * 0.18);
			push(x0 + step * 0.48, MID);
			// QRS spike
			push(x0 + step * 0.52, MID + amp * 0.35);
			push(x0 + step * 0.56, MID - amp);
			push(x0 + step * 0.6, MID + amp * 0.5);
			push(x0 + step * 0.64, MID);
			// T wave
			push(x0 + step * 0.76, MID - amp * 0.22);
			push(x0 + step * 0.86, MID);
		}
		push(UNIT_W, MID);
		return pts.join(' ');
	}
	const wave = $derived(buildWave(ratePerSec));

	// Scroll speed scales with throughput: busier platform → faster heartbeat.
	const beatDuration = $derived(
		ratePerSec <= 0 ? 0 : Math.max(1.1, 4.2 - Math.min(1500, ratePerSec) / 470)
	);

	let reduceMotion = $state(false);
	let tabHidden = $state(false);
	let now = $state(Date.now());

	onMount(() => {
		const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
		reduceMotion = mq.matches;
		const onMq = () => (reduceMotion = mq.matches);
		mq.addEventListener?.('change', onMq);

		const onVis = () => {
			tabHidden = document.hidden;
			// Catch up the moment the operator returns to the tab.
			if (!document.hidden) refresh();
		};
		document.addEventListener('visibilitychange', onVis);

		// Keep relative timestamps honest without a full reload.
		const t = setInterval(() => (now = Date.now()), 10_000);

		// Live refresh: re-run ONLY this page's server load (depends key
		// 'cc:dashboard') so every count, the activity feed, the health verdict
		// and the throughput readout stay current. Paused while the tab is
		// hidden and guarded against overlapping in-flight refreshes.
		let refreshing = false;
		const refresh = async () => {
			if (document.hidden || refreshing) return;
			refreshing = true;
			try {
				await invalidate('cc:dashboard');
			} catch {
				/* transient — the next tick retries */
			} finally {
				refreshing = false;
			}
		};
		const r = setInterval(refresh, 20_000);

		return () => {
			mq.removeEventListener?.('change', onMq);
			document.removeEventListener('visibilitychange', onVis);
			clearInterval(t);
			clearInterval(r);
		};
	});

	// Freshness: 'generatedAt' changes on every successful refresh; re-derive
	// against the 10s clock tick so the label reads as genuinely live.
	const freshLabel = $derived(authed ? (now, relTime(data.generatedAt)) : '');

	const animate = $derived(!reduceMotion && !tabHidden && beatDuration > 0);
	// reference `now` so timestamps re-derive on the interval tick
	const activity = $derived(authed ? (now, data.activity) : []);

	const actions = $derived(
		authed
			? {
					createAgent: `/workspaces/${data.slug}/agents/new`,
					quickstart: `/workspaces/${data.slug}/agents/quickstart`,
					newSession: `/workspaces/${data.slug}/sessions/new`,
					newEnv: `/workspaces/${data.slug}/environments/new`,
					vault: `/workspaces/${data.slug}/credentials`,
					apiKey: `/workspaces/${data.slug}/settings/keys`,
					prompt: '/workbench'
				}
			: null
	);
</script>

<svelte:head>
	<link
		href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap"
		rel="stylesheet"
	/>
</svelte:head>

{#if !authed}
	<div class="cc cc-empty">
		<p>Sign in to view the command center.</p>
	</div>
{:else if actions}
	<div class="cc cc-state-{health?.state}" class:cc-animate={animate}>
	<div class="cc-inner">
		<!-- ======================== SIGNATURE: SYSTEM PULSE ===================== -->
		<section class="pulse" aria-label="System health and live throughput">
			<div class="pulse-id">
				<span class="orb" data-tone={hMeta.tone} aria-hidden="true">
					<span class="orb-core"></span>
					<span class="orb-sweep"></span>
				</span>
				<div class="pulse-verdict">
					<div class="pulse-kicker">
						<Radio class="ic" size={13} /> SYSTEM PULSE
						<span
							class="live"
							class:live-paused={tabHidden}
							title={tabHidden ? 'Live updates paused while hidden' : 'Auto-refreshing every 20s'}
						>
							<span class="live-dot" aria-hidden="true"></span>{tabHidden ? 'paused' : 'live'}
						</span>
					</div>
					<div class="pulse-state">
						<hMeta.icon size={20} strokeWidth={2.4} />
						<span>{hMeta.label}</span>
					</div>
				</div>
			</div>

			<div class="ribbon" aria-hidden="true">
				<div class="ribbon-track" style="--dur:{beatDuration}s">
					<svg viewBox="0 0 {UNIT_W} {MID * 2}" preserveAspectRatio="none" class="ribbon-svg">
						<polyline points={wave} />
					</svg>
					<svg viewBox="0 0 {UNIT_W} {MID * 2}" preserveAspectRatio="none" class="ribbon-svg">
						<polyline points={wave} />
					</svg>
				</div>
				<div class="ribbon-fade"></div>
			</div>

			<div class="pulse-readout">
				<div class="ro-main">
					<span class="ro-num">{fmtRate(ratePerSec)}</span>
					<span class="ro-unit">tok/s</span>
				</div>
				<div class="ro-reason">{health?.reason}</div>
				<div class="ro-fresh">updated {freshLabel}{freshLabel === 'now' ? '' : ' ago'}</div>
			</div>
		</section>

		<!-- ============================ RUNNING NOW ============================= -->
		<section class="now" aria-label="Running right now">
			<header class="seg-head">
				<h2>Running now</h2>
				<span class="seg-sub">{greeting}, {displayName}</span>
			</header>
			<div class="tiles">
				{#each tiles as t (t.key)}
					<a class="tile" class:tile-zero={t.n === 0} class:tile-muted={t.muted} href={t.href}>
						<div class="tile-top">
							<t.icon size={16} class="tile-ic" />
							<ChevronRight size={14} class="tile-go" />
						</div>
						<div class="tile-n">{t.n}</div>
						<div class="tile-lab">
							<span class="tile-label">{t.label}</span>
							<span class="tile-verb">{t.verb}</span>
						</div>
					</a>
				{/each}
			</div>
		</section>

		<!-- ===================== ACTIVITY + CAPACITY (split) ==================== -->
		<div class="split">
			<!-- ------------------------------ ACTIVITY ------------------------- -->
			<section class="card activity" aria-label="Recent activity">
				<header class="card-head">
					<h2><Activity size={15} class="hd-ic" /> Activity</h2>
					<a class="link" href={`/workspaces/${data.slug}/runs`}>
						all runs <ExternalLink size={12} />
					</a>
				</header>

				{#if activity.length === 0}
					<div class="empty">
						<p>No recent runs, sessions, or deploys.</p>
						<a class="link" href={actions.newSession}>Start a session</a>
					</div>
				{:else}
					<ul class="feed">
						{#each activity.slice(0, 6) as row (row.id)}
							{@const om = outcomeMeta[row.outcome]}
							{@const KIcon = kindIcon[row.kind]}
							<li>
								<a class="feed-row" href={row.href}>
									<span class="feed-kind" data-kind={row.kind} aria-hidden="true">
										<KIcon size={14} />
									</span>
									<span class="feed-body">
										<span class="feed-name">{row.name}</span>
										{#if row.sub}<span class="feed-sub">{row.sub}</span>{/if}
									</span>
									<span class="badge" data-tone={om.tone}>
										<om.icon size={12} class={row.outcome === 'running' ? 'spin' : ''} />
										<span>{row.statusLabel}</span>
									</span>
									<time class="feed-time">{relTime(row.ts)}</time>
								</a>
							</li>
						{/each}
					</ul>

					{#if activity.length > 6}
						<details class="more">
							<summary>
								<ChevronRight size={14} class="chev" />
								{activity.length - 6} more
							</summary>
							<ul class="feed">
								{#each activity.slice(6) as row (row.id)}
									{@const om = outcomeMeta[row.outcome]}
									{@const KIcon = kindIcon[row.kind]}
									<li>
										<a class="feed-row" href={row.href}>
											<span class="feed-kind" data-kind={row.kind} aria-hidden="true">
												<KIcon size={14} />
											</span>
											<span class="feed-body">
												<span class="feed-name">{row.name}</span>
												{#if row.sub}<span class="feed-sub">{row.sub}</span>{/if}
											</span>
											<span class="badge" data-tone={om.tone}>
												<om.icon size={12} />
												<span>{row.statusLabel}</span>
											</span>
											<time class="feed-time">{relTime(row.ts)}</time>
										</a>
									</li>
								{/each}
							</ul>
						</details>
					{/if}
				{/if}
			</section>

			<!-- ----------------------------- CAPACITY -------------------------- -->
			<section class="card capacity" aria-label="Capacity and usage">
				<header class="card-head">
					<h2><Gauge size={15} class="hd-ic" /> Capacity &amp; usage</h2>
					<a class="link" href={`/workspaces/${data.slug}/capacity`}>
						fleet <ExternalLink size={12} />
					</a>
				</header>

				<!-- Fleet readiness -->
				<div class="metric">
					<div class="metric-top">
						<span class="m-label"><Boxes size={13} /> Fleet</span>
						{#if fleet}
							<span class="m-val">{fleet.ready}/{fleet.desired} ready</span>
						{:else}
							<span class="m-val m-na">no warm pools</span>
						{/if}
					</div>
					{#if fleet}
						<div class="bar"><span class="bar-fill ok" style="width:{fleetPct}%"></span></div>
					{/if}
				</div>

				<!-- Throughput -->
				<div class="metric">
					<div class="metric-top">
						<span class="m-label"><Activity size={13} /> Throughput</span>
						<span class="m-val">{fmtRate(data.capacity.ratePerSec)} tok/s</span>
					</div>
					<div class="m-foot">{fmt(data.capacity.tokensLastHour)} tokens · last hour</div>
				</div>

				<!-- Tokens + spend (7d) -->
				<div class="metric">
					<div class="metric-top">
						<span class="m-label"><Coins size={13} /> 7-day usage</span>
						<span class="m-val">
							{data.capacity.cost7d !== null
								? `$${data.capacity.cost7d.toFixed(2)}`
								: '—'}
						</span>
					</div>
					<div class="m-foot">{fmt(data.capacity.tokens7d)} tokens across 7 days</div>
				</div>

				<!-- Resource pressure -->
				<div class="metric">
					<div class="metric-top">
						<span class="m-label"><Cpu size={13} /> Resource pressure</span>
						{#if res}
							<span class="m-val">{cores(res.cpuMillicores)} cores · {gib(res.memoryMiB)} GiB</span>
						{:else}
							<span class="m-val m-na">metrics unavailable</span>
						{/if}
					</div>
					{#if res}
						<div class="m-foot">{res.podCount} pods reporting</div>
						<details class="more">
							<summary><ChevronRight size={14} class="chev" /> by class</summary>
							<ul class="classlist">
								{#each res.byClass as c (c.name)}
									<li>
										<div class="cl-top">
											<span class="cl-name">{c.name}</span>
											<span class="cl-meta">{cores(c.cpuMillicores)}c · {gib(c.memoryMiB)}G · {c.count}p</span>
										</div>
										<div class="bar bar-sm">
											<span class="bar-fill cpu" style="width:{(c.cpuMillicores / cpuMax) * 100}%"></span>
										</div>
										<div class="bar bar-sm">
											<span class="bar-fill mem" style="width:{(c.memoryMiB / memMax) * 100}%"></span>
										</div>
									</li>
								{/each}
							</ul>
						</details>
					{:else}
						<div class="m-foot">metrics-server not reachable — counts above still live.</div>
					{/if}
				</div>
			</section>
		</div>

		<!-- ============================ QUICK ACTIONS =========================== -->
		<nav class="actions" aria-label="Quick actions">
			<a class="qa" href={actions.quickstart}><Sparkles size={14} /> Get started</a>
			<a class="qa" href={actions.createAgent}><Bot size={14} /> New agent</a>
			<a class="qa" href={actions.newSession}><MessagesSquare size={14} /> New session</a>
			<a class="qa" href={actions.newEnv}><Layers size={14} /> Define environment</a>
			<a class="qa" href={actions.vault}><KeyRound size={14} /> Add vault</a>
			<a class="qa" href={actions.prompt}><MessageSquare size={14} /> Generate a prompt</a>
			<a class="qa" href={actions.apiKey}><Plus size={14} /> Get API key</a>
		</nav>
	</div>
	</div>
{/if}

<style>
	/* ============================ DESIGN TOKENS ===========================
	 * Self-contained obsidian console — deliberately independent of the app's
	 * light/dark theme so the command center reads as one distinct surface.
	 * 4px spacing base · three type roles · pulse-green focus ring. */
	.cc {
		--obsidian: #0b0f16;
		--panel: #161e29;
		--panel-2: #1c2733;
		--pulse: #c6f135;
		--amber: #f5a524;
		--crit: #ff5d5d;
		--mist: #8a97a6;
		--fg: #e6edf3;
		--hair: rgba(138, 151, 166, 0.16);
		--hair-strong: rgba(138, 151, 166, 0.28);
		--focus: var(--pulse);

		--f-display: 'Space Grotesk', system-ui, sans-serif;
		--f-body: 'Inter', system-ui, sans-serif;
		--f-mono: 'JetBrains Mono', ui-monospace, monospace;

		--s1: 4px;
		--s2: 8px;
		--s3: 12px;
		--s4: 16px;
		--s5: 24px;
		--s6: 32px;

		height: 100%;
		overflow-y: auto;
		box-sizing: border-box;
		width: 100%;
		background:
			radial-gradient(1100px 460px at 15% -12%, rgba(198, 241, 53, 0.06), transparent 60%),
			var(--obsidian);
		color: var(--fg);
		font-family: var(--f-body);
		font-size: 14px;
		line-height: 1.45;
	}
	.cc * {
		box-sizing: border-box;
	}
	.cc-inner {
		display: flex;
		flex-direction: column;
		gap: var(--s4);
		max-width: 1180px;
		margin: 0 auto;
		width: 100%;
		padding: var(--s5);
	}
	.cc-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--mist);
		padding: var(--s6);
	}

	.cc :global(.ic) {
		opacity: 0.8;
	}

	/* keyboard focus — visible on every interactive element */
	.cc a:focus-visible,
	.cc summary:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
		border-radius: 8px;
	}

	/* ============================= SYSTEM PULSE ========================== */
	.pulse {
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: center;
		gap: var(--s5);
		padding: var(--s4) var(--s5);
		border: 1px solid var(--hair-strong);
		border-radius: 16px;
		background: linear-gradient(180deg, var(--panel) 0%, #121925 100%);
		box-shadow:
			0 1px 0 rgba(255, 255, 255, 0.03) inset,
			0 18px 40px -28px rgba(0, 0, 0, 0.9);
		position: relative;
		overflow: hidden;
	}
	/* state accent hairline on the left edge */
	.pulse::before {
		content: '';
		position: absolute;
		inset: 0 auto 0 0;
		width: 3px;
		background: var(--tone, var(--pulse));
	}
	.cc-state-healthy {
		--tone: var(--pulse);
	}
	.cc-state-degraded {
		--tone: var(--amber);
	}
	.cc-state-critical {
		--tone: var(--crit);
	}
	.cc-state-unknown {
		--tone: var(--mist);
	}

	.pulse-id {
		display: flex;
		align-items: center;
		gap: var(--s4);
	}
	.orb {
		position: relative;
		width: 40px;
		height: 40px;
		display: grid;
		place-items: center;
		flex: none;
	}
	.orb-core {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--tone);
		box-shadow: 0 0 14px 2px color-mix(in srgb, var(--tone) 70%, transparent);
		z-index: 1;
	}
	.orb-sweep {
		position: absolute;
		inset: 0;
		border-radius: 50%;
		border: 1.5px solid color-mix(in srgb, var(--tone) 55%, transparent);
		opacity: 0.6;
	}
	.cc-animate .orb-sweep {
		animation: radar 2.6s ease-out infinite;
	}
	.cc-animate.cc-state-critical .orb-sweep {
		animation-duration: 1.1s;
	}
	@keyframes radar {
		0% {
			transform: scale(0.5);
			opacity: 0.7;
		}
		100% {
			transform: scale(1.6);
			opacity: 0;
		}
	}
	.pulse-kicker {
		display: flex;
		align-items: center;
		gap: 6px;
		font-family: var(--f-mono);
		font-size: 10px;
		letter-spacing: 0.16em;
		color: var(--mist);
		text-transform: uppercase;
	}
	.pulse-state {
		display: flex;
		align-items: center;
		gap: var(--s2);
		font-family: var(--f-display);
		font-weight: 700;
		font-size: 22px;
		letter-spacing: -0.01em;
		color: var(--tone);
		margin-top: 2px;
	}

	/* live freshness affordance — honest "this console is auto-refreshing" cue */
	.live {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		margin-left: 4px;
		padding: 1px 7px 1px 6px;
		border-radius: 999px;
		border: 1px solid rgba(198, 241, 53, 0.28);
		background: rgba(198, 241, 53, 0.09);
		color: var(--pulse);
		font-size: 9px;
		letter-spacing: 0.14em;
	}
	.live-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--pulse);
		box-shadow: 0 0 6px 1px color-mix(in srgb, var(--pulse) 70%, transparent);
	}
	.cc-animate .live-dot {
		animation: livepulse 1.8s ease-in-out infinite;
	}
	@keyframes livepulse {
		0%,
		100% {
			opacity: 1;
			transform: scale(1);
		}
		50% {
			opacity: 0.35;
			transform: scale(0.65);
		}
	}
	.live-paused {
		border-color: var(--hair);
		background: rgba(138, 151, 166, 0.1);
		color: var(--mist);
	}
	.live-paused .live-dot {
		background: var(--mist);
		box-shadow: none;
		animation: none;
	}
	.ro-fresh {
		font-family: var(--f-mono);
		font-size: 10px;
		color: var(--mist);
		opacity: 0.7;
		margin-top: 4px;
		letter-spacing: 0.02em;
	}

	.ribbon {
		position: relative;
		height: 48px;
		min-width: 0;
		overflow: hidden;
		mask-image: linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent);
	}
	.ribbon-track {
		display: flex;
		width: 200%;
		height: 100%;
	}
	.cc-animate .ribbon-track {
		animation: scroll var(--dur, 3s) linear infinite;
	}
	@keyframes scroll {
		from {
			transform: translateX(0);
		}
		to {
			transform: translateX(-50%);
		}
	}
	.ribbon-svg {
		width: 50%;
		height: 100%;
		flex: none;
	}
	.ribbon-svg polyline {
		fill: none;
		stroke: var(--tone, var(--pulse));
		stroke-width: 1.6;
		stroke-linejoin: round;
		stroke-linecap: round;
		filter: drop-shadow(0 0 5px color-mix(in srgb, var(--tone) 55%, transparent));
		vector-effect: non-scaling-stroke;
	}

	.pulse-readout {
		text-align: right;
		min-width: 168px;
		max-width: 280px;
	}
	.ro-main {
		display: flex;
		align-items: baseline;
		justify-content: flex-end;
		gap: 5px;
		font-family: var(--f-mono);
	}
	.ro-num {
		font-size: 26px;
		font-weight: 600;
		color: var(--fg);
		font-variant-numeric: tabular-nums;
	}
	.ro-unit {
		font-size: 11px;
		color: var(--mist);
	}
	.ro-reason {
		font-size: 12px;
		color: var(--mist);
		margin-top: 3px;
		line-height: 1.35;
	}

	/* =============================== HEADINGS =========================== */
	.seg-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--s3);
	}
	.seg-head h2 {
		font-family: var(--f-display);
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--mist);
		margin: 0;
	}
	.seg-sub {
		font-size: 12px;
		color: var(--mist);
	}

	/* ============================== LIVE TILES ========================== */
	.tiles {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: var(--s3);
	}
	.tile {
		display: flex;
		flex-direction: column;
		gap: var(--s2);
		padding: var(--s4);
		border: 1px solid var(--hair);
		border-radius: 14px;
		background: var(--panel);
		text-decoration: none;
		color: inherit;
		transition:
			border-color 0.16s ease,
			transform 0.16s ease,
			background 0.16s ease;
		position: relative;
	}
	.tile:hover {
		border-color: var(--hair-strong);
		transform: translateY(-2px);
		background: var(--panel-2);
	}
	.tile-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		color: var(--mist);
	}
	.tile :global(.tile-ic) {
		color: var(--pulse);
	}
	.tile :global(.tile-go) {
		opacity: 0;
		transition: opacity 0.16s ease;
	}
	.tile:hover :global(.tile-go) {
		opacity: 0.7;
	}
	.tile-n {
		font-family: var(--f-display);
		font-size: 40px;
		font-weight: 700;
		line-height: 1;
		letter-spacing: -0.03em;
		font-variant-numeric: tabular-nums;
	}
	.tile-zero .tile-n {
		color: var(--mist);
		opacity: 0.55;
	}
	.tile-muted {
		opacity: 0.7;
	}
	.tile-lab {
		display: flex;
		flex-direction: column;
	}
	.tile-label {
		font-size: 13px;
		font-weight: 600;
	}
	.tile-verb {
		font-family: var(--f-mono);
		font-size: 10.5px;
		color: var(--mist);
		letter-spacing: 0.02em;
	}

	/* ============================ SPLIT REGION ========================== */
	.split {
		display: grid;
		grid-template-columns: 1.55fr 1fr;
		gap: var(--s4);
		align-items: start;
	}
	.card {
		border: 1px solid var(--hair);
		border-radius: 16px;
		background: var(--panel);
		padding: var(--s4);
		display: flex;
		flex-direction: column;
		gap: var(--s3);
	}
	.card-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s3);
	}
	.card-head h2 {
		display: flex;
		align-items: center;
		gap: var(--s2);
		font-family: var(--f-display);
		font-size: 14px;
		font-weight: 600;
		margin: 0;
	}
	.card-head :global(.hd-ic) {
		color: var(--pulse);
	}
	.link {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-family: var(--f-mono);
		font-size: 11px;
		color: var(--mist);
		text-decoration: none;
		text-transform: lowercase;
		letter-spacing: 0.03em;
	}
	.link:hover {
		color: var(--pulse);
	}

	/* ============================== FEED =============================== */
	.feed {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	.feed li + li .feed-row {
		border-top: 1px solid var(--hair);
	}
	.feed-row {
		display: grid;
		grid-template-columns: auto 1fr auto auto;
		align-items: center;
		gap: var(--s3);
		padding: 9px var(--s2);
		text-decoration: none;
		color: inherit;
		border-radius: 8px;
	}
	.feed-row:hover {
		background: var(--panel-2);
	}
	.feed-kind {
		width: 26px;
		height: 26px;
		border-radius: 7px;
		display: grid;
		place-items: center;
		background: rgba(255, 255, 255, 0.04);
		color: var(--mist);
		flex: none;
	}
	.feed-kind[data-kind='run'] {
		color: var(--pulse);
	}
	.feed-kind[data-kind='session'] {
		color: #7cc7ff;
	}
	.feed-kind[data-kind='deploy'] {
		color: var(--amber);
	}
	.feed-body {
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.feed-name {
		font-size: 13px;
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.feed-sub {
		font-size: 11px;
		color: var(--mist);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.feed-time {
		font-family: var(--f-mono);
		font-size: 11px;
		color: var(--mist);
		font-variant-numeric: tabular-nums;
		min-width: 26px;
		text-align: right;
	}

	/* ============================== BADGES ============================= */
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 7px;
		border-radius: 999px;
		font-family: var(--f-mono);
		font-size: 10.5px;
		font-weight: 500;
		letter-spacing: 0.01em;
		border: 1px solid transparent;
		white-space: nowrap;
	}
	.badge[data-tone='ok'] {
		color: var(--pulse);
		background: rgba(198, 241, 53, 0.1);
		border-color: rgba(198, 241, 53, 0.25);
	}
	.badge[data-tone='warn'] {
		color: var(--amber);
		background: rgba(245, 165, 36, 0.1);
		border-color: rgba(245, 165, 36, 0.25);
	}
	.badge[data-tone='crit'] {
		color: var(--crit);
		background: rgba(255, 93, 93, 0.12);
		border-color: rgba(255, 93, 93, 0.3);
	}
	.badge[data-tone='info'] {
		color: #7cc7ff;
		background: rgba(124, 199, 255, 0.1);
		border-color: rgba(124, 199, 255, 0.25);
	}
	.badge[data-tone='mute'] {
		color: var(--mist);
		background: rgba(138, 151, 166, 0.1);
		border-color: var(--hair);
	}
	.cc :global(.spin) {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* ========================= PROGRESSIVE DISCLOSURE =================== */
	.more {
		margin-top: 2px;
	}
	.more summary {
		display: flex;
		align-items: center;
		gap: 5px;
		cursor: pointer;
		list-style: none;
		font-family: var(--f-mono);
		font-size: 11px;
		color: var(--mist);
		padding: 6px var(--s2);
		border-radius: 8px;
		user-select: none;
	}
	.more summary::-webkit-details-marker {
		display: none;
	}
	.more summary:hover {
		color: var(--fg);
	}
	.more :global(.chev) {
		transition: transform 0.18s ease;
	}
	.more[open] summary :global(.chev) {
		transform: rotate(90deg);
	}

	/* ============================== CAPACITY =========================== */
	.metric {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding-bottom: var(--s3);
		border-bottom: 1px solid var(--hair);
	}
	.metric:last-child {
		border-bottom: none;
		padding-bottom: 0;
	}
	.metric-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s2);
	}
	.m-label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--mist);
	}
	.m-val {
		font-family: var(--f-mono);
		font-size: 13px;
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}
	.m-na {
		color: var(--mist);
		opacity: 0.7;
		font-size: 11px;
	}
	.m-foot {
		font-size: 11px;
		color: var(--mist);
		font-family: var(--f-mono);
	}
	.bar {
		height: 6px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.06);
		overflow: hidden;
	}
	.bar-sm {
		height: 4px;
		margin-top: 3px;
	}
	.bar-fill {
		display: block;
		height: 100%;
		border-radius: 999px;
		background: var(--pulse);
	}
	.bar-fill.ok {
		background: linear-gradient(90deg, var(--pulse), #9fd320);
	}
	.bar-fill.cpu {
		background: var(--pulse);
	}
	.bar-fill.mem {
		background: #7cc7ff;
	}
	.classlist {
		list-style: none;
		margin: var(--s2) 0 0;
		padding: 0 var(--s2);
		display: flex;
		flex-direction: column;
		gap: var(--s3);
	}
	.cl-top {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--s2);
	}
	.cl-name {
		font-size: 12px;
		font-weight: 500;
	}
	.cl-meta {
		font-family: var(--f-mono);
		font-size: 10.5px;
		color: var(--mist);
	}

	/* =============================== EMPTY ============================= */
	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--s2);
		padding: var(--s6) var(--s4);
		color: var(--mist);
		text-align: center;
	}
	.empty p {
		margin: 0;
		font-size: 13px;
	}

	/* ============================ QUICK ACTIONS ======================== */
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s2);
		padding-top: var(--s2);
	}
	.qa {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 8px var(--s3);
		border: 1px solid var(--hair);
		border-radius: 10px;
		background: var(--panel);
		color: var(--fg);
		text-decoration: none;
		font-size: 12.5px;
		font-weight: 500;
		transition:
			border-color 0.16s ease,
			background 0.16s ease;
	}
	.qa:hover {
		border-color: var(--pulse);
		background: var(--panel-2);
	}
	.qa :global(svg) {
		color: var(--mist);
	}
	.qa:hover :global(svg) {
		color: var(--pulse);
	}

	/* ============================ RESPONSIVE =========================== */
	@media (max-width: 880px) {
		.pulse {
			grid-template-columns: 1fr;
			gap: var(--s3);
		}
		.pulse-readout {
			text-align: left;
			max-width: none;
		}
		.ro-main {
			justify-content: flex-start;
		}
		.ribbon {
			order: 3;
			height: 40px;
		}
		.split {
			grid-template-columns: 1fr;
		}
		.tiles {
			grid-template-columns: repeat(2, 1fr);
		}
	}
	@media (max-width: 460px) {
		.cc-inner {
			padding: var(--s4);
		}
		.tile-n {
			font-size: 32px;
		}
	}

	/* prefers-reduced-motion: still the heartbeat + radar entirely */
	@media (prefers-reduced-motion: reduce) {
		.cc :global(*) {
			animation: none !important;
			transition: none !important;
		}
	}
</style>
