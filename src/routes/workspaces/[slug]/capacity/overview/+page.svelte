<script lang="ts">
	import { page } from '$app/state';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import {
		Activity,
		AlertTriangle,
		CheckCircle2,
		Clock3,
		ExternalLink,
		ListChecks,
		RefreshCw,
		Server
	} from '@lucide/svelte';
	import { createClusterQueueStream } from '$lib/stores/kueueviz/cluster-queues.svelte';
	import { createWorkloadStream } from '$lib/stores/kueueviz/workloads.svelte';
	import { createResourceFlavorStream } from '$lib/stores/kueueviz/resource-flavors.svelte';
	import StatusPill from '$lib/components/capacity/status-pill.svelte';
	import ResourceFlavorStrip from '$lib/components/capacity/resource-flavor-strip.svelte';
	import { formatQuantityForResource } from '$lib/components/capacity/quantity';
	import MetricSparkline from '$lib/components/metrics/MetricSparkline.svelte';
	import CapacityGauge from '$lib/components/capacity/overview/capacity-gauge.svelte';
	import GaugeResourceToggle, {
		type GaugeResource
	} from '$lib/components/capacity/overview/gauge-resource-toggle.svelte';
	import QueueHeadroomRow from '$lib/components/capacity/overview/queue-headroom-row.svelte';
	import HeadroomForecast from '$lib/components/capacity/overview/headroom-forecast.svelte';
	import PressurePanel from '$lib/components/capacity/overview/pressure-panel.svelte';
	import AdmissionHealthBanner from '$lib/components/capacity/overview/admission-health-banner.svelte';
	import QueueDetailSheet from '$lib/components/capacity/overview/queue-detail-sheet.svelte';
	import ContributorHeatmap from '$lib/components/capacity/overview/contributor-heatmap.svelte';
	import ContributorDetailSheet from '$lib/components/capacity/overview/contributor-detail-sheet.svelte';
	import type { ClusterQueueSnapshot } from '$lib/server/kueueviz';
	import CapacityTrendsPanel, {
		type HistoryPoint
	} from '$lib/components/capacity/overview/capacity-trends-panel.svelte';
	import PendingDurationHistogram from '$lib/components/capacity/overview/pending-duration-histogram.svelte';
	import WorkloadDistributionDonut from '$lib/components/capacity/overview/workload-distribution-donut.svelte';
	import CapacityCoveragePanel from '$lib/components/capacity/overview/capacity-coverage-panel.svelte';
	import type { TrendsWindow } from '$lib/components/capacity/overview/trends-window-toggle.svelte';
	import {
		embeddedHeadlampClusterUrl,
		embeddedHeadlampKueueUrl,
		normalizeHeadlampCluster
	} from '$lib/headlamp/links';
	import { getCapacityOverview, getCapacityPsiTrends, getSchedulingLatency } from './data.remote';
	import type {
		CapacityBlockedWorkload,
		CapacityContributorSnapshot,
		CapacityObserverSnapshot,
		CapacityQueueSnapshot,
		CapacitySessionSnapshot
	} from '$lib/types/capacity';

	const slug = $derived(page.params.slug as string);

	const queues = createClusterQueueStream();
	const workloads = createWorkloadStream();
	const flavors = createResourceFlavorStream();
	const schedulingQuery = getSchedulingLatency();
	const psiTrendsQuery = getCapacityPsiTrends();
	const capacityQuery = getCapacityOverview();

	const observer = $derived<CapacityObserverSnapshot | null>(
		capacityQuery.current?.observer.available ? capacityQuery.current.observer.snapshot : null
	);
	const coverage = $derived(capacityQuery.current?.coverage ?? null);
	const observerError = $derived(
		capacityQuery.current?.observer.available === false ? capacityQuery.current.observer.error : null
	);

	// --- Resource toggle (persisted) ---------------------------------------
	const DEFAULT_RESOURCE: GaugeResource = 'cpu';
	let primaryResource = $state<GaugeResource>(DEFAULT_RESOURCE);
	$effect(() => {
		if (typeof window === 'undefined') return;
		try {
			const stored = window.localStorage.getItem('capacity.gauge.resource');
			if (
				stored === 'cpu' ||
				stored === 'memory' ||
				stored === 'pods' ||
				stored === 'ephemeral-storage'
			) {
				primaryResource = stored;
			}
		} catch {
			// ignore
		}
	});

	// --- Trends window (persisted) -----------------------------------------
	let trendsWindow = $state<TrendsWindow>('5m');
	$effect(() => {
		if (typeof window === 'undefined') return;
		try {
			const stored = window.localStorage.getItem('capacity.trends.window');
			if (stored === '5m' || stored === '15m' || stored === '60m') {
				trendsWindow = stored;
			}
		} catch {
			// ignore
		}
	});

	// --- Selected blocked-workload bucket (filter pending list) ------------
	let blockedBucket = $state<'lt30s' | 'lt2m' | 'lt10m' | 'gte10m' | null>(null);

	// --- Contributor detail sheet state ------------------------------------
	let selectedContributor = $state<CapacityContributorSnapshot | null>(null);
	let sheetOpen = $state(false);

	// --- Queue detail sheet state ------------------------------------------
	let selectedQueue = $state<ClusterQueueSnapshot | null>(null);
	let queueSheetOpen = $state(false);

	// --- 5s refresh with Page-Visibility pause -----------------------------
	let lastRefreshAt = $state<number | null>(null);
	let isRefreshing = $state(false);

	async function tick() {
		isRefreshing = true;
		try {
			await Promise.all([capacityQuery.refresh(), schedulingQuery.refresh(), psiTrendsQuery.refresh()]);
			lastRefreshAt = Date.now();
		} finally {
			isRefreshing = false;
		}
	}

	$effect(() => {
		if (typeof document === 'undefined') return;
		let timer: ReturnType<typeof setInterval> | null = null;
		const start = () => {
			if (timer !== null) return;
			timer = setInterval(tick, 5000);
		};
		const stop = () => {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		};
		const onVisibility = () => {
			if (document.visibilityState === 'visible') {
				void tick();
				start();
			} else {
				stop();
			}
		};
		onVisibility();
		document.addEventListener('visibilitychange', onVisibility);
		return () => {
			stop();
			document.removeEventListener('visibilitychange', onVisibility);
		};
	});

	// --- Capacity history (for forecast + trends panel) --------------------
	// One rolling ring buffer for everything the page needs to draw a
	// time-series against. Resource-agnostic fields (workload counts,
	// scheduling-latency P50/P95) survive a resource-toggle flip; resource-
	// specific fields (`requested`, `headroomPct`) are blanked when the
	// gauge resource changes because slopes don't translate across units.
	// Max buffer size = 720 (60 min @ 5 s); the trends panel windows this
	// further at render time so we don't need separate buffers per window.
	let history = $state<HistoryPoint[]>([]);
	const HISTORY_MAX = 720;

	// Per-contributor weighted-share trend, keyed by contributor.key. Each
	// array holds at most TREND_MAX samples and the heatmap + sheet pluck
	// from it directly. Survives resource flips (heatmap shows ALL resources
	// at once, not the selected one).
	const TREND_MAX = 60;
	let contributorTrends = $state<Record<string, number[]>>({});

	function contributorScore(c: CapacityContributorSnapshot): number {
		return (
			(c.resources?.cpu ?? 0) * 1000 +
			((c.resources?.memory ?? 0) / 1024 ** 3) * 25 +
			(c.resources?.['ephemeral-storage'] ?? 0) / 1024 ** 3 +
			(c.resources?.pods ?? 0) * 10
		);
	}

	$effect(() => {
		const snap = observer;
		const resource = primaryResource;
		const sched = schedulingQuery.current;
		const tot = totals;
		if (!snap) return;
		const row = snap.resources.find((r) => r.resource === resource);
		if (!row) return;
		const sampledAt = new Date(snap.sampledAt).getTime() || Date.now();
		const headroomPct =
			row.renderedBudget > 0
				? Math.max(0, Math.min(100, (row.headroom / row.renderedBudget) * 100))
				: null;
		const psi = snap.psi ?? {};
		const psiCoverage = psi.coverage;
		const psiCoverageRatioPct =
			psiCoverage && psiCoverage.expectedNodes.length > 0
				? (psiCoverage.sampledNodes.length / psiCoverage.expectedNodes.length) * 100
				: psiCoverage
					? 100
					: null;
		const sample: HistoryPoint = {
			t: sampledAt,
			requested: row.requested,
			schedulingP50Ms: sched?.p50Ms ?? null,
			schedulingP95Ms: sched?.p95Ms ?? null,
			admittedCount: tot.admitted,
			pendingCount: tot.pending,
			reservingCount: tot.reserving,
			headroomPct,
			psiCpuSome60: psi.cpu?.some?.avg60 ?? null,
			psiMemorySome60: psi.memory?.some?.avg60 ?? null,
			psiIoSome60: psi.io?.some?.avg60 ?? null,
			psiCoverageRatioPct
		};
		const last = history.at(-1);
		if (last && last.t === sample.t) return;
		const next = [...history, sample];
		if (next.length > HISTORY_MAX) next.splice(0, next.length - HISTORY_MAX);
		history = next;

		// Update per-contributor trends from THIS snapshot's contributors.
		const all = snap.contributors ?? [];
		// Compute a max for normalisation so the sparkline trend is share-style
		// (0..1 of the heaviest contributor in this tick).
		const scores = all.map(contributorScore);
		const maxScore = Math.max(1, ...scores);
		const updates: Record<string, number[]> = { ...contributorTrends };
		for (let i = 0; i < all.length; i += 1) {
			const c = all[i];
			const key = c.key;
			const value = scores[i] / maxScore;
			const series = updates[key] ? [...updates[key], value] : [value];
			if (series.length > TREND_MAX) series.splice(0, series.length - TREND_MAX);
			updates[key] = series;
		}
		contributorTrends = updates;
	});

	// On resource flip: reset the buffer. The plan called for preserving
	// resource-agnostic series (workload counts + latency) across a flip,
	// but the "read + mutate history" form caused a Svelte 5 effect cycle
	// (this $effect reads `history` via .map AND writes to it, while the
	// builder effect above reads `history` via .at(-1) AND writes to it —
	// each effect's write triggers the other's re-run). The simpler
	// reset-on-flip matches the pre-change behaviour and avoids the cycle;
	// the trends panel just warms back up over the next sample window.
	$effect(() => {
		primaryResource;
		history = [];
	});

	// Tracking which contributor is currently open in the sheet so its
	// per-key trend stays attached when the buffer updates.
	const selectedContributorTrend = $derived(
		selectedContributor ? contributorTrends[selectedContributor.key] ?? [] : []
	);

	// --- Derived signals ----------------------------------------------------
	const cluster = $derived(normalizeHeadlampCluster(observer?.cluster));
	const headlampClusterHref = $derived(embeddedHeadlampClusterUrl({ workspaceSlug: slug, cluster }));

	const sparklinePoints = $derived(
		(schedulingQuery.current?.sparkline ?? []).map((p) => ({
			t: new Date(p.t),
			value: p.valueMs
		}))
	);

	const aggregateStatus = $derived.by(() => {
		const statuses = [queues.status, workloads.status, flavors.status];
		if (statuses.includes('connecting')) return 'connecting';
		if (statuses.includes('degraded')) return 'degraded';
		if (statuses.includes('closed')) return 'closed';
		return 'open';
	});
	const aggregateError = $derived(queues.error ?? workloads.error ?? flavors.error);
	const aggregateUpdate = $derived.by(() => {
		const updates = [queues.lastUpdate, workloads.lastUpdate, flavors.lastUpdate].filter(
			(u): u is string => Boolean(u)
		);
		if (updates.length === 0) return null;
		return updates.sort().at(-1) ?? null;
	});

	const totals = $derived.by(() => {
		const counts = { admitted: 0, pending: 0, reserving: 0, finished: 0 };
		for (const wl of workloads.data) {
			if (wl.status === 'admitted') counts.admitted += 1;
			else if (wl.status === 'pending') counts.pending += 1;
			else if (wl.status === 'reserving') counts.reserving += 1;
			else if (wl.status === 'finished') counts.finished += 1;
		}
		return counts;
	});

	const primaryResourceRow = $derived(
		observer?.resources.find((r) => r.resource === primaryResource) ?? null
	);

	// "Over" now means cluster-allocatable over-subscription (a real OOM
	// risk), not Kueue cap exceedance (which is by design + intentional).
	// The Kueue cap is surfaced as the gauge's capMark tick instead.
	const primaryOver = $derived(
		primaryResourceRow
			? Math.max(0, primaryResourceRow.requested - primaryResourceRow.allocatable)
			: 0
	);

	const RESOURCE_LABELS: Record<GaugeResource, string> = {
		cpu: 'CPU',
		memory: 'Memory',
		pods: 'Pods',
		'ephemeral-storage': 'Storage'
	};

	function queueSnapshot(name: string): CapacityQueueSnapshot | null {
		return observer?.queues.find((q) => q.name === name) ?? null;
	}

	function sessionSnapshot(name: string): CapacitySessionSnapshot | null {
		return (
			observer?.sessionCapacity.find(
				(entry) => entry.queue === name || entry.executionClass === name
			) ?? null
		);
	}

	function recentForQueue(name: string) {
		return workloads.data
			.filter((wl) => wl.clusterQueueName === name || wl.queueName === name)
			.filter((wl) => wl.active)
			.sort((a, b) => (a.creationTimestamp < b.creationTimestamp ? 1 : -1))
			.slice(0, 3);
	}

	function workloadReason(wl: (typeof workloads.data)[number]) {
		const condition = [...wl.conditions]
			.reverse()
			.find((entry) => entry.status !== 'True' && (entry.reason || entry.message));
		return condition?.reason || condition?.message || wl.status;
	}

	const blockedWorkloads = $derived.by<CapacityBlockedWorkload[]>(() => {
		if (observer?.blockedWorkloads?.length) return observer.blockedWorkloads.slice(0, 8);
		return workloads.data
			.filter((wl) => wl.status === 'pending' || wl.status === 'reserving')
			.slice(0, 8)
			.map((wl) => ({
				namespace: wl.namespace,
				name: wl.name,
				queue: wl.queueName || wl.clusterQueueName || '',
				status: wl.status,
				reason: workloadReason(wl),
				message: '',
				pendingSeconds: Math.max(
					0,
					(Date.now() - new Date(wl.creationTimestamp).getTime()) / 1000
				)
			}));
	});

	// Filtered list shown under <PendingDurationHistogram>. The histogram
	// emits a bucket selection; we narrow the list to that bucket so the
	// click feels causal.
	const blockedWorkloadsFiltered = $derived.by<CapacityBlockedWorkload[]>(() => {
		if (!blockedBucket) return blockedWorkloads;
		const inBucket = (s: number) => {
			if (blockedBucket === 'lt30s') return s < 30;
			if (blockedBucket === 'lt2m') return s >= 30 && s < 120;
			if (blockedBucket === 'lt10m') return s >= 120 && s < 600;
			return s >= 600;
		};
		return blockedWorkloads.filter((wl) => inBucket(wl.pendingSeconds));
	});

	// Project history → HeadroomForecast Sample shape, filtering out the
	// null `requested` entries that linger after a resource flip.
	const forecastSamples = $derived(
		history
			.filter((p): p is HistoryPoint & { requested: number } => p.requested !== null)
			.map((p) => ({ t: p.t, requested: p.requested }))
	);

	const hasUnhealthy = $derived(
		!!observer?.criticalHealth.some((item) => item.status !== 'healthy')
	);

	const psiCoverage = $derived(observer?.psi?.coverage ?? null);
	const hasTelemetryIncomplete = $derived(Boolean(psiCoverage && !psiCoverage.complete));
	const telemetryCoverageText = $derived.by(() => {
		if (!psiCoverage) return 'PSI unknown';
		return `${psiCoverage.sampledNodes.length}/${psiCoverage.expectedNodes.length} kubelet PSI`;
	});

	const autoOpenAccordion = $derived(
		blockedWorkloads.length > 0 ||
			(observer?.warnings.length ?? 0) > 0 ||
			hasUnhealthy ||
			hasTelemetryIncomplete
	);

	// --- Refresh badge formatting -----------------------------------------
	let now = $state(Date.now());
	$effect(() => {
		if (typeof window === 'undefined') return;
		const id = setInterval(() => {
			now = Date.now();
		}, 1000);
		return () => clearInterval(id);
	});

	const refreshAgeSeconds = $derived(
		lastRefreshAt ? Math.max(0, Math.floor((now - lastRefreshAt) / 1000)) : null
	);

	function refreshAgeLabel(seconds: number | null): string {
		if (seconds === null) return '—';
		if (seconds < 2) return 'just now';
		if (seconds < 60) return `${seconds}s ago`;
		return `${Math.floor(seconds / 60)}m ago`;
	}

	const firstLoad = $derived(capacityQuery.current === undefined && observer === null);

	// --- Headlamp helpers (per-row) ---------------------------------------
	function blockedHeadlampUrl(wl: CapacityBlockedWorkload): string | null {
		return embeddedHeadlampKueueUrl({
			workspaceSlug: slug,
			cluster,
			kind: 'Workload',
			namespace: wl.namespace,
			name: wl.name
		});
	}

	function flavorHeadlampUrl(name: string): string | null {
		return embeddedHeadlampKueueUrl({
			workspaceSlug: slug,
			cluster,
			kind: 'ResourceFlavor',
			name
		});
	}
</script>

<div class="space-y-4">
	<!-- ============================================================
	     Zone A — header strip
	     ============================================================ -->
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div class="flex items-center gap-2">
			<StatusPill
				status={aggregateStatus}
				lastUpdate={aggregateUpdate}
				error={aggregateError}
			/>
			{#if observer?.cluster}
				{#if headlampClusterHref}
					<a
						href={headlampClusterHref}
						class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-mono text-muted-foreground hover:text-foreground"
						title="Open cluster in Headlamp"
					>
						<Server class="size-3" />
						{observer.cluster}
						<ExternalLink class="size-2.5" />
					</a>
				{:else}
					<Badge variant="outline" class="font-mono text-[10px]">
						<Server class="size-3" />
						{observer.cluster}
					</Badge>
				{/if}
			{/if}
			<a
				href={`/workspaces/${slug}/capacity/workloads`}
				class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
			>
				<ListChecks class="size-3" />
				{workloads.data.length} workload{workloads.data.length === 1 ? '' : 's'}
			</a>
			<AdmissionHealthBanner health={observer?.admissionHealth} />
		</div>

		<div class="flex flex-wrap items-center gap-1.5">
			{#if schedulingQuery.current?.hasData}
				{@const snap = schedulingQuery.current}
				<Badge
					variant="outline"
					class="font-mono text-[10px] inline-flex items-center gap-1.5"
					title={`Dapr workflow scheduling latency over the last ${snap.windowSeconds / 60}m. P50/P95 measure the lag between CreateWorkflowInstance and the runtime picking it up — rising P95 = sidecar concurrency caps saturated.`}
				>
					<span class="text-muted-foreground">sched P95:</span>
					<span>{snap.p95Ms !== null ? `${Math.round(snap.p95Ms)}ms` : '—'}</span>
					{#if sparklinePoints.length > 1}
						<MetricSparkline points={sparklinePoints} height={14} width={48} />
					{/if}
				</Badge>
			{/if}
			<Badge variant="outline" class="font-mono text-[10px]">
				<Activity class="size-3" />
				{totals.admitted} adm
			</Badge>
			<Badge variant="outline" class="font-mono text-[10px]">{totals.pending} pend</Badge>
			<Badge variant="outline" class="font-mono text-[10px]">{totals.reserving} res</Badge>

			<button
				type="button"
				onclick={() => void tick()}
				class="ml-1 inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
				disabled={isRefreshing}
				title="Refresh observer snapshot now"
			>
				<RefreshCw class="size-3 {isRefreshing ? 'animate-spin' : ''}" />
				<span>Live · 5s</span>
				<span class="font-mono text-muted-foreground/80">
					{refreshAgeLabel(refreshAgeSeconds)}
				</span>
			</button>
		</div>
	</div>

	{#if aggregateError && aggregateStatus !== 'open'}
		<Alert variant="destructive">
			<AlertDescription class="text-xs">
				Capacity stream {aggregateStatus === 'degraded' ? 'is reconnecting' : 'is unavailable'}.
				{#if aggregateError}
					<span class="font-mono">{aggregateError}</span>
				{/if}
			</AlertDescription>
		</Alert>
	{/if}

	{#if observerError}
		<Alert>
			<AlertDescription class="text-xs">
				Capacity observer snapshot unavailable. <span class="font-mono">{observerError}</span>
			</AlertDescription>
		</Alert>
	{/if}

	<!-- ============================================================
	     Zone B — Cluster cockpit (gauge + headroom list)
	     ============================================================ -->
	<section class="grid gap-4 rounded-md border bg-card p-4 md:grid-cols-[260px_1fr]">
		<div class="flex flex-col items-center gap-3">
			{#if primaryResourceRow}
				<!--
				  Gauge denominator is `allocatable` (real cluster capacity) so the
				  reading matches the operator's mental model (~30-45% on ryzen)
				  rather than the intentionally-tight Kueue admission cap (which
				  reads >100% by design — see kueue-capacity/RATIONALE.md).
				  The Kueue cap is shown as a tick on the arc so admission-cap
				  context isn't lost.
				-->
				<CapacityGauge
					used={primaryResourceRow.requested}
					nominal={primaryResourceRow.allocatable}
					over={primaryOver}
					capMark={primaryResourceRow.renderedBudget}
					capMarkLabel="Kueue cap"
					primaryLabel={RESOURCE_LABELS[primaryResource]}
					secondaryLabel={`${formatQuantityForResource(primaryResource, primaryResourceRow.requested)} / ${formatQuantityForResource(primaryResource, primaryResourceRow.allocatable)}`}
					tertiaryLabel={observer?.cluster ? `cohort agent-platform` : undefined}
					size={160}
					strokeWidth={14}
				/>
			{:else}
				<div class="flex h-[160px] w-[160px] items-center justify-center text-xs text-muted-foreground">
					{#if firstLoad}Loading…{:else}No data{/if}
				</div>
			{/if}

			<GaugeResourceToggle
				value={primaryResource}
				onChange={(next) => (primaryResource = next)}
			/>

			{#if primaryResourceRow}
				{@const realHeadroom = Math.max(
					0,
					primaryResourceRow.allocatable - primaryResourceRow.requested
				)}
				<dl class="mt-1 grid w-full grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
					<dt class="text-muted-foreground">Allocatable</dt>
					<dd class="text-right font-mono tabular-nums">
						{formatQuantityForResource(primaryResource, primaryResourceRow.allocatable)}
					</dd>
					<dt class="text-muted-foreground">Real headroom</dt>
					<dd class="text-right font-mono tabular-nums text-foreground/90">
						{formatQuantityForResource(primaryResource, realHeadroom)}
					</dd>
					<dt class="text-muted-foreground">Reserve</dt>
					<dd class="text-right font-mono tabular-nums">
						{formatQuantityForResource(primaryResource, primaryResourceRow.criticalReserve)}
					</dd>
					<dt class="text-muted-foreground" title="Kueue admission cap (intentionally tight per RATIONALE.md)">Kueue cap</dt>
					<dd class="text-right font-mono tabular-nums">
						{formatQuantityForResource(primaryResource, primaryResourceRow.renderedBudget)}
					</dd>
					<dt class="text-muted-foreground" title="Kueue budget − requested (negative = at admission cap, normal on ryzen)">
						Kueue headroom
					</dt>
					<dd class="text-right font-mono tabular-nums text-muted-foreground">
						{formatQuantityForResource(primaryResource, primaryResourceRow.headroom)}
					</dd>
				</dl>
			{/if}
		</div>

		<div class="min-w-0">
			<header class="flex items-baseline justify-between gap-2">
				<h2 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Queues ({queues.data.length}) · Headroom
				</h2>
				<span class="text-[10px] text-muted-foreground">
					{RESOURCE_LABELS[primaryResource]} · click for detail
				</span>
			</header>

			<div class="mt-2 max-h-[340px] divide-y overflow-y-auto">
				{#each queues.data as cq (cq.name)}
					<QueueHeadroomRow
						queue={cq}
						observerQueue={queueSnapshot(cq.name)}
						resource={primaryResource}
						{cluster}
						{slug}
						onSelect={(q) => {
							selectedQueue = q;
							queueSheetOpen = true;
						}}
					/>
				{:else}
					<p class="py-3 text-xs text-muted-foreground">
						{firstLoad ? 'Loading queues…' : 'No ClusterQueues registered.'}
					</p>
				{/each}
			</div>

			{#if primaryResourceRow}
				<div class="mt-3 border-t pt-3">
					<HeadroomForecast
						samples={forecastSamples}
						headroom={primaryResourceRow.headroom}
						resource={primaryResource}
					/>
				</div>
			{/if}

			<div class="mt-3">
				<PressurePanel psi={observer?.psi} {history} />
			</div>
		</div>
	</section>

	<!-- ============================================================
	     Zone B.5 — Trends (collapsible)
	     ============================================================ -->
	<CapacityTrendsPanel
		{history}
		psiTrends={psiTrendsQuery.current ?? null}
		window={trendsWindow}
		resource={primaryResource}
		onWindowChange={(next) => (trendsWindow = next)}
	/>

	<CapacityCoveragePanel {coverage} />

	<!-- ============================================================
	     More signals — collapsible
	     ============================================================ -->
	<details
		class="group rounded-md border bg-card open:bg-card"
		open={autoOpenAccordion}
	>
		<summary
			class="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
		>
			<span class="flex items-center gap-2">
				More signals
				{#if blockedWorkloads.length > 0}
					<Badge variant="outline" class="border-amber-500/40 text-[10px]">
						{blockedWorkloads.length} blocked
					</Badge>
				{/if}
				{#if observer && observer.warnings.length > 0}
					<Badge variant="outline" class="border-amber-500/40 text-[10px]">
						{observer.warnings.length} warning{observer.warnings.length === 1 ? '' : 's'}
					</Badge>
				{/if}
			{#if hasUnhealthy}
				<Badge variant="outline" class="border-rose-500/40 text-[10px]">unhealthy</Badge>
			{/if}
			{#if hasTelemetryIncomplete}
				<Badge variant="outline" class="border-amber-500/40 text-[10px]">
					telemetry degraded
				</Badge>
			{/if}
		</span>
			<span class="text-[10px] uppercase tracking-wide text-muted-foreground/70 group-open:hidden">
				expand
			</span>
			<span
				class="hidden text-[10px] uppercase tracking-wide text-muted-foreground/70 group-open:inline"
			>
				collapse
			</span>
		</summary>

		<div class="space-y-5 border-t px-4 py-4">
			<!-- Blocked workloads -->
			<section class="space-y-2">
				<header class="flex items-baseline justify-between gap-2">
					<h3 class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
						Blocked Workloads
					</h3>
					{#if blockedWorkloads.length > 0}
						<span class="text-[10px] tabular-nums text-muted-foreground">
							{blockedWorkloadsFiltered.length} of {blockedWorkloads.length} shown
						</span>
					{/if}
				</header>
				<PendingDurationHistogram
					workloads={blockedWorkloads}
					selected={blockedBucket}
					onSelect={(next) => (blockedBucket = next)}
				/>
				{#if blockedWorkloads.length === 0}
					<p class="text-xs text-muted-foreground">No pending or reserving workloads.</p>
				{:else if blockedWorkloadsFiltered.length === 0}
					<p class="text-xs text-muted-foreground">No workloads match the selected bucket.</p>
				{:else}
					<ul class="divide-y rounded border">
						{#each blockedWorkloadsFiltered as wl (wl.namespace + ':' + wl.name)}
							{@const url = blockedHeadlampUrl(wl)}
							<li
								class="grid items-center gap-2 px-3 py-2 text-xs md:grid-cols-[minmax(0,1fr)_120px_120px_90px_24px]"
							>
								<a
									href={`/workspaces/${slug}/capacity/workloads?queue=${encodeURIComponent(wl.queue)}`}
									class="min-w-0 truncate font-mono hover:underline"
									title={wl.name}
								>
									{wl.name}
								</a>
								<span class="font-mono text-muted-foreground">{wl.queue || '—'}</span>
								<span class="truncate text-muted-foreground" title={wl.message || wl.reason}>
									{wl.reason}
								</span>
								<span class="inline-flex items-center gap-1 font-mono text-muted-foreground">
									<Clock3 class="size-3" />
									{Math.round(wl.pendingSeconds)}s
								</span>
								<span class="flex justify-end">
									{#if url}
										<a
											href={url}
											class="text-muted-foreground/70 hover:text-foreground"
											title="Open Workload in Headlamp"
										>
											<ExternalLink class="size-3" />
										</a>
									{/if}
								</span>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<!-- Contributors heatmap -->
			{#if observer}
				<section class="space-y-2">
					<header class="flex items-baseline justify-between gap-2">
						<h3 class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
							Top live request contributors
						</h3>
						<span class="text-[10px] text-muted-foreground">
							share of <span class="font-mono">{observer.flavor}</span> allocatable
						</span>
					</header>
					<ContributorHeatmap
						contributors={observer.contributors ?? []}
						resources={observer.resources}
						{cluster}
						trends={contributorTrends}
						{slug}
						onSelect={(c) => {
							selectedContributor = c;
							sheetOpen = true;
						}}
					/>
				</section>
			{/if}

			<!-- Critical health -->
			{#if observer}
				<section class="space-y-2">
					<header class="flex items-baseline justify-between gap-2">
						<h3 class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
							Critical health
						</h3>
						<span class="text-[10px] text-muted-foreground">
							{observer.nodePressure.schedulableWorkers ?? 0} schedulable ·
							{observer.nodePressure.unschedulableWorkers ?? 0} unschedulable ·
							{observer.nodePressure.diskPressureWorkers ?? 0} disk pressure ·
							{observer.recentPreemptions} preempts · {telemetryCoverageText}
						</span>
					</header>
					<ul class="flex flex-wrap gap-2 text-[11px]">
						{#each observer.criticalHealth as item (item.name)}
							<li
								class="inline-flex items-center gap-1.5 rounded border px-2 py-1 font-mono {item.status ===
								'healthy'
									? ''
									: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'}"
							>
								{#if item.status === 'healthy'}
									<CheckCircle2 class="size-3 text-emerald-500" />
								{:else}
									<AlertTriangle class="size-3 text-amber-500" />
								{/if}
								<span class="capitalize">{item.name}</span>
								<span class="text-muted-foreground tabular-nums">{item.ready}/{item.total}</span>
							</li>
						{/each}
						<li
							class="inline-flex items-center gap-1.5 rounded border px-2 py-1 font-mono {psiCoverage?.complete ===
							false
								? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
								: ''}"
						>
							{#if psiCoverage?.complete === false}
								<AlertTriangle class="size-3 text-amber-500" />
							{:else}
								<CheckCircle2 class="size-3 text-emerald-500" />
							{/if}
							<span>kubelet PSI</span>
							<span class="text-muted-foreground tabular-nums">
								{psiCoverage ? `${psiCoverage.sampledNodes.length}/${psiCoverage.expectedNodes.length}` : '—'}
							</span>
						</li>
					</ul>
					{#if psiCoverage?.missingNodes.length}
						<div
							class="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300"
						>
							Missing kubelet PSI from
							<span class="font-mono">{psiCoverage.missingNodes.join(', ')}</span>
							{#if Object.keys(psiCoverage.errorsByNode).length > 0}
								<span class="text-amber-700/80 dark:text-amber-300/80">
									· {Object.entries(psiCoverage.errorsByNode)
										.map(([node, error]) => `${node}: ${error}`)
										.join('; ')}
								</span>
							{/if}
						</div>
					{/if}
					{#if observer.warnings.length > 0}
						<div
							class="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300"
						>
							{observer.warnings[0]}
						</div>
					{/if}
				</section>
			{/if}

			<!-- Resource flavors + workload distribution -->
			<section class="space-y-2">
				<header class="flex items-baseline justify-between gap-2">
					<h3 class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
						Resource Flavors
					</h3>
					<a
						href={`/workspaces/${slug}/capacity/flavors`}
						class="text-[10px] text-primary hover:underline"
					>
						View all →
					</a>
				</header>
				<div class="grid gap-3 md:grid-cols-[1fr_320px]">
					<ResourceFlavorStrip flavors={flavors.data} />
					<WorkloadDistributionDonut queues={queues.data} />
				</div>
				{#if flavors.data.length > 0}
					<div class="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
						{#each flavors.data as f (f.name)}
							{@const url = flavorHeadlampUrl(f.name)}
							{#if url}
								<a
									href={url}
									class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono hover:text-foreground"
								>
									{f.name}
									<ExternalLink class="size-2.5" />
								</a>
							{/if}
						{/each}
					</div>
				{/if}
			</section>
		</div>
	</details>
</div>

<ContributorDetailSheet
	open={sheetOpen}
	contributor={selectedContributor}
	resources={observer?.resources ?? []}
	{cluster}
	{slug}
	trend={selectedContributorTrend}
	onOpenChange={(next) => {
		sheetOpen = next;
		if (!next) selectedContributor = null;
	}}
/>

<QueueDetailSheet
	open={queueSheetOpen}
	queue={selectedQueue}
	observerQueue={selectedQueue ? queueSnapshot(selectedQueue.name) : null}
	sessionCapacity={selectedQueue ? sessionSnapshot(selectedQueue.name) : null}
	recentWorkloads={selectedQueue ? recentForQueue(selectedQueue.name) : []}
	{primaryResource}
	{cluster}
	{slug}
	onOpenChange={(next) => {
		queueSheetOpen = next;
		if (!next) selectedQueue = null;
	}}
/>
