<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// ---- formatting helpers -------------------------------------------------
	function relative(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		if (Number.isNaN(diff)) return '';
		if (diff < 0) return 'now';
		if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
		return `${Math.floor(diff / 86_400_000)}d`;
	}
	function compact(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
		return `${Math.round(n)}`;
	}
	function money(n: number): string {
		if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
		if (n >= 1) return `$${n.toFixed(2)}`;
		if (n > 0) return `$${n.toFixed(3)}`;
		return '$0.00';
	}

	// outcome → shape glyph + label class (status is NEVER color-only)
	const OUTCOME: Record<
		string,
		{ glyph: string; tone: string; sr: string }
	> = {
		ok: { glyph: '✓', tone: 'pulse', sr: 'success' },
		synced: { glyph: '⟲', tone: 'pulse', sr: 'synced' },
		running: { glyph: '●', tone: 'solar', sr: 'in progress' },
		warn: { glyph: '▲', tone: 'solar', sr: 'warning' },
		error: { glyph: '✕', tone: 'flare', sr: 'error' },
		neutral: { glyph: '◇', tone: 'mist', sr: 'info' }
	};
	const HEALTH: Record<
		string,
		{ label: string; tone: string; glyph: string }
	> = {
		operational: { label: 'ALL SYSTEMS OPERATIONAL', tone: 'pulse', glyph: '●' },
		degraded: { label: 'DEGRADED', tone: 'solar', glyph: '▲' },
		critical: { label: 'CRITICAL', tone: 'flare', glyph: '✕' },
		unknown: { label: 'AWAITING SIGNAL', tone: 'mist', glyph: '◇' }
	};
	const KIND_LABEL: Record<string, string> = {
		run: 'RUN',
		session: 'SESSION',
		deploy: 'DEPLOY',
		publish: 'PUBLISH'
	};

	let verdict = $derived(HEALTH[data.health.overall] ?? HEALTH.unknown);
	let counts = $derived(data.runningNow.counts);
	let nothingLive = $derived(
		counts.sessions === 0 &&
			counts.runs === 0 &&
			counts.previews === 0 &&
			counts.deploys === 0
	);

	// ---- live refresh: re-run the server load on an interval ----------------
	let updatedAt = $state(Date.now());
	let tick = $state(0);
	let refreshing = $state(false);
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let clockTimer: ReturnType<typeof setInterval> | null = null;

	async function refresh() {
		if (typeof document !== 'undefined' && document.hidden) return;
		refreshing = true;
		await invalidateAll();
		updatedAt = Date.now();
		refreshing = false;
	}

	// ---- signature: system pulse ribbon (canvas oscilloscope) ---------------
	let canvas = $state<HTMLCanvasElement | null>(null);
	let reduced = $state(false);
	let raf = 0;

	// live params read by the draw loop (kept current via $effect)
	const params = { throughput: 0, rate: 0, spark: [] as number[] };
	$effect(() => {
		params.throughput = data.ribbon.throughput;
		params.rate = data.ribbon.tokensOutPerMin;
		params.spark = data.ribbon.spark ?? [];
		if (reduced) drawStatic();
	});

	function sizeCanvas(c: HTMLCanvasElement) {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const r = c.getBoundingClientRect();
		c.width = Math.max(1, Math.floor(r.width * dpr));
		c.height = Math.max(1, Math.floor(r.height * dpr));
		const ctx = c.getContext('2d');
		if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		return { w: r.width, h: r.height };
	}

	function drawStatic() {
		const c = canvas;
		if (!c) return;
		const { w, h } = sizeCanvas(c);
		const ctx = c.getContext('2d');
		if (!ctx) return;
		ctx.clearRect(0, 0, w, h);
		const mid = h / 2;
		const pts = params.spark.length ? params.spark : [0, 0, 0, 0, 0, 0, 0];
		const max = Math.max(1, ...pts);
		ctx.lineWidth = 2;
		ctx.strokeStyle = '#2EE6A6';
		ctx.beginPath();
		pts.forEach((v, i) => {
			const x = (i / Math.max(1, pts.length - 1)) * w;
			const y = h - 6 - (v / max) * (h - 12);
			i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
		});
		ctx.stroke();
		// baseline
		ctx.strokeStyle = 'rgba(147,161,179,0.18)';
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(0, mid);
		ctx.lineTo(w, mid);
		ctx.stroke();
	}

	function startWave() {
		const c = canvas;
		if (!c) return;
		let t = 0;
		let lastW = 0;
		let lastH = 0;
		const loop = () => {
			if (typeof document !== 'undefined' && document.hidden) {
				raf = requestAnimationFrame(loop);
				return;
			}
			const ctx = c.getContext('2d');
			const r = c.getBoundingClientRect();
			if (r.width !== lastW || r.height !== lastH) {
				const s = sizeCanvas(c);
				lastW = s.w;
				lastH = s.h;
			}
			const w = lastW || r.width;
			const h = lastH || r.height;
			if (!ctx) {
				raf = requestAnimationFrame(loop);
				return;
			}
			ctx.clearRect(0, 0, w, h);
			const mid = h / 2;
			// baseline grid
			ctx.strokeStyle = 'rgba(147,161,179,0.12)';
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(0, mid);
			ctx.lineTo(w, mid);
			ctx.stroke();

			// amplitude grows with concurrent throughput; freq nudged by token rate
			const tp = params.throughput;
			const amp = Math.min(h * 0.4, 3 + Math.log2(1 + tp) * (h * 0.12));
			const baseFreq = 0.9 + Math.min(2.4, Math.log10(1 + params.rate) * 0.9);
			const speed = 0.05 + Math.min(0.12, tp * 0.004);
			t += speed;

			// draw waveform twice: soft glow + crisp line
			const drawPath = () => {
				ctx.beginPath();
				for (let x = 0; x <= w; x += 2) {
					const px = x / w;
					const env = Math.sin(px * Math.PI); // taper at edges
					const y =
						mid -
						Math.sin(px * Math.PI * 2 * baseFreq + t) *
							amp *
							env *
							(0.55 + 0.45 * Math.sin(t * 0.7 + px * 6));
					x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
				}
			};
			ctx.shadowColor = 'rgba(46,230,166,0.55)';
			ctx.shadowBlur = 12;
			ctx.strokeStyle = 'rgba(46,230,166,0.9)';
			ctx.lineWidth = 2;
			drawPath();
			ctx.stroke();
			ctx.shadowBlur = 0;
			ctx.strokeStyle = 'rgba(190,255,232,0.9)';
			ctx.lineWidth = 1;
			drawPath();
			ctx.stroke();

			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
	}

	onMount(() => {
		const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
		reduced = mq.matches;
		const onMq = () => {
			reduced = mq.matches;
			cancelAnimationFrame(raf);
			if (reduced) drawStatic();
			else startWave();
		};
		mq.addEventListener?.('change', onMq);

		if (reduced) drawStatic();
		else startWave();

		const onResize = () => {
			if (reduced) drawStatic();
		};
		window.addEventListener('resize', onResize);

		pollTimer = setInterval(refresh, 15_000);
		clockTimer = setInterval(() => (tick = Date.now()), 1000);

		return () => {
			mq.removeEventListener?.('change', onMq);
			window.removeEventListener('resize', onResize);
		};
	});

	onDestroy(() => {
		// onDestroy ALSO runs during SSR in Svelte 5 — cancelAnimationFrame is a
		// browser-only global, so guard it or the server render throws (→ 500).
		if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(raf);
		if (pollTimer) clearInterval(pollTimer);
		if (clockTimer) clearInterval(clockTimer);
	});

	// re-read tick so relative timestamps refresh every second
	let secondsAgo = $derived(Math.max(0, Math.round((tick - updatedAt) / 1000)) || 0);

	let trendMax = $derived(Math.max(1, ...data.capacity.tokenTrend));
</script>

<svelte:head><title>Command Center · Managed Agents</title></svelte:head>

<div class="cc" class:cc-reduced={reduced}>
	<!-- ================= HERO: signature pulse ribbon ================= -->
	<header class="hero">
		<div class="hero-top">
			<div class="hero-id">
				<span class="brand">COMMAND&nbsp;CENTER</span>
				<span class="live-chip tone-{verdict.tone}" aria-live="polite">
					<span class="live-dot" aria-hidden="true"></span>
					LIVE
				</span>
				<span class="verdict tone-{verdict.tone}">
					<span class="glyph" aria-hidden="true">{verdict.glyph}</span>
					{verdict.label}
				</span>
			</div>
			<div class="hero-meta mono">
				<span class:pulsing={refreshing}>updated {secondsAgo}s ago</span>
				<button class="refresh" onclick={refresh} aria-label="Refresh now">↻</button>
			</div>
		</div>

		<div class="ribbon" role="img"
			aria-label="System pulse: {counts.sessions} sessions and {counts.runs} runs driving live throughput">
			<canvas bind:this={canvas}></canvas>
			<div class="ribbon-fade"></div>
		</div>

		<!-- vitals: highest-signal summary, leads the page -->
		<dl class="vitals mono">
			<div class="vital"><dt>running</dt><dd class="tone-pulse">{counts.sessions}</dd></div>
			<span class="sep" aria-hidden="true">·</span>
			<div class="vital"><dt>in-flight</dt><dd class="tone-solar">{counts.runs}</dd></div>
			<span class="sep" aria-hidden="true">·</span>
			<div class="vital"><dt>previews</dt><dd>{counts.previews}</dd></div>
			<span class="sep" aria-hidden="true">·</span>
			<div class="vital"><dt>deploys</dt><dd>{counts.deploys}</dd></div>
			<span class="sep" aria-hidden="true">·</span>
			<div class="vital"><dt>cost</dt><dd>{money(data.capacity.totalCost)}</dd></div>
			<span class="sep" aria-hidden="true">·</span>
			<div class="vital"><dt>tok&nbsp;today</dt><dd>{compact(data.capacity.tokensToday)}</dd></div>
		</dl>
	</header>

	<!-- ================= MAIN GRID ================= -->
	<div class="grid">
		<!-- ---------- LEFT: running now + activity ---------- -->
		<section class="panel running" aria-labelledby="h-running">
			<div class="panel-head">
				<h2 id="h-running"><span class="bar" aria-hidden="true"></span>RUNNING NOW</h2>
				<a class="more" href="/workspaces/{data.slug}/sessions">all sessions →</a>
			</div>

			{#if nothingLive}
				<p class="empty">
					<span class="empty-glyph" aria-hidden="true">◇</span>
					Nothing running right now. The platform is idle —
					<a href="/workspaces/{data.slug}/sessions/new">start a session</a>.
				</p>
			{:else}
				<ul class="live-list">
					{#each data.runningNow.sessions as s (s.id)}
						<li>
							<details>
								<summary>
									<span class="dot tone-{s.hasError ? 'flare' : 'solar'}" aria-hidden="true"></span>
									<span class="tag mono">SESSION</span>
									<span class="avatar" aria-hidden="true">{s.agentAvatar ?? '🤖'}</span>
									<span class="title">{s.title}</span>
									<span class="age mono">{relative(s.at)}</span>
									<span class="chev" aria-hidden="true">›</span>
								</summary>
								<div class="detail">
									<span class="kv mono">agent <b>{s.agentName}</b></span>
									{#if s.hasError}
										<span class="kv mono tone-flare">⚠ {s.errorMessage}</span>
									{/if}
									<a class="deep" href={s.href}>open live stream →</a>
								</div>
							</details>
						</li>
					{/each}
					{#each data.runningNow.runs as r (r.id)}
						<li>
							<details>
								<summary>
									<span class="dot tone-solar pulse-dot" aria-hidden="true"></span>
									<span class="tag mono">RUN</span>
									<span class="title">{r.name}</span>
									<span class="age mono">{relative(r.startedAt)}</span>
									<span class="chev" aria-hidden="true">›</span>
								</summary>
								<div class="detail">
									<span class="kv mono">{r.sessionCount} session{r.sessionCount === 1 ? '' : 's'} spawned</span>
									<a class="deep" href={r.href}>open run →</a>
								</div>
							</details>
						</li>
					{/each}
					{#each data.runningNow.previews as p (p.id)}
						<li>
							<details>
								<summary>
									<span class="dot tone-{p.ready ? 'pulse' : 'mist'}" aria-hidden="true"></span>
									<span class="tag mono">PREVIEW</span>
									<span class="title">{p.service}</span>
									<span class="age mono">{p.ready ? 'ready' : 'booting'}</span>
									<span class="chev" aria-hidden="true">›</span>
								</summary>
								<div class="detail">
									{#if p.browseUrl}<a class="deep" href={p.browseUrl} target="_blank" rel="noreferrer">open preview ↗</a>{/if}
									{#if p.href}<a class="deep" href={p.href}>bound session →</a>{/if}
								</div>
							</details>
						</li>
					{/each}
				</ul>
			{/if}

			<!-- activity feed: single merged, newest-first -->
			<div class="panel-head subhead">
				<h2 id="h-activity"><span class="bar" aria-hidden="true"></span>RECENT ACTIVITY</h2>
				<a class="more" href="/workspaces/{data.slug}/runs">all runs →</a>
			</div>
			{#if data.activity.length === 0}
				<p class="empty">
					<span class="empty-glyph" aria-hidden="true">◇</span>
					No recent activity recorded yet.
				</p>
			{:else}
				<ul class="feed" aria-labelledby="h-activity">
					{#snippet feedInner(e, oc)}
						<span class="feed-time mono">{relative(e.at)}</span>
						<span class="status tone-{oc.tone}" title={oc.sr}>
							<span class="status-glyph" aria-hidden="true">{oc.glyph}</span>
							<span class="sr-only">{oc.sr}</span>
						</span>
						<span class="feed-kind mono">{KIND_LABEL[e.kind] ?? e.kind}</span>
						<span class="feed-title">{e.title ?? 'untitled'}</span>
						{#if e.subtitle}<span class="feed-sub">{e.subtitle}</span>{/if}
						<span class="feed-status mono tone-{oc.tone}">{e.statusLabel}</span>
						{#if e.href}<span class="chev" aria-hidden="true">›</span>{/if}
					{/snippet}
					{#each data.activity as e (e.id)}
						{@const oc = OUTCOME[e.outcome] ?? OUTCOME.neutral}
						<li class="feed-row">
							{#if e.href}
								<a class="feed-link" href={e.href}>{@render feedInner(e, oc)}</a>
							{:else}
								<div class="feed-link" role="group">{@render feedInner(e, oc)}</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<!-- ---------- RIGHT: health + capacity ---------- -->
		<div class="rail">
			<section class="panel health" aria-labelledby="h-health">
				<div class="panel-head">
					<h2 id="h-health"><span class="bar" aria-hidden="true"></span>SYSTEM HEALTH</h2>
				</div>
				<div class="verdict-big tone-{verdict.tone}">
					<span class="glyph" aria-hidden="true">{verdict.glyph}</span>
					<span>{verdict.label}</span>
				</div>
				<ul class="signals">
					{#each data.health.signals as sig (sig.key)}
						{@const sh = HEALTH[sig.state] ?? HEALTH.unknown}
						<li>
							<span class="sig-dot tone-{sh.tone}" aria-hidden="true"></span>
							<span class="sig-label mono">{sig.label}</span>
							<span class="sig-state tone-{sh.tone} mono">
								{sig.state === 'operational' ? 'ok' : sig.state}
							</span>
							<span class="sig-detail">{sig.detail}</span>
						</li>
					{/each}
				</ul>
			</section>

			<section class="panel capacity" aria-labelledby="h-capacity">
				<div class="panel-head">
					<h2 id="h-capacity"><span class="bar" aria-hidden="true"></span>CAPACITY &amp; USAGE</h2>
					<a class="more" href="/workspaces/{data.slug}/usage">drill →</a>
				</div>

				<!-- token throughput -->
				<div class="metric">
					<div class="metric-row">
						<span class="metric-label mono">tokens out · 7d</span>
						<span class="metric-val mono tone-pulse">{compact(data.capacity.tokensOut7d)}</span>
					</div>
					{#if data.capacity.hasUsage}
						<div class="spark" aria-hidden="true">
							{#each data.capacity.tokenTrend as v}
								<span class="spark-bar" style="height:{Math.max(6, (v / trendMax) * 100)}%"></span>
							{/each}
						</div>
						<div class="metric-foot mono">
							{compact(data.capacity.tokensIn7d)} in · {compact(data.capacity.tokensOutPerMin)}/min now
						</div>
					{:else}
						<div class="metric-foot mono empty-inline">no token usage in window</div>
					{/if}
				</div>

				<!-- cost -->
				<div class="metric">
					<div class="metric-row">
						<span class="metric-label mono">cost · 30d</span>
						<span class="metric-val mono">{data.capacity.hasCost ? money(data.capacity.totalCost) : '—'}</span>
					</div>
					{#if data.capacity.topModels.length}
						<div class="model-list mono">
							{#each data.capacity.topModels as m (m.model)}
								<span class="model"><b>{m.model.split('/').pop()}</b> {money(m.cost)}</span>
							{/each}
						</div>
					{/if}
				</div>

				<!-- fleet -->
				<div class="metric fleet">
					<div class="metric-row">
						<span class="metric-label mono">fleet utilization</span>
						<span class="metric-val mono">
							{data.capacity.fleet.util === null ? '—' : `${data.capacity.fleet.util}%`}
						</span>
					</div>
					{#if data.capacity.fleet.available && data.capacity.fleet.poolCount > 0}
						<div class="gauge" role="img"
							aria-label="{data.capacity.fleet.ready} of {data.capacity.fleet.desired} replicas ready">
							<span class="gauge-fill" style="width:{data.capacity.fleet.util ?? 0}%"></span>
						</div>
						<details class="pool-drill">
							<summary class="mono">
								{data.capacity.fleet.activePools} active · {data.capacity.fleet.phaseMix.sleeping} sleeping
								<span class="chev" aria-hidden="true">›</span>
							</summary>
							<ul class="pools">
								{#each data.capacity.fleet.pools as p (p.name)}
									<li>
										<span class="pool-dot tone-{p.phase === 'Active' ? 'pulse' : p.phase === 'Starting' ? 'solar' : 'mist'}" aria-hidden="true"></span>
										<span class="pool-name mono">{p.name}</span>
										<span class="pool-rep mono">{p.ready}/{p.desired}</span>
										<span class="pool-phase mono">{p.phase}</span>
									</li>
								{/each}
							</ul>
							<a class="deep" href="/admin/agent-runtimes">runtime detail →</a>
						</details>
					{:else}
						<div class="metric-foot mono empty-inline">
							no warm pools registered — per-session sandboxes in use
						</div>
					{/if}
				</div>
			</section>
		</div>
	</div>
</div>

<style>
	/* ===== design tokens: console-on-abyss, scoped to the command center ===== */
	.cc {
		--abyss: #0a0e16;
		--console: #141c2b;
		--raised: #1b2536;
		--line: #1e2a3d;
		--pulse: #2ee6a6;
		--solar: #ffb23e;
		--flare: #ff5470;
		--mist: #93a1b3;
		--ink: #e8eef6;
		--ink-dim: #aab6c6;
		--focus: var(--pulse);

		position: relative;
		min-height: 100%;
		height: 100%;
		overflow-y: auto;
		background:
			radial-gradient(1200px 480px at 75% -10%, rgba(46, 230, 166, 0.06), transparent 60%),
			radial-gradient(900px 420px at 5% 0%, rgba(255, 178, 62, 0.04), transparent 55%),
			var(--abyss);
		color: var(--ink);
		font-family: 'Geist', system-ui, sans-serif;
		padding: clamp(0.85rem, 2vw, 1.6rem);
		display: flex;
		flex-direction: column;
		gap: clamp(0.85rem, 1.6vw, 1.4rem);
	}
	.mono {
		font-family: 'Geist Mono', ui-monospace, monospace;
		font-variant-numeric: tabular-nums;
		letter-spacing: -0.01em;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
		border: 0;
	}

	/* tone helpers */
	.tone-pulse { color: var(--pulse); }
	.tone-solar { color: var(--solar); }
	.tone-flare { color: var(--flare); }
	.tone-mist { color: var(--mist); }

	/* ===== hero / signature ribbon ===== */
	.hero {
		position: relative;
		border: 1px solid var(--line);
		border-radius: 16px;
		background:
			linear-gradient(180deg, rgba(46, 230, 166, 0.05), transparent 40%),
			var(--console);
		box-shadow:
			0 0 0 1px rgba(46, 230, 166, 0.04),
			0 24px 60px -40px rgba(46, 230, 166, 0.5);
		padding: clamp(0.9rem, 1.8vw, 1.4rem);
		overflow: hidden;
	}
	.hero-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.hero-id { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
	.brand {
		font-weight: 600;
		font-size: clamp(1rem, 1.6vw, 1.25rem);
		letter-spacing: 0.14em;
		color: var(--ink);
	}
	.live-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font: 600 0.68rem/1 'Geist Mono', monospace;
		letter-spacing: 0.18em;
		padding: 0.28rem 0.55rem;
		border-radius: 999px;
		border: 1px solid currentColor;
		background: color-mix(in srgb, currentColor 12%, transparent);
	}
	.live-dot {
		width: 8px; height: 8px; border-radius: 50%;
		background: currentColor;
		box-shadow: 0 0 0 0 currentColor;
		animation: pulse-ring 1.8s ease-out infinite;
	}
	@keyframes pulse-ring {
		0% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 70%, transparent); }
		70% { box-shadow: 0 0 0 7px transparent; }
		100% { box-shadow: 0 0 0 0 transparent; }
	}
	.verdict {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font: 600 0.74rem/1 'Geist Mono', monospace;
		letter-spacing: 0.12em;
	}
	.verdict .glyph, .glyph { font-size: 0.8em; }
	.hero-meta {
		display: inline-flex;
		align-items: center;
		gap: 0.6rem;
		font-size: 0.72rem;
		color: var(--mist);
	}
	.pulsing { color: var(--pulse); transition: color 0.3s; }
	.refresh {
		border: 1px solid var(--line);
		background: var(--raised);
		color: var(--ink-dim);
		border-radius: 8px;
		width: 26px; height: 26px;
		cursor: pointer;
		font-size: 0.9rem;
		line-height: 1;
		transition: color 0.15s, border-color 0.15s;
	}
	.refresh:hover { color: var(--pulse); border-color: var(--pulse); }

	.ribbon {
		position: relative;
		height: clamp(56px, 9vw, 96px);
		margin: clamp(0.7rem, 1.4vw, 1.1rem) 0 0.55rem;
	}
	.ribbon canvas { width: 100%; height: 100%; display: block; }
	.ribbon-fade {
		position: absolute; inset: 0;
		pointer-events: none;
		background: linear-gradient(90deg, var(--console) 0%, transparent 8%, transparent 92%, var(--console) 100%);
	}

	.vitals {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 0.35rem 0.7rem;
		margin: 0;
	}
	.vital { display: inline-flex; align-items: baseline; gap: 0.4rem; }
	.vital dt {
		font-size: 0.66rem;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--mist);
	}
	.vital dd {
		margin: 0;
		font-size: clamp(1.05rem, 2vw, 1.5rem);
		font-weight: 600;
		color: var(--ink);
		line-height: 1;
	}
	.sep { color: var(--line); font-size: 1.1rem; }

	/* ===== grid ===== */
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1.65fr) minmax(0, 1fr);
		gap: clamp(0.85rem, 1.6vw, 1.4rem);
		align-items: start;
	}
	.rail { display: flex; flex-direction: column; gap: clamp(0.85rem, 1.6vw, 1.4rem); }

	.panel {
		border: 1px solid var(--line);
		border-radius: 14px;
		background: var(--console);
		padding: clamp(0.8rem, 1.4vw, 1.15rem);
	}
	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.7rem;
	}
	.subhead { margin-top: 1.4rem; }
	.panel-head h2 {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		margin: 0;
		font: 600 0.74rem/1 'Geist Mono', monospace;
		letter-spacing: 0.16em;
		color: var(--ink-dim);
	}
	.bar {
		width: 3px; height: 13px; border-radius: 2px;
		background: linear-gradient(var(--pulse), color-mix(in srgb, var(--pulse) 30%, transparent));
	}
	.more {
		font: 0.7rem 'Geist Mono', monospace;
		color: var(--mist);
		text-decoration: none;
		white-space: nowrap;
	}
	.more:hover { color: var(--pulse); }

	/* ===== running now list ===== */
	.live-list, .feed, .signals, .pools, .model-list { list-style: none; margin: 0; padding: 0; }
	.live-list li { border-top: 1px solid var(--line); }
	.live-list li:first-child { border-top: 0; }

	details summary {
		display: grid;
		grid-template-columns: auto auto auto 1fr auto auto;
		align-items: center;
		gap: 0.55rem;
		padding: 0.55rem 0.3rem;
		cursor: pointer;
		list-style: none;
		border-radius: 8px;
	}
	details summary::-webkit-details-marker { display: none; }
	details summary:hover { background: var(--raised); }
	.dot {
		width: 9px; height: 9px; border-radius: 50%;
		background: currentColor;
		box-shadow: 0 0 8px color-mix(in srgb, currentColor 60%, transparent);
	}
	.pulse-dot { animation: blink 1.4s ease-in-out infinite; }
	@keyframes blink { 50% { opacity: 0.35; } }
	.tag {
		font-size: 0.6rem;
		letter-spacing: 0.1em;
		color: var(--mist);
		border: 1px solid var(--line);
		border-radius: 5px;
		padding: 0.1rem 0.32rem;
	}
	.avatar { font-size: 0.95rem; }
	.title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.86rem;
		color: var(--ink);
	}
	.age { font-size: 0.72rem; color: var(--mist); white-space: nowrap; }
	.chev { color: var(--mist); transition: transform 0.15s; }
	details[open] .chev { transform: rotate(90deg); }
	.detail {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		padding: 0.2rem 0.3rem 0.7rem 1.7rem;
		font-size: 0.76rem;
	}
	.kv { color: var(--ink-dim); }
	.kv b { color: var(--ink); font-weight: 600; }
	.deep {
		color: var(--pulse);
		text-decoration: none;
		font: 0.74rem 'Geist Mono', monospace;
	}
	.deep:hover { text-decoration: underline; }

	/* ===== activity feed ===== */
	.feed-row { border-top: 1px solid var(--line); }
	.feed-row:first-child { border-top: 0; }
	.feed-link {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.42rem 0.3rem;
		text-decoration: none;
		color: inherit;
		border-radius: 8px;
	}
	a.feed-link:hover { background: var(--raised); }
	.feed-time { font-size: 0.72rem; color: var(--mist); text-align: right; width: 2.6rem; flex: none; }
	.status { display: inline-flex; flex: none; }
	.status-glyph { font-size: 0.8rem; line-height: 1; }
	.feed-kind {
		font-size: 0.58rem;
		letter-spacing: 0.08em;
		color: var(--mist);
		width: 4.4em;
		flex: none;
	}
	.feed-title {
		flex: 1 1 auto;
		min-width: 0;
		font-size: 0.84rem;
		color: var(--ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.feed-sub {
		font-size: 0.72rem;
		color: var(--mist);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 0;
		opacity: 0;
		transition: max-width 0.25s, opacity 0.25s;
	}
	.feed-link:hover .feed-sub { max-width: 14rem; opacity: 1; }
	.feed-status { font-size: 0.7rem; white-space: nowrap; }

	/* ===== health ===== */
	.verdict-big {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		font: 600 clamp(0.95rem, 1.7vw, 1.2rem)/1.1 'Geist', sans-serif;
		letter-spacing: 0.02em;
		padding: 0.4rem 0 0.85rem;
	}
	.verdict-big .glyph { font-size: 1.1em; }
	.signals li {
		display: grid;
		grid-template-columns: auto 5.2em auto 1fr;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0;
		border-top: 1px solid var(--line);
	}
	.sig-dot { width: 9px; height: 9px; border-radius: 50%; background: currentColor; }
	.sig-label { font-size: 0.72rem; color: var(--ink); letter-spacing: 0.04em; }
	.sig-state { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em; }
	.sig-detail { font-size: 0.72rem; color: var(--mist); text-align: right; }

	/* ===== capacity ===== */
	.metric { padding: 0.6rem 0; border-top: 1px solid var(--line); }
	.metric:first-of-type { border-top: 0; }
	.metric-row { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
	.metric-label { font-size: 0.68rem; color: var(--mist); text-transform: uppercase; letter-spacing: 0.07em; }
	.metric-val { font-size: clamp(1.1rem, 2vw, 1.45rem); font-weight: 600; color: var(--ink); }
	.metric-foot { font-size: 0.68rem; color: var(--mist); margin-top: 0.35rem; }
	.empty-inline { color: var(--mist); font-style: italic; opacity: 0.85; }

	.spark {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 34px;
		margin-top: 0.45rem;
	}
	.spark-bar {
		flex: 1;
		min-width: 2px;
		border-radius: 2px 2px 0 0;
		background: linear-gradient(var(--pulse), color-mix(in srgb, var(--pulse) 22%, transparent));
		opacity: 0.85;
	}
	.spark-bar:last-child { background: linear-gradient(var(--solar), color-mix(in srgb, var(--solar) 25%, transparent)); }

	.model-list { display: flex; flex-direction: column; gap: 0.2rem; margin-top: 0.4rem; }
	.model { font-size: 0.7rem; color: var(--mist); }
	.model b { color: var(--ink-dim); font-weight: 600; }

	.gauge {
		height: 8px;
		border-radius: 999px;
		background: var(--raised);
		overflow: hidden;
		margin-top: 0.45rem;
		border: 1px solid var(--line);
	}
	.gauge-fill {
		display: block;
		height: 100%;
		background: linear-gradient(90deg, var(--pulse), var(--solar));
		transition: width 0.6s ease;
	}
	.pool-drill { margin-top: 0.55rem; }
	.pool-drill summary {
		cursor: pointer;
		list-style: none;
		font-size: 0.68rem;
		color: var(--mist);
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.pool-drill summary::-webkit-details-marker { display: none; }
	.pools { margin-top: 0.5rem; display: flex; flex-direction: column; gap: 0.3rem; }
	.pools li { display: grid; grid-template-columns: auto 1fr auto auto; align-items: center; gap: 0.5rem; }
	.pool-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
	.pool-name { font-size: 0.72rem; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.pool-rep { font-size: 0.7rem; color: var(--ink-dim); }
	.pool-phase { font-size: 0.66rem; color: var(--mist); }

	/* ===== empty states ===== */
	.empty {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		padding: 1.4rem 0.4rem;
		color: var(--mist);
		font-size: 0.84rem;
	}
	.empty-glyph { color: var(--mist); font-size: 1rem; }
	.empty a, .metric-foot a { color: var(--pulse); text-decoration: none; }
	.empty a:hover { text-decoration: underline; }

	/* ===== focus + motion ===== */
	.cc :is(a, button, summary):focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
		border-radius: 6px;
	}
	@media (prefers-reduced-motion: reduce) {
		.live-dot, .pulse-dot, .gauge-fill, .feed-sub, .pulsing { animation: none !important; transition: none !important; }
	}

	/* ===== responsive reflow ===== */
	@media (max-width: 920px) {
		.grid { grid-template-columns: 1fr; }
	}
	@media (max-width: 560px) {
		.feed-kind, .tag { display: none; }
		.feed-link { grid-template-columns: 2.1rem auto minmax(0, 1fr) auto; }
		.sig-detail { display: none; }
		.vital dd { font-size: 1.05rem; }
	}
</style>
