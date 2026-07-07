<script lang="ts">
	/**
	 * The RUN lens of the service graph: one execution, auto-detected graph.
	 *
	 * "Flow" = mode=step (the server auto-detects dynamic-script journals vs SW
	 * step logs — the user never chooses a node model); "Services" = the same
	 * run's infra topology. Polls while the run is active (caller's `active`
	 * prop OR any live node in the payload) so the graph breathes without a
	 * manual refresh. Embeddable: used by the run cockpit's Graph tab and the
	 * standalone service-graph page's Run view.
	 */
	import { RefreshCw, GitBranch, Server } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import type { GraphSelection, ServiceGraphPayload } from '$lib/types/service-graph';
	import ServiceGraphCanvas from './service-graph-canvas.svelte';
	import ServiceGraphDrilldown from './service-graph-drilldown.svelte';

	let {
		executionId,
		active = false,
		initialLens = 'flow',
		initialSelection = null,
		onLensChange,
		onSelectionChange
	}: {
		executionId: string;
		/** Caller-known liveness (run status). Polling also self-sustains while
		 *  the payload contains live nodes. */
		active?: boolean;
		initialLens?: 'flow' | 'services';
		/** Deep-linked selection (the page's ?sel= param). */
		initialSelection?: GraphSelection | null;
		onLensChange?: (lens: 'flow' | 'services') => void;
		onSelectionChange?: (sel: GraphSelection | null) => void;
	} = $props();

	// svelte-ignore state_referenced_locally -- initial-value props by design
	let lens = $state<'flow' | 'services'>(initialLens);
	let payload = $state<ServiceGraphPayload | null>(null);
	let loading = $state(false);
	// svelte-ignore state_referenced_locally -- deep-link applies once at mount
	let selection = $state<GraphSelection | null>(initialSelection);
	let refreshNonce = $state(0);

	function setSelection(sel: GraphSelection | null) {
		selection = sel;
		onSelectionChange?.(sel);
	}

	const mode = $derived(lens === 'flow' ? 'step' : 'service');
	const hasLiveNodes = $derived(Boolean(payload?.nodes.some((n) => n.live)));
	const polling = $derived(active || hasLiveNodes);

	let abort: AbortController | null = null;
	async function fetchGraph(background = false) {
		if (!executionId) return;
		abort?.abort();
		const controller = new AbortController();
		abort = controller;
		if (!background) loading = true;
		try {
			const qs = new URLSearchParams({ mode, scope: 'execution', executionId });
			const res = await fetch(`/api/observability/service-graph?${qs}`, {
				signal: controller.signal
			});
			const p = (await res.json()) as ServiceGraphPayload;
			if (!controller.signal.aborted) payload = p;
		} catch (e) {
			if ((e as Error)?.name !== 'AbortError') console.error('service-graph fetch failed', e);
		} finally {
			if (!controller.signal.aborted) loading = false;
		}
	}

	// Foreground fetch when the graph identity changes (run or lens). The
	// deep-linked initialSelection survives only the FIRST load; later identity
	// changes reset the selection (the drilldown would be about the old graph).
	let firstLoad = true;
	$effect(() => {
		void executionId;
		void mode;
		if (firstLoad) firstLoad = false;
		else setSelection(null);
		fetchGraph();
		return () => abort?.abort();
	});

	// Manual refresh keeps the selection — the stale-selection effect below
	// clears it only if the refreshed graph no longer contains it.
	$effect(() => {
		if (refreshNonce > 0) fetchGraph();
	});

	// Background poll while the run breathes (5s — matches the run panel cadence
	// without hammering ClickHouse).
	$effect(() => {
		if (!polling) return;
		const t = setInterval(() => fetchGraph(true), 5000);
		return () => clearInterval(t);
	});

	// Drop a stale selection when the graph no longer contains it.
	$effect(() => {
		if (!payload || loading || !selection) return;
		const present =
			payload.nodes.some((n) => n.id === selection!.id) ||
			payload.edges.some((e) => e.id === selection!.id);
		if (!present) setSelection(null);
	});

	let selectedNode = $derived(
		selection?.kind === 'node' ? (payload?.nodes.find((n) => n.id === selection!.id) ?? null) : null
	);
	let selectedEdge = $derived(
		selection?.kind === 'edge' ? (payload?.edges.find((e) => e.id === selection!.id) ?? null) : null
	);
	let selectionLabel = $derived.by(() => {
		if (selectedNode) return selectedNode.label;
		if (selectedEdge) {
			const lbl = (id: string) => payload?.nodes.find((n) => n.id === id)?.label ?? id;
			return `${lbl(selectedEdge.source)} → ${lbl(selectedEdge.target)}`;
		}
		return '';
	});

	function setLens(next: 'flow' | 'services') {
		if (lens === next) return;
		lens = next;
		onLensChange?.(next);
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="flex items-center gap-2 border-b bg-card/50 px-3 py-1.5">
		<div class="inline-flex overflow-hidden rounded-md border">
			<Button
				variant={lens === 'flow' ? 'default' : 'ghost'}
				size="sm"
				class="h-6 gap-1 rounded-none px-2.5 text-xs"
				onclick={() => setLens('flow')}
			>
				<GitBranch class="size-3" /> Flow
			</Button>
			<Button
				variant={lens === 'services' ? 'default' : 'ghost'}
				size="sm"
				class="h-6 gap-1 rounded-none px-2.5 text-xs"
				onclick={() => setLens('services')}
			>
				<Server class="size-3" /> Services
			</Button>
		</div>
		<span class="text-[11px] text-muted-foreground">
			{lens === 'flow' ? 'The run’s calls and phases' : 'Infra topology touched by this run'}
		</span>
		<div class="ml-auto flex items-center gap-2">
			{#if polling}
				<span class="inline-flex items-center gap-1.5 text-[11px] text-primary">
					<span class="size-1.5 animate-pulse rounded-full bg-primary"></span> live
				</span>
			{/if}
			<Button
				variant="ghost"
				size="sm"
				class="h-6 gap-1 px-2 text-xs"
				disabled={loading}
				onclick={() => (refreshNonce += 1)}
			>
				<RefreshCw class="size-3 {loading ? 'animate-spin' : ''}" /> Refresh
			</Button>
		</div>
	</div>

	<div class="flex min-h-0 flex-1">
		<div class="min-h-0 flex-1">
			<ServiceGraphCanvas {payload} {loading} onSelect={(s) => setSelection(s)} />
		</div>
		{#if selection && (selectedNode || selectedEdge)}
			<ServiceGraphDrilldown
				{executionId}
				{selection}
				{selectionLabel}
				{mode}
				insight={selection ? (payload?.insights?.nodes[selection.id] ?? null) : null}
				red={selectedNode?.red ?? selectedEdge?.red ?? null}
				onClose={() => setSelection(null)}
			/>
		{/if}
	</div>

	{#if payload?.meta.degraded}
		<div class="border-t bg-destructive/10 px-4 py-2 text-xs text-destructive">
			Telemetry store unavailable — graph may be incomplete. {payload.meta.warnings.join(' · ')}
		</div>
	{/if}
</div>
