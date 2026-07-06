<script lang="ts">
	/**
	 * Inline per-row activity for the Fleet table: a heartbeat dot (is it doing
	 * something right now?) + a micro event-rate sparkline + a "last active"
	 * label. Fed by the batched getFleetActivity summary, so there is no
	 * per-row connection. `nowMs` is supplied by the page's shared 1s clock to
	 * avoid one timer per row.
	 */
	import MetricSparkline from '$lib/components/metrics/MetricSparkline.svelte';
	import NeedsInputBadge from '$lib/components/sessions/needs-input-badge.svelte';
	import type { PendingInput } from '$lib/types/sessions';

	type Props = {
		status: string;
		lastEventAt?: string | null;
		series?: { t: string; value: number }[];
		nowMs: number;
		// Set when a mapped session is parked waiting on a human — surfaces the
		// amber "Needs input" badge inline so a blocked row is visible without
		// opening the session (fed by the batched getFleetActivity summary).
		pendingInput?: PendingInput | null;
	};

	let { status, lastEventAt, series = [], nowMs, pendingInput = null }: Props = $props();

	const LIVE = new Set(['running', 'rescheduling', 'idle', 'active', 'starting', 'queued']);
	const isLive = $derived(LIVE.has(status.toLowerCase()));

	const ageMs = $derived(lastEventAt ? Math.max(0, nowMs - new Date(lastEventAt).getTime()) : null);

	// active = fresh event in the last 15s on a live row; settling = within 60s.
	const phase = $derived.by<'active' | 'settling' | 'idle'>(() => {
		if (!isLive || ageMs === null) return 'idle';
		if (ageMs < 15_000) return 'active';
		if (ageMs < 60_000) return 'settling';
		return 'idle';
	});

	const dotClass = $derived(
		phase === 'active'
			? 'bg-emerald-500'
			: phase === 'settling'
				? 'bg-emerald-500/60'
				: 'bg-muted-foreground/40'
	);
	const sparkColor = $derived(
		phase === 'idle' ? 'rgb(120 120 130)' : 'rgb(16 185 129)'
	);

	const points = $derived(series.map((p) => ({ t: new Date(p.t), value: p.value })));
	const hasActivity = $derived(series.some((p) => p.value > 0));

	function ageLabel(ms: number | null): string {
		if (ms === null) return isLive ? 'no events' : '—';
		if (ms < 2_000) return 'just now';
		if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
		if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
		return `${Math.floor(ms / 3_600_000)}h ago`;
	}
</script>

<div class="flex items-center gap-1.5" title={hasActivity ? `${series.reduce((s, p) => s + p.value, 0)} events in last 60s` : 'No recent agent events'}>
	<span class="relative inline-flex size-2 shrink-0 items-center justify-center">
		{#if phase === 'active'}
			<span class="absolute inline-flex size-2 animate-ping rounded-full bg-emerald-400 opacity-60"></span>
		{/if}
		<span class="relative inline-flex size-2 rounded-full {dotClass}"></span>
	</span>
	<MetricSparkline {points} width={56} height={16} strokeColor={sparkColor} fillColor={phase === 'idle' ? undefined : sparkColor} ariaLabel="activity" />
	<span class="w-12 shrink-0 text-[10px] tabular-nums text-muted-foreground">{ageLabel(ageMs)}</span>
	{#if pendingInput}
		<NeedsInputBadge {pendingInput} />
	{/if}
</div>
