<script lang="ts">
	import type { SessionEventEnvelope } from '$lib/types/sessions';
	import { eventKindFor, type EventKind } from './event-type-pill.svelte';
	import EventTypePill from './event-type-pill.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';

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
		elapsedLabel: string;
	};

	const sessionStartMs = $derived.by(() => {
		if (events.length === 0) return null;
		const first = events[0];
		const t = new Date(first.createdAt).getTime();
		return Number.isFinite(t) ? t : null;
	});

	function fmtElapsed(ms: number): string {
		if (ms < 0) ms = 0;
		const t = Math.floor(ms / 1000);
		const h = Math.floor(t / 3600);
		const m = Math.floor((t % 3600) / 60);
		const s = t % 60;
		return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
	}

	function friendlyTitle(e: SessionEventEnvelope): string {
		const kind = eventKindFor(e.type);
		if (kind === 'tool' || kind === 'result') {
			const d = e.data as { name?: string; tool_name?: string };
			return String(d.name ?? d.tool_name ?? e.type);
		}
		if (e.type.startsWith('session.status_')) return e.type.replace('session.status_', 'Status: ');
		if (e.type.startsWith('span.')) return e.type.replace('span.', 'Span: ');
		if (e.type.startsWith('adk.')) return e.type.replace('adk.', 'ADK ');
		return e.type;
	}

	const segments = $derived.by<Segment[]>(() => {
		if (events.length === 0) return [];
		const durations = events.map((e) => {
			const data = e.data as { duration_ms?: number; durationMs?: number };
			const d = Number(data?.duration_ms ?? data?.durationMs ?? 0);
			return Number.isFinite(d) && d > 0 ? d : 1;
		});
		const total = durations.reduce((a, b) => a + b, 0) || 1;
		return events.map((e, i) => {
			const ts = new Date(e.createdAt).getTime();
			const elapsed = sessionStartMs !== null && Number.isFinite(ts) ? ts - sessionStartMs : 0;
			return {
				id: String(e.id),
				kind: eventKindFor(e.type),
				widthPct: Math.max(0.3, (durations[i] / total) * 100),
				title: friendlyTitle(e),
				elapsedLabel: fmtElapsed(elapsed)
			};
		});
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
		adk: 'bg-lime-500',
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
		adk: 'bg-lime-400',
		alert: 'bg-red-400',
		other: 'bg-muted-foreground/60'
	};
</script>

<div class="flex h-4 w-full items-stretch gap-px overflow-hidden rounded bg-muted/20 px-px py-px">
	{#each segments as seg (seg.id)}
		<Tooltip.Root delayDuration={150}>
			<Tooltip.Trigger
				class="rounded-[1px] transition-opacity hover:opacity-100 {selectedId === seg.id
					? FILL_ACTIVE[seg.kind] + ' opacity-100'
					: FILL[seg.kind] + ' opacity-70'}"
				style="width: {seg.widthPct.toFixed(3)}%"
				onclick={() => onSelect?.(seg.id)}
			></Tooltip.Trigger>
			<Tooltip.Content class="flex items-center gap-2 px-2 py-1 text-[11px]">
				<EventTypePill kind={seg.kind} size="xs" />
				<span class="font-medium">{seg.title}</span>
				<span class="font-mono text-muted-foreground">{seg.elapsedLabel}</span>
			</Tooltip.Content>
		</Tooltip.Root>
	{/each}
</div>
