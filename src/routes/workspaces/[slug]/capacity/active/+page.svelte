<script lang="ts">
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import {
		Activity,
		Ban,
		Boxes,
		ChartSpline,
		ChevronDown,
		ExternalLink,
		ListChecks,
		Loader2,
		OctagonX,
		RefreshCw,
		Server,
		Square,
		Trash2
	} from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { createClusterQueueStream } from '$lib/stores/kueueviz/cluster-queues.svelte';
	import { createWorkloadStream } from '$lib/stores/kueueviz/workloads.svelte';
	import StatusPill from '$lib/components/capacity/status-pill.svelte';
	import { formatQuantityForResource } from '$lib/components/capacity/quantity';
	import CapacityGauge from '$lib/components/capacity/overview/capacity-gauge.svelte';
	import GaugeResourceToggle, {
		type GaugeResource
	} from '$lib/components/capacity/overview/gauge-resource-toggle.svelte';
	import AdmissionHealthBanner from '$lib/components/capacity/overview/admission-health-banner.svelte';
	import CapacityOwnerLinks from '$lib/components/capacity/overview/capacity-owner-links.svelte';
	import CapacityOwnerStack from '$lib/components/capacity/overview/capacity-owner-stack.svelte';
	import ActivityCell from '$lib/components/capacity/fleet/activity-cell.svelte';
	import FleetDetailSheet from '$lib/components/capacity/fleet/fleet-detail-sheet.svelte';
	import { getCapacityOverview, getCapacityOwnerTimeline } from '../overview/data.remote';
	import { getFleetActivity } from './data.remote';
	import type {
		CapacityBusinessWorkItem,
		CapacityObserverSnapshot
	} from '$lib/types/capacity';

	const slug = $derived(page.params.slug as string);

	// Live capacity context (push-driven KueueViz) + the project-scoped business-work
	// roll-up (5s poll). The same two feeds the Capacity Overview uses — reused here
	// so the Fleet list and the capacity header never disagree.
	const queues = createClusterQueueStream();
	const workloads = createWorkloadStream();
	const capacityQuery = getCapacityOverview();

	const observer = $derived<CapacityObserverSnapshot | null>(
		capacityQuery.current?.observer.available ? capacityQuery.current.observer.snapshot : null
	);
	const businessWork = $derived(capacityQuery.current?.businessWork ?? null);
	const activeWork = $derived<CapacityBusinessWorkItem[]>(businessWork?.active ?? []);
	const recentWork = $derived<CapacityBusinessWorkItem[]>(businessWork?.recent ?? []);
	const firstLoad = $derived(capacityQuery.current === undefined);

	// --- Scope: live runs vs recently-finished history vs both -----------------
	type Scope = 'active' | 'recent' | 'all';
	let scope = $state<Scope>('active');
	const scopedWork = $derived<CapacityBusinessWorkItem[]>(
		scope === 'active' ? activeWork : scope === 'recent' ? recentWork : [...activeWork, ...recentWork]
	);

	// --- Per-row live activity + tokens (F1): one batched summary keyed by
	// item.key, polled alongside capacity. Covers whatever scope is shown so
	// finished runs still report their cumulative token usage.
	const activityItems = $derived(scopedWork.map((i) => ({ key: i.key, kind: i.kind, id: i.id })));
	const activityQuery = $derived(activityItems.length > 0 ? getFleetActivity(activityItems) : undefined);
	const activity = $derived(activityQuery?.current ?? {});

	// --- Capacity-over-time (F3): the observed cluster powers the ClickHouse
	// owner-stacked timeline. Static once resolved so a transient snapshot gap
	// doesn't blank the chart.
	let metricsCluster = $state<string | null>(null);
	$effect(() => {
		if (observer?.cluster) metricsCluster = observer.cluster;
	});
	let timelineOpen = $state(false);

	// --- Row detail drawer (F4) ----------------------------------------------
	let drawerOpen = $state(false);
	let drawerItem = $state<CapacityBusinessWorkItem | null>(null);
	function openDrawer(item: CapacityBusinessWorkItem) {
		drawerItem = item;
		drawerOpen = true;
	}

	// --- Primary resource toggle (shared persistence key with Overview) -------
	let primaryResource = $state<GaugeResource>('cpu');
	$effect(() => {
		if (typeof window === 'undefined') return;
		try {
			const stored = window.localStorage.getItem('capacity.gauge.resource');
			if (stored === 'cpu' || stored === 'memory' || stored === 'pods' || stored === 'ephemeral-storage') {
				primaryResource = stored;
			}
		} catch {
			// ignore
		}
	});
	function onResourceChange(next: GaugeResource) {
		primaryResource = next;
		try {
			window.localStorage.setItem('capacity.gauge.resource', next);
		} catch {
			// ignore
		}
	}

	const RESOURCE_LABELS: Record<GaugeResource, string> = {
		cpu: 'CPU',
		memory: 'Memory',
		pods: 'Pods',
		'ephemeral-storage': 'Storage'
	};

	// Shared column template so the sticky header and every row align exactly.
	// ☐ · Type · Work · Status · Activity · Tokens · Resource(req+pressure) · Pods · Owners · Age · ⋯
	const GRID_COLS =
		'grid-cols-[24px_56px_minmax(0,1.4fr)_72px_104px_62px_minmax(84px,0.5fr)_32px_minmax(0,0.72fr)_46px_26px]';

	function fmtTokens(n: number | null | undefined): string {
		if (!n) return '—';
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
		return `${n}`;
	}

	// --- Capacity-over-time query + owner resolution (F3) ---------------------
	const ownerTimelineQuery = $derived(
		metricsCluster ? getCapacityOwnerTimeline({ cluster: metricsCluster, resource: primaryResource }) : undefined
	);
	const OWNER_KIND_MAP: Record<string, string> = {
		benchmark_instance: 'benchmarkInstance',
		benchmark_run: 'benchmarkRun',
		workflow_run: 'workflowRun',
		session: 'session',
		agent: 'agent'
	};
	const normId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
	function resolveOwner(kind: string, id: string): { label: string; href?: string; kind: string } {
		const mapped = OWNER_KIND_MAP[kind] ?? kind;
		const target = normId(id);
		const items = [
			...(businessWork?.active ?? []),
			...(businessWork?.recent ?? []),
			...(businessWork?.infrastructure ?? [])
		];
		const item =
			items.find((w) => w.kind === mapped && w.id === id) ??
			items.find((w) => w.kind === mapped && normId(w.id) === target);
		if (item) return { label: item.title, href: item.href, kind: item.kind };
		return { label: id, kind: mapped };
	}

	// --- Filters --------------------------------------------------------------
	type KindFilter = 'all' | 'session' | 'workflow' | 'benchmark';
	let kindFilter = $state<KindFilter>('all');
	let search = $state('');

	const filteredWork = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return scopedWork.filter((item) => {
			if (kindFilter === 'session' && item.kind !== 'session') return false;
			if (kindFilter === 'workflow' && item.kind !== 'workflowRun') return false;
			if (kindFilter === 'benchmark' && item.kind !== 'benchmarkRun' && item.kind !== 'benchmarkInstance')
				return false;
			if (q) {
				const hay = `${item.title} ${item.status} ${item.model ?? ''} ${item.id}`.toLowerCase();
				if (!hay.includes(q)) return false;
			}
			return true;
		});
	});

	// --- Selection + stoppability --------------------------------------------
	// Only the primitives that own a stop authority are selectable. A benchmark
	// INSTANCE / agent aggregate is coordinator-owned and would 409 — surface it,
	// but don't let it be bulk-stopped (cancel the owning run instead).
	type StopTargetKind = 'session' | 'workflowExecution' | 'benchmarkRun' | 'evalRun';
	function stopTarget(item: CapacityBusinessWorkItem): { kind: StopTargetKind; id: string } | null {
		if (item.kind === 'session') return { kind: 'session', id: item.id };
		if (item.kind === 'workflowRun') return { kind: 'workflowExecution', id: item.id };
		if (item.kind === 'benchmarkRun') return { kind: 'benchmarkRun', id: item.id };
		return null;
	}
	// Only ACTIVE primitives with a stop authority are selectable. Recently-
	// finished (recent-scope) items are terminal — inspect-only, never stoppable.
	const isStoppable = (item: CapacityBusinessWorkItem) => item.active && stopTarget(item) !== null;

	let selected = $state<Record<string, boolean>>({});
	const selectedItems = $derived(filteredWork.filter((i) => selected[i.key]));
	const selectedStoppable = $derived(selectedItems.filter(isStoppable));
	const stoppableVisible = $derived(filteredWork.filter(isStoppable));
	const allSelected = $derived(
		stoppableVisible.length > 0 && stoppableVisible.every((i) => selected[i.key])
	);
	const someSelected = $derived(stoppableVisible.some((i) => selected[i.key]) && !allSelected);

	function toggle(key: string) {
		selected = { ...selected, [key]: !selected[key] };
	}
	function toggleAll() {
		if (allSelected) {
			selected = {};
		} else {
			const next: Record<string, boolean> = {};
			for (const i of stoppableVisible) next[i.key] = true;
			selected = next;
		}
	}
	function clearSelection() {
		selected = {};
	}
	// No stale-key cleanup needed: every consumer (selectedItems / selectedStoppable /
	// allSelected) filters selection through the live `filteredWork` rows, and a row's
	// `key` is unique per primitive (e.g. `session:<id>`), so a departed row's leftover
	// flag is inert and can never falsely re-select a future row.

	// --- Stop modes -----------------------------------------------------------
	type StopMode = 'interrupt' | 'terminate' | 'purge';
	const MODE_LABEL: Record<StopMode, string> = {
		interrupt: 'Interrupt',
		terminate: 'Stop',
		purge: 'Stop & clean'
	};
	const MODE_DESC: Record<StopMode, string> = {
		interrupt: 'Cooperatively pause the current turn — the run is kept and can resume.',
		terminate: 'Hard-stop the durable run. The work ends but state is retained.',
		purge: 'Stop, purge durable state, and reap the sandbox pods. Cannot be undone.'
	};

	let busy = $state(false);
	let confirmOpen = $state(false);
	let pendingMode = $state<StopMode>('terminate');
	let pendingTargets = $state<Array<{ kind: StopTargetKind; id: string }>>([]);
	let pendingLabel = $state('');

	function requestBulkStop(mode: StopMode) {
		const targets = selectedStoppable
			.map(stopTarget)
			.filter((t): t is { kind: StopTargetKind; id: string } => t !== null);
		if (targets.length === 0) return;
		pendingMode = mode;
		pendingTargets = targets;
		pendingLabel = `${targets.length} item${targets.length === 1 ? '' : 's'}`;
		confirmOpen = true;
	}

	function requestRowStop(item: CapacityBusinessWorkItem, mode: StopMode) {
		const t = stopTarget(item);
		if (!t) return;
		pendingMode = mode;
		pendingTargets = [t];
		pendingLabel = item.title;
		confirmOpen = true;
	}

	async function runStop() {
		confirmOpen = false;
		if (pendingTargets.length === 0) return;
		busy = true;
		const mode = pendingMode;
		const targets = pendingTargets;
		try {
			const res = await fetch('/api/v1/lifecycle/bulk-stop', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ mode, targets })
			});
			if (!res.ok) {
				const text = await res.text().catch(() => '');
				toast.error(`Bulk ${MODE_LABEL[mode].toLowerCase()} failed`, { description: text || res.statusText });
				return;
			}
			const data = (await res.json()) as {
				summary: {
					total: number;
					confirmed: number;
					stopping: number;
					cancelled: number;
					coordinatorOwned: number;
					notFound: number;
					failed: number;
				};
			};
			const s = data.summary;
			const done = s.confirmed + s.cancelled;
			const parts: string[] = [];
			if (done) parts.push(`${done} stopped`);
			if (s.stopping) parts.push(`${s.stopping} stopping`);
			if (s.coordinatorOwned) parts.push(`${s.coordinatorOwned} coordinator-owned (cancel the run)`);
			if (s.notFound) parts.push(`${s.notFound} not found`);
			if (s.failed) parts.push(`${s.failed} failed`);
			const desc = parts.join(' · ') || 'No changes';
			if (s.failed > 0) toast.warning(`Stopped ${done}/${s.total}`, { description: desc });
			else toast.success(`Requested stop on ${s.total} item${s.total === 1 ? '' : 's'}`, { description: desc });
			clearSelection();
			await capacityQuery.refresh();
		} catch (err) {
			toast.error('Bulk stop failed', {
				description: err instanceof Error ? err.message : String(err)
			});
		} finally {
			busy = false;
			pendingTargets = [];
		}
	}

	// --- Live capacity header signals -----------------------------------------
	let lastRefreshAt = $state<number | null>(null);
	let isRefreshing = $state(false);
	async function tick() {
		isRefreshing = true;
		try {
			await Promise.all([
				capacityQuery.refresh(),
				activityQuery?.refresh(),
				ownerTimelineQuery?.refresh()
			]);
			lastRefreshAt = Date.now();
		} finally {
			isRefreshing = false;
		}
	}
	$effect(() => {
		if (typeof document === 'undefined') return;
		let timer: ReturnType<typeof setInterval> | null = null;
		const start = () => {
			if (timer === null) timer = setInterval(tick, 5000);
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

	let now = $state(Date.now());
	$effect(() => {
		if (typeof window === 'undefined') return;
		const id = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(id);
	});
	const refreshAgeSeconds = $derived(
		lastRefreshAt ? Math.max(0, Math.floor((now - lastRefreshAt) / 1000)) : null
	);
	function ageLabel(seconds: number | null): string {
		if (seconds === null) return '—';
		if (seconds < 2) return 'just now';
		if (seconds < 60) return `${seconds}s ago`;
		return `${Math.floor(seconds / 60)}m ago`;
	}

	const totals = $derived.by(() => {
		const counts = { admitted: 0, pending: 0, reserving: 0 };
		for (const wl of workloads.data) {
			if (wl.status === 'admitted') counts.admitted += 1;
			else if (wl.status === 'pending') counts.pending += 1;
			else if (wl.status === 'reserving') counts.reserving += 1;
		}
		return counts;
	});

	const aggregateStatus = $derived.by(() => {
		const statuses = [queues.status, workloads.status];
		if (statuses.includes('connecting')) return 'connecting';
		if (statuses.includes('degraded')) return 'degraded';
		if (statuses.includes('closed')) return 'closed';
		return 'open';
	});
	const aggregateUpdate = $derived.by(() => {
		const updates = [queues.lastUpdate, workloads.lastUpdate].filter(
			(u): u is string => Boolean(u)
		);
		return updates.length === 0 ? null : (updates.sort().at(-1) ?? null);
	});

	// The capacity meters: requested vs allocatable per resource — "how much is used
	// across the fleet and what is left", straight from the observer snapshot.
	const HEADER_RESOURCES: GaugeResource[] = ['cpu', 'memory', 'pods'];
	function resourceRow(resource: GaugeResource) {
		return observer?.resources.find((r) => r.resource === resource) ?? null;
	}
	const primaryRow = $derived(resourceRow(primaryResource));
	const primaryOver = $derived(
		primaryRow ? Math.max(0, primaryRow.requested - primaryRow.allocatable) : 0
	);
	function resourcePct(resource: GaugeResource): number | null {
		const row = resourceRow(resource);
		if (!row || row.allocatable <= 0) return null;
		return (row.requested / row.allocatable) * 100;
	}
	function meterTone(pct: number | null): string {
		if (pct === null) return 'bg-muted-foreground/30';
		if (pct >= 90) return 'bg-rose-500';
		if (pct >= 70) return 'bg-amber-500';
		return 'bg-emerald-500';
	}

	// --- Row rendering helpers ------------------------------------------------
	function kindLabel(kind: CapacityBusinessWorkItem['kind']): string {
		if (kind === 'workflowRun') return 'Workflow';
		if (kind === 'benchmarkRun') return 'Benchmark';
		if (kind === 'benchmarkInstance') return 'Case';
		if (kind === 'infrastructure') return 'Infra';
		return kind.charAt(0).toUpperCase() + kind.slice(1);
	}
	function durationLabel(seconds: number | null | undefined): string {
		if (seconds === null || seconds === undefined) return '—';
		if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
		if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
		return `${(seconds / 3600).toFixed(seconds < 10 * 3600 ? 1 : 0)}h`;
	}
	function resourceLabel(resources: Record<string, number> | undefined, resource: GaugeResource): string {
		return formatQuantityForResource(resource, resources?.[resource] ?? 0);
	}
	function itemPressurePct(item: CapacityBusinessWorkItem): number | null {
		const p = item.pressure;
		if (primaryResource === 'cpu') return p.cpuPct ?? null;
		if (primaryResource === 'memory') return p.memoryPct ?? null;
		if (primaryResource === 'pods') return p.podsPct ?? null;
		return p.storagePct ?? null;
	}
	function pressureTone(pct: number | null): string {
		if (pct === null) return 'bg-muted';
		if (pct >= 90) return 'bg-rose-500';
		if (pct >= 70) return 'bg-amber-500';
		return 'bg-emerald-500';
	}
	function statusTone(status: string): string {
		const s = status.toLowerCase();
		if (s.includes('fail') || s.includes('error') || s.includes('timeout')) return 'text-rose-500';
		if (s.includes('terminat') || s.includes('cancel') || s === 'idle' || s.includes('finish'))
			return 'text-muted-foreground';
		if (s.includes('reschedul') || s.includes('queue') || s.includes('start') || s.includes('pend'))
			return 'text-sky-500';
		if (s.includes('run') || s === 'active' || s.includes('infer') || s.includes('evaluat') || s.includes('grad'))
			return 'text-emerald-500';
		return 'text-foreground';
	}
</script>

<div class="space-y-4">
	<!-- ============================================================
	     Capacity header — live admission + headroom
	     ============================================================ -->
	<section class="rounded-md border bg-card px-3 py-2.5">
		<div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
			<div class="flex flex-wrap items-center gap-1.5">
				<StatusPill status={aggregateStatus} lastUpdate={aggregateUpdate} error={queues.error ?? workloads.error} />
				{#if observer?.cluster}
					<Badge variant="outline" class="font-mono text-[10px]"><Server class="size-3" />{observer.cluster}</Badge>
				{/if}
				<a
					href={`/workspaces/${slug}/capacity/workloads`}
					class="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
				>
					<ListChecks class="size-3" />{workloads.data.length} wl
				</a>
				<AdmissionHealthBanner health={observer?.admissionHealth} />
				<Badge variant="outline" class="font-mono text-[10px]"><Activity class="size-3" />{totals.admitted} adm</Badge>
				<Badge variant="outline" class="font-mono text-[10px]">{totals.pending} pend</Badge>
				<Badge variant="outline" class="font-mono text-[10px]">{totals.reserving} res</Badge>
			</div>
			<button
				type="button"
				onclick={() => void tick()}
				disabled={isRefreshing}
				class="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
				title="Refresh now"
			>
				<RefreshCw class="size-3 {isRefreshing ? 'animate-spin' : ''}" />
				<span>Live · 5s</span>
				<span class="font-mono text-muted-foreground/80">{ageLabel(refreshAgeSeconds)}</span>
			</button>
		</div>

		<div class="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-3">
			<!-- compact primary-resource gauge + toggle -->
			<div class="flex shrink-0 items-center gap-2">
				{#if primaryRow}
					<CapacityGauge
						used={primaryRow.requested}
						nominal={primaryRow.allocatable}
						over={primaryOver}
						capMark={primaryRow.renderedBudget}
						capMarkLabel="cap"
						primaryLabel={RESOURCE_LABELS[primaryResource]}
						secondaryLabel={`${formatQuantityForResource(primaryResource, primaryRow.requested)}/${formatQuantityForResource(primaryResource, primaryRow.allocatable)}`}
						size={78}
						strokeWidth={8}
					/>
				{:else}
					<div class="flex size-[78px] items-center justify-center rounded-full border text-[10px] text-muted-foreground">
						{firstLoad ? '…' : 'n/a'}
					</div>
				{/if}
				<GaugeResourceToggle value={primaryResource} onChange={onResourceChange} />
			</div>

			<!-- slim animated meters: used / allocatable per resource -->
			<div class="grid min-w-[230px] flex-1 content-center gap-1.5">
				{#each HEADER_RESOURCES as resource (resource)}
					{@const row = resourceRow(resource)}
					{@const pct = resourcePct(resource)}
					<div class="flex items-center gap-2 text-[11px]">
						<span class="w-12 shrink-0 text-muted-foreground">{RESOURCE_LABELS[resource]}</span>
						<div class="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
							{#if pct !== null}
								<div
									class="h-full rounded-full {meterTone(pct)} transition-[width] duration-500"
									style="width: {Math.min(100, pct)}%"
								></div>
							{/if}
						</div>
						<span class="w-[120px] shrink-0 text-right font-mono tabular-nums">
							{#if row}
								{formatQuantityForResource(resource, row.requested)}<span class="text-muted-foreground/50"
									>/{formatQuantityForResource(resource, row.allocatable)}</span
								>
								<span
									class={pct !== null && pct >= 90
										? 'text-rose-500'
										: pct !== null && pct >= 70
											? 'text-amber-500'
											: 'text-muted-foreground'}>{pct?.toFixed(0) ?? '—'}%</span
								>
							{:else}
								<span class="text-muted-foreground">—</span>
							{/if}
						</span>
					</div>
				{/each}
			</div>

			<!-- compact stat trio -->
			<div class="flex shrink-0 items-stretch gap-1.5 text-center">
				<div class="rounded border bg-background px-3 py-1">
					<div class="text-[9px] uppercase tracking-wide text-muted-foreground">Running</div>
					<div class="text-lg font-semibold leading-tight tabular-nums">{activeWork.length}</div>
				</div>
				<div class="rounded border bg-background px-3 py-1">
					<div class="text-[9px] uppercase tracking-wide text-muted-foreground">Blocked</div>
					<div
						class="text-lg font-semibold leading-tight tabular-nums {(businessWork?.totals
							.blockedWorkloads ?? 0) > 0
							? 'text-amber-500'
							: ''}"
					>
						{businessWork?.totals.blockedWorkloads ?? 0}
					</div>
				</div>
				<div class="rounded border bg-background px-3 py-1">
					<div class="text-[9px] uppercase tracking-wide text-muted-foreground">{RESOURCE_LABELS[primaryResource]} req</div>
					<div class="pt-1 font-mono text-sm leading-tight tabular-nums">
						{resourceLabel(businessWork?.totals.requestedResources, primaryResource)}
					</div>
				</div>
			</div>
		</div>
	</section>

	<!-- ============================================================
	     Capacity over time — owner-stacked utilization (collapsible)
	     ============================================================ -->
	<details class="rounded-md border bg-card" bind:open={timelineOpen}>
		<summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground">
			<ChartSpline class="size-3.5" />
			<span class="font-medium text-foreground">Capacity over time</span>
			<span class="text-[10px]">last 60m · stacked by session / run · {RESOURCE_LABELS[primaryResource]}</span>
			<ChevronDown class="ml-auto size-3.5 transition-transform {timelineOpen ? 'rotate-180' : ''}" />
		</summary>
		<div class="border-t px-3 py-3">
			{#if ownerTimelineQuery?.current?.hasData}
				<CapacityOwnerStack timeline={ownerTimelineQuery.current} {resolveOwner} height={120} />
			{:else}
				<p class="py-6 text-center text-xs text-muted-foreground">
					{ownerTimelineQuery?.current
						? 'No capacity history yet — sessions and runs appear here as bands that rise and fall over time.'
						: 'Loading capacity history…'}
				</p>
			{/if}
		</div>
	</details>

	<!-- ============================================================
	     Fleet table — every active resource-consuming primitive
	     ============================================================ -->
	<section class="rounded-md border bg-card">
		<header class="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
			<div class="flex items-center gap-2">
				<Boxes class="size-3.5" />
				<h2 class="text-sm font-semibold">
					{scope === 'recent' ? 'Recent work' : scope === 'all' ? 'All work' : 'Active work'}
				</h2>
				<span class="text-[11px] text-muted-foreground">
					{filteredWork.length} of {scopedWork.length}
				</span>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<input
					type="search"
					placeholder="Filter name, model, id…"
					bind:value={search}
					class="h-7 w-44 rounded-md border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
				/>
				<div class="flex rounded-md border text-[11px]">
					{#each [['active', 'Active'], ['recent', 'Recent'], ['all', 'All']] as [value, label] (value)}
						<button
							type="button"
							onclick={() => (scope = value as Scope)}
							class="px-2 py-1 transition-colors first:rounded-l-md last:rounded-r-md {scope === value
								? 'bg-primary text-primary-foreground'
								: 'text-muted-foreground hover:text-foreground'}"
						>
							{label}
						</button>
					{/each}
				</div>
				<div class="flex rounded-md border text-[11px]">
					{#each [['all', 'All'], ['session', 'Sessions'], ['workflow', 'Workflows'], ['benchmark', 'Benchmarks']] as [value, label] (value)}
						<button
							type="button"
							onclick={() => (kindFilter = value as KindFilter)}
							class="px-2 py-1 transition-colors first:rounded-l-md last:rounded-r-md {kindFilter === value
								? 'bg-primary text-primary-foreground'
								: 'text-muted-foreground hover:text-foreground'}"
						>
							{label}
						</button>
					{/each}
				</div>
			</div>
		</header>

		<!-- Bulk action bar -->
		{#if selectedStoppable.length > 0}
			<div class="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-1.5">
				<span class="text-xs font-medium">{selectedStoppable.length} selected</span>
				<div class="flex items-center gap-1.5">
					<Button size="sm" variant="outline" class="h-7" disabled={busy} onclick={() => requestBulkStop('interrupt')}>
						<Square class="size-3.5" /> Interrupt
					</Button>
					<Button size="sm" variant="outline" class="h-7" disabled={busy} onclick={() => requestBulkStop('terminate')}>
						<OctagonX class="size-3.5" /> Stop
					</Button>
					<Button size="sm" variant="destructive" class="h-7" disabled={busy} onclick={() => requestBulkStop('purge')}>
						<Trash2 class="size-3.5" /> Stop &amp; clean
					</Button>
					{#if busy}<Loader2 class="size-4 animate-spin text-muted-foreground" />{/if}
				</div>
				<button
					type="button"
					onclick={clearSelection}
					class="ml-auto text-[11px] text-muted-foreground hover:text-foreground"
				>
					Clear
				</button>
			</div>
		{/if}

		<!-- Scrollable, sticky-headed table — sized for many simultaneous instances -->
		<div class="max-h-[62vh] overflow-y-auto">
			<!-- Column header -->
			<div
				class="sticky top-0 z-10 hidden items-center gap-2 border-b bg-card/95 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur md:grid {GRID_COLS}"
			>
				<input
					type="checkbox"
					checked={allSelected}
					indeterminate={someSelected}
					onchange={toggleAll}
					disabled={stoppableVisible.length === 0}
					class="size-3.5 accent-primary"
					aria-label="Select all stoppable rows"
				/>
				<span>Type</span>
				<span>Work</span>
				<span>Status</span>
				<span>Activity</span>
				<span class="text-right">Tokens</span>
				<span class="text-right">{RESOURCE_LABELS[primaryResource]}</span>
				<span class="text-right">Pods</span>
				<span>Owners</span>
				<span class="text-right">Age</span>
				<span></span>
			</div>

			<!-- Rows -->
			<div class="divide-y">
				{#each filteredWork as item (item.key)}
					{@const stoppable = isStoppable(item)}
					{@const pressure = itemPressurePct(item)}
					<div
						role="button"
						tabindex="0"
						onclick={() => openDrawer(item)}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								openDrawer(item);
							}
						}}
						title="Open live preview"
						class="group grid cursor-pointer items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-muted/40 md:grid {GRID_COLS} {selected[item.key]
							? 'bg-primary/5'
							: ''}"
					>
						<div class="flex items-center">
							{#if stoppable}
								<input
									type="checkbox"
									checked={!!selected[item.key]}
									onchange={() => toggle(item.key)}
									onclick={(e) => e.stopPropagation()}
									class="size-3.5 accent-primary"
									aria-label="Select {item.title}"
								/>
							{:else if item.active}
								<span title="Coordinator-owned — cancel the owning run">
									<Ban class="size-3.5 text-muted-foreground/40" />
								</span>
							{:else}
								<span class="block size-3.5" title="Finished — inspect only"></span>
							{/if}
						</div>

						<Badge variant="outline" class="w-fit shrink-0 px-1.5 text-[10px]">{kindLabel(item.kind)}</Badge>

						<div class="flex min-w-0 flex-col gap-0.5">
							<div class="flex min-w-0 items-center gap-1.5">
								{#if item.href}
									<a
										href={item.href}
										onclick={(e) => e.stopPropagation()}
										class="min-w-0 truncate font-medium hover:underline"
										title={item.title}>{item.title}</a
									>
								{:else}
									<span class="min-w-0 truncate font-medium" title={item.title}>{item.title}</span>
								{/if}
								{#if item.model}
									<span class="hidden shrink-0 truncate text-[10px] text-muted-foreground/80 xl:inline" title={item.model}>{item.model}</span>
								{/if}
							</div>
							{#if item.kind === 'workflowRun' && (item.currentNodeName || item.progress != null)}
								<div class="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
									{#if item.currentNodeName}
										<span class="min-w-0 truncate">{item.currentNodeName}</span>
									{/if}
									{#if item.progress != null}
										<div class="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-muted">
											<div class="h-full rounded-full bg-sky-500" style="width: {item.progress}%"></div>
										</div>
										<span class="shrink-0 font-mono tabular-nums">{item.progress}%</span>
									{/if}
								</div>
							{/if}
						</div>

						<span class="truncate font-mono text-[11px] {statusTone(item.status)}" title={item.status}>{item.status}</span>

						<ActivityCell
							status={item.status}
							lastEventAt={activity[item.key]?.lastEventAt ?? null}
							series={activity[item.key]?.series ?? []}
							nowMs={now}
						/>

						<span
							class="text-right font-mono text-[11px] tabular-nums {activity[item.key]?.tokens
								? ''
								: 'text-muted-foreground'}"
							title={activity[item.key]
								? `${(activity[item.key]?.tokensIn ?? 0).toLocaleString()} in · ${(activity[item.key]?.tokensOut ?? 0).toLocaleString()} out`
								: 'No token usage recorded'}>{fmtTokens(activity[item.key]?.tokens)}</span
						>

						<div
							class="flex items-center justify-end gap-1.5"
							title={pressure === null
								? 'Live usage telemetry pending'
								: `${pressure.toFixed(0)}% of request · ${resourceLabel(item.observedResources, primaryResource)} observed`}
						>
							<span class="font-mono text-[11px] tabular-nums">{resourceLabel(item.requestedResources, primaryResource)}</span>
							<div class="relative h-1.5 w-9 shrink-0 overflow-hidden rounded-full bg-muted">
								<div
									class="h-full rounded-full {pressureTone(pressure)}"
									style="width: {pressure === null ? 0 : Math.min(100, Math.max(3, pressure))}%"
								></div>
							</div>
						</div>

						<span class="text-right font-mono text-[11px] tabular-nums text-muted-foreground">{item.podCount}</span>

						<CapacityOwnerLinks owners={item.owners} max={2} compact />

						<span class="text-right font-mono text-[11px] text-muted-foreground">{durationLabel(item.durationSeconds ?? item.ageSeconds)}</span>

						<div class="flex justify-end">
							{#if stoppable}
								<DropdownMenu.Root>
									<DropdownMenu.Trigger
										onclick={(e) => e.stopPropagation()}
										class="inline-flex size-6 items-center justify-center rounded-md border text-muted-foreground hover:text-foreground"
										aria-label="Stop options"
									>
										<OctagonX class="size-3.5" />
									</DropdownMenu.Trigger>
									<DropdownMenu.Content align="end">
										<DropdownMenu.Item onclick={() => requestRowStop(item, 'interrupt')}>
											<Square class="size-3.5" /> Interrupt
										</DropdownMenu.Item>
										<DropdownMenu.Item onclick={() => requestRowStop(item, 'terminate')}>
											<OctagonX class="size-3.5" /> Stop
										</DropdownMenu.Item>
										<DropdownMenu.Separator />
										<DropdownMenu.Item
											class="text-destructive data-[highlighted]:text-destructive"
											onclick={() => requestRowStop(item, 'purge')}
										>
											<Trash2 class="size-3.5" /> Stop &amp; clean
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu.Root>
							{:else if item.href}
								<a href={item.href} onclick={(e) => e.stopPropagation()} class="text-muted-foreground/70 hover:text-foreground" title="Open full page">
									<ExternalLink class="size-3.5" />
								</a>
							{/if}
						</div>
					</div>
				{:else}
					<div class="px-4 py-12 text-center text-sm text-muted-foreground">
						{#if firstLoad}
							Loading fleet…
						{:else if scopedWork.length === 0}
							{#if scope === 'recent'}
								No recently-finished sessions, workflows, or runs.
							{:else if scope === 'all'}
								Nothing active or recently finished.
							{:else}
								No active sessions, workflows, or runs are consuming cluster capacity.
							{/if}
						{:else}
							No work matches the current filter.
						{/if}
					</div>
				{/each}
			</div>
		</div>
	</section>
</div>

<FleetDetailSheet open={drawerOpen} item={drawerItem} onOpenChange={(v) => (drawerOpen = v)} />

<AlertDialog.Root bind:open={confirmOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{MODE_LABEL[pendingMode]} {pendingLabel}?</AlertDialog.Title>
			<AlertDialog.Description>
				{MODE_DESC[pendingMode]}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				onclick={runStop}
				class={pendingMode === 'purge'
					? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
					: ''}
			>
				{MODE_LABEL[pendingMode]}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
