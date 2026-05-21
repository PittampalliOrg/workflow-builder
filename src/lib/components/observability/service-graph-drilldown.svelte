<script lang="ts">
	import { X, Coins, DollarSign, RefreshCcw, AlertTriangle, Timer, Snowflake } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import DrilldownBody from './drilldown/drilldown-body.svelte';
	import {
		serializeSelection,
		type GraphSelection,
		type NodeInsight,
		type RedMetrics
	} from '$lib/types/service-graph';
	import type { ObservabilityInvestigationPayload } from '$lib/types/observability';

	let {
		executionId,
		selection,
		selectionLabel,
		mode = 'service',
		insight = null,
		red = null,
		onClose
	}: {
		executionId: string;
		selection: GraphSelection;
		selectionLabel: string;
		mode?: string;
		insight?: NodeInsight | null;
		red?: RedMetrics | null;
		onClose: () => void;
	} = $props();

	let payload = $state<ObservabilityInvestigationPayload | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let width = $state(620);
	let nonce = $state(0);

	const selKey = $derived(serializeSelection(selection));

	let abort: AbortController | null = null;
	$effect(() => {
		const sel = selKey;
		const exec = executionId;
		void nonce;
		const nodeKind = selection.kind === 'node' ? selection.nodeKind : '';
		const qs = new URLSearchParams({ executionId: exec, sel, mode });
		if (nodeKind) qs.set('nodeKind', nodeKind);

		abort?.abort();
		const controller = new AbortController();
		abort = controller;
		loading = true;
		error = null;
		fetch(`/api/observability/service-graph/drilldown?${qs}`, { signal: controller.signal })
			.then(async (r) => {
				if (!r.ok) {
					const body = await r.json().catch(() => ({}));
					throw new Error(body?.message || `HTTP ${r.status}`);
				}
				return r.json();
			})
			.then((p: ObservabilityInvestigationPayload) => {
				if (!controller.signal.aborted) payload = p;
			})
			.catch((e) => {
				if (e?.name !== 'AbortError') {
					error = e instanceof Error ? e.message : String(e);
					payload = null;
				}
			})
			.finally(() => {
				if (!controller.signal.aborted) loading = false;
			});
		return () => controller.abort();
	});

	// --- header metric formatting ---
	function fmtMs(ms: number | undefined): string {
		if (!ms) return '0ms';
		return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
	}
	function fmtTokens(n: number | undefined): string {
		if (!n) return '0';
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
		return `${n}`;
	}
	function fmtCost(n: number | undefined): string {
		if (n == null) return '—';
		if (n > 0 && n < 0.01) return '<$0.01';
		return `$${n.toFixed(2)}`;
	}
	const timing = $derived(insight?.timing);

	// --- resize handle (drag the left edge) ---
	let dragging = false;
	function onPointerDown(e: PointerEvent) {
		dragging = true;
		(e.target as HTMLElement).setPointerCapture(e.pointerId);
	}
	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		const next = window.innerWidth - e.clientX;
		width = Math.max(380, Math.min(Math.round(next), Math.round(window.innerWidth * 0.7)));
	}
	function onPointerUp(e: PointerEvent) {
		dragging = false;
		(e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
	}
</script>

<aside class="relative flex h-full flex-col border-l bg-background" style="width: {width}px;">
	<!-- drag handle -->
	<div
		class="absolute left-0 top-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/30"
		role="separator"
		aria-orientation="vertical"
		tabindex="-1"
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
	></div>

	<!-- header -->
	<header class="flex flex-col gap-2 border-b px-3 py-2.5">
		<div class="flex items-center gap-2">
			<span class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
				{selection.kind === 'edge' ? 'Edge' : 'Node'}
			</span>
			<span class="truncate text-sm font-semibold" title={selectionLabel}>{selectionLabel}</span>
			<Button variant="ghost" size="icon" class="ml-auto h-7 w-7" onclick={onClose} aria-label="Close">
				<X size={15} />
			</Button>
		</div>
		<div class="flex flex-wrap items-center gap-1.5 text-[11px]">
			{#if insight?.tokens}
				<span class="wb-pill" title="LLM tokens (input/output)">
					<Coins size={11} /> {fmtTokens(insight.tokens.total)}
				</span>
			{/if}
			{#if insight?.costUsd != null}
				<span class="wb-pill" title="estimated LLM cost"><DollarSign size={11} /> {fmtCost(insight.costUsd)}</span>
			{/if}
			{#if red}
				<span class="wb-pill" title="p95 latency"><Timer size={11} /> {fmtMs(red.p95)}</span>
			{/if}
			{#if (insight?.retries ?? 0) > 0}
				<span class="wb-pill" title="retries"><RefreshCcw size={11} /> {insight?.retries}</span>
			{/if}
			{#if (red?.errors ?? 0) > 0}
				<span class="wb-pill wb-pill--err" title="errors"><AlertTriangle size={11} /> {red?.errors}</span>
			{/if}
			{#if timing?.wasColdStart}
				<span class="wb-pill" title="cold start"><Snowflake size={11} /> cold</span>
			{/if}
		</div>
		{#if timing && (timing.coldStartMs || timing.routingMs || timing.credentialFetchMs || timing.executionMs)}
			<div class="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
				{#if timing.coldStartMs}<span>cold {fmtMs(timing.coldStartMs)}</span>{/if}
				{#if timing.credentialFetchMs}<span>cred {fmtMs(timing.credentialFetchMs)}</span>{/if}
				{#if timing.routingMs}<span>route {fmtMs(timing.routingMs)}</span>{/if}
				{#if timing.executionMs}<span>exec {fmtMs(timing.executionMs)}</span>{/if}
			</div>
		{/if}
	</header>

	<!-- body: bespoke, token-driven drill-down scoped to the selection -->
	<div class="min-h-0 flex-1 overflow-hidden">
		<DrilldownBody {payload} {insight} {red} isLoading={loading} {error} />
	</div>
</aside>

<style>
	.wb-pill {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 1px 7px;
		color: var(--foreground);
		font-variant-numeric: tabular-nums;
		background: var(--card);
	}
	.wb-pill--err {
		color: var(--destructive);
		border-color: color-mix(in oklch, var(--destructive) 40%, var(--border));
	}
</style>
