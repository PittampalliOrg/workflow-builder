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

	// Each segment corresponds to one event and is sized by the event's
	// duration. Sources, in priority order:
	//   1. `data.duration_ms` (set by the agent for tool calls, hook
	//      decisions, MCP calls — i.e. anything that knows how long it
	//      took)
	//   2. time-to-next-event, CAPPED at FALLBACK_CAP_MS so a long idle
	//      gap (the typical "session went quiet" pattern) doesn't
	//      consume the entire bar
	//   3. SHORT_FALLBACK_MS for the last event with no explicit duration
	//
	// CMA renders the timeline this way too — idle gaps appear as wider
	// neutral-coloured sections rather than dominating the bar.
	const FALLBACK_CAP_MS = 10_000;
	const SHORT_FALLBACK_MS = 1_000;

	type Segment = {
		id: string;
		kind: EventKind;
		widthPct: number;
		title: string;
		elapsedLabel: string;
		durationLabel: string;
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

	function fmtDuration(ms: number): string {
		if (ms < 1000) return `${Math.round(ms)}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		const mins = Math.floor(ms / 60_000);
		const secs = Math.round((ms % 60_000) / 1000);
		return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
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
		const eventTimes = events.map((e) => {
			const t = new Date(e.createdAt).getTime();
			return Number.isFinite(t) ? t : 0;
		});
		const durations = events.map((e, i) => {
			const data = e.data as { duration_ms?: number; durationMs?: number };
			const explicit = Number(data?.duration_ms ?? data?.durationMs ?? 0);
			if (Number.isFinite(explicit) && explicit > 0) return explicit;
			if (i < events.length - 1) {
				const gap = eventTimes[i + 1] - eventTimes[i];
				if (Number.isFinite(gap) && gap > 0) {
					return Math.min(gap, FALLBACK_CAP_MS);
				}
			}
			return SHORT_FALLBACK_MS;
		});
		const total = durations.reduce((a, b) => a + b, 0) || 1;
		return events.map((e, i) => {
			const ts = eventTimes[i];
			const elapsed = sessionStartMs !== null ? ts - sessionStartMs : 0;
			return {
				id: String(e.id),
				kind: eventKindFor(e.type),
				widthPct: Math.max(0.3, (durations[i] / total) * 100),
				title: friendlyTitle(e),
				elapsedLabel: fmtElapsed(elapsed),
				durationLabel: fmtDuration(durations[i])
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
				<span class="font-mono text-muted-foreground">{seg.durationLabel}</span>
				<span class="font-mono text-muted-foreground/70">@ {seg.elapsedLabel}</span>
			</Tooltip.Content>
		</Tooltip.Root>
	{/each}
</div>
