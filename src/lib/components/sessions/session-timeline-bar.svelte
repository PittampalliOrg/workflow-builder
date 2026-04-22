<script lang="ts">
	import type { SessionEventEnvelope } from '$lib/types/sessions';
	import { eventKindFor, type EventKind } from './event-type-pill.svelte';

	interface Props {
		events: SessionEventEnvelope[];
		selectedId: string | null;
		onSelect?: (id: string) => void;
	}

	let { events, selectedId, onSelect }: Props = $props();

	// Each segment corresponds to one event. Width is proportional to the
	// event's implied duration: for CMA-style events where duration_ms is
	// present we use it; otherwise we fall back to equal spacing.
	type Segment = {
		id: string;
		kind: EventKind;
		widthPct: number;
		title: string;
	};

	const segments = $derived.by<Segment[]>(() => {
		if (events.length === 0) return [];
		const durations = events.map((e) => {
			const data = e.data as { duration_ms?: number; durationMs?: number };
			const d = Number(data?.duration_ms ?? data?.durationMs ?? 0);
			return Number.isFinite(d) && d > 0 ? d : 1;
		});
		const total = durations.reduce((a, b) => a + b, 0) || 1;
		return events.map((e, i) => ({
			id: String(e.id),
			kind: eventKindFor(e.type),
			widthPct: Math.max(0.3, (durations[i] / total) * 100),
			title: e.type
		}));
	});

	const FILL: Record<EventKind, string> = {
		user: 'bg-rose-500',
		agent: 'bg-blue-500',
		thinking: 'bg-emerald-500',
		tool: 'bg-muted-foreground/40',
		result: 'bg-amber-500',
		model: 'bg-slate-500',
		status: 'bg-purple-500',
		span: 'bg-blue-400',
		hook: 'bg-indigo-500',
		mcp: 'bg-cyan-500',
		alert: 'bg-red-500',
		other: 'bg-muted-foreground/30'
	};

	const FILL_ACTIVE: Record<EventKind, string> = {
		user: 'bg-rose-400',
		agent: 'bg-blue-400',
		thinking: 'bg-emerald-400',
		tool: 'bg-muted-foreground/70',
		result: 'bg-amber-400',
		model: 'bg-slate-400',
		status: 'bg-purple-400',
		span: 'bg-blue-300',
		hook: 'bg-indigo-400',
		mcp: 'bg-cyan-400',
		alert: 'bg-red-400',
		other: 'bg-muted-foreground/60'
	};
</script>

<div class="flex h-4 w-full items-stretch gap-px overflow-hidden rounded bg-muted/20 px-px py-px">
	{#each segments as seg (seg.id)}
		<button
			type="button"
			title="{seg.kind} · {seg.title}"
			class="rounded-[1px] transition-opacity hover:opacity-100 {selectedId === seg.id
				? FILL_ACTIVE[seg.kind] + ' opacity-100'
				: FILL[seg.kind] + ' opacity-70'}"
			style="width: {seg.widthPct.toFixed(3)}%"
			onclick={() => onSelect?.(seg.id)}
		></button>
	{/each}
</div>
