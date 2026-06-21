<script lang="ts">
	/**
	 * Sandbox provisioning stepper — visualizes the gap between a session being
	 * dispatched (status=rescheduling) and the agent's first event, using the
	 * capacity-observer timeline (admitted ▸ scheduled ▸ pulling ▸ initialized ▸
	 * running, with per-phase durations). Driven either by a live `/provisioning`
	 * poll or by `session.provisioning_*` events streamed over SSE.
	 */
	import { CheckCircle2, Loader2, XCircle } from '@lucide/svelte';

	type Mark = { phase: string; at: string; durationMs: number | null };

	let {
		timeline = [],
		phase,
		failedReason = null,
		compact = false
	}: {
		timeline?: Mark[];
		phase?: string;
		failedReason?: string | null;
		compact?: boolean;
	} = $props();

	// Canonical display order + short labels. The observer emits the fine-grained
	// phases; we render the full ladder and light up the ones we've reached.
	const STEPS: { key: string; label: string; short: string }[] = [
		{ key: 'admitted', label: 'Admitted', short: 'Adm' },
		{ key: 'scheduled', label: 'Scheduled', short: 'Sch' },
		{ key: 'pulling', label: 'Pulling image', short: 'Pull' },
		{ key: 'initialized', label: 'Initialized', short: 'Init' },
		{ key: 'running', label: 'Running', short: 'Run' }
	];

	// Some timelines carry a `pulled` mark between pulling and initialized; fold it
	// into the `pulling` step's duration rather than showing a separate dot.
	const reached = $derived(new Set(timeline.map((m) => m.phase)));
	const failed = $derived(!!failedReason || phase === 'failed');

	// The current step = the latest reached step in canonical order (or the
	// declared overall phase when no timeline yet).
	const currentKey = $derived.by(() => {
		for (let i = STEPS.length - 1; i >= 0; i--) {
			if (reached.has(STEPS[i].key)) return STEPS[i].key;
		}
		return phase ?? null;
	});

	function durationFor(key: string): number | null {
		const m = timeline.find((t) => t.phase === key);
		return m?.durationMs ?? null;
	}
	function fmtDur(ms: number | null): string {
		if (ms == null) return '';
		if (ms < 1000) return `${ms}ms`;
		const s = ms / 1000;
		return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
	}

	type State = 'done' | 'current' | 'pending' | 'failed';
	function stateOf(key: string): State {
		if (failed && key === currentKey) return 'failed';
		if (key === 'running' && reached.has('running')) return 'done';
		if (key === currentKey) return reached.has(key) && key !== 'running' ? 'current' : 'current';
		return reached.has(key) ? 'done' : 'pending';
	}
</script>

<div class="flex {compact ? 'gap-1' : 'flex-col gap-1.5'}">
	<ol class="flex items-center {compact ? 'gap-0.5' : 'gap-1'}">
		{#each STEPS as step, i (step.key)}
			{@const st = stateOf(step.key)}
			{#if i > 0}
				<li
					aria-hidden="true"
					class="h-px {compact ? 'w-2' : 'w-4'} shrink-0 {reached.has(step.key)
						? 'bg-teal-400/70'
						: 'bg-border'}"
				></li>
			{/if}
			<li
				class="flex items-center gap-1"
				title="{step.label}{durationFor(step.key) != null ? ` · ${fmtDur(durationFor(step.key))}` : ''}"
			>
				{#if st === 'failed'}
					<XCircle class="size-3 shrink-0 text-red-500" />
				{:else if st === 'done'}
					<CheckCircle2 class="size-3 shrink-0 text-teal-500" />
				{:else if st === 'current'}
					<Loader2 class="size-3 shrink-0 animate-spin text-amber-500" />
				{:else}
					<span class="size-2 shrink-0 rounded-full border border-border"></span>
				{/if}
				{#if !compact}
					<span
						class="text-[11px] {st === 'pending'
							? 'text-muted-foreground/60'
							: st === 'failed'
								? 'text-red-600 dark:text-red-400'
								: 'text-foreground'}"
					>
						{step.label}{#if durationFor(step.key) != null}<span
								class="ml-1 text-[10px] text-muted-foreground/70">{fmtDur(durationFor(step.key))}</span
							>{/if}
					</span>
				{/if}
			</li>
		{/each}
	</ol>
	{#if failedReason}
		<p class="text-[11px] text-red-600 dark:text-red-400">{failedReason}</p>
	{/if}
</div>
