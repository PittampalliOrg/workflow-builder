/**
 * Pure transcript-derive helpers shared by the session-detail page and the
 * unified Run Console's `SessionTranscript` component. Extracted verbatim from
 * `sessions/[id]/+page.svelte` so both surfaces render the CMA-style transcript
 * identically. No Svelte — just data → data transforms.
 */
import type { SessionEventEnvelope } from '$lib/types/sessions';

/** The transcript ("read") view collapses the raw stream down to User / Tool /
 * Agent rows. These types are hidden in transcript mode but kept in debug mode.
 * Tool results fold into their tool_use row's detail panel; model/usage events
 * surface their tokens inline via tool-pair token assignment. */
export const TRANSCRIPT_HIDDEN_TYPES: ReadonlySet<string> = new Set([
	'agent.thinking',
	'agent.thinking_delta',
	'agent.message_delta',
	'agent.tool_input_delta',
	'agent.tool_result',
	'agent.mcp_tool_result',
	'agent.custom_tool_result',
	'agent.context_usage',
	'agent.llm_usage',
	'agent.iteration',
	'agent.thread_context_compacted',
	'agent.thread_images_compacted',
	'span.model_request_start',
	'span.model_request_end',
	'session.status_running',
	'session.status_idle',
	'session.status_rescheduled',
	'session.status_errored',
	'session.reconciler_action',
	'session.runtime_config',
	'session.turn_started',
	'session.instructions_applied',
	'session.config_updated',
	'instance.metrics_summary',
	'llm_start',
	'llm_complete'
]);

export interface FilterEventsOptions {
	/** Debug mode shows every event type; transcript mode applies the hidden set. */
	debug: boolean;
	/** When non-empty, restrict to these event types ("All events" filter). */
	visibleKinds?: ReadonlySet<string>;
	/** Free-text search across event type + content text. */
	searchText?: string;
}

/** Filter the raw event list down to what the current view should show. */
export function filterDisplayEvents(
	events: SessionEventEnvelope[],
	opts: FilterEventsOptions
): SessionEventEnvelope[] {
	let list = events;
	if (!opts.debug) {
		// Sandbox provisioning events (`session.provisioning_*`) drive the
		// provisioning stepper, not the transcript — hide them by prefix.
		list = list.filter(
			(e) => !TRANSCRIPT_HIDDEN_TYPES.has(e.type) && !e.type.startsWith('session.provisioning_')
		);
	}
	if (opts.visibleKinds && opts.visibleKinds.size > 0) {
		const kinds = opts.visibleKinds;
		list = list.filter((e) => kinds.has(e.type));
	}
	const q = opts.searchText?.trim().toLowerCase();
	if (q) {
		list = list.filter((e) => {
			if (e.type.toLowerCase().includes(q)) return true;
			const d = e.data as Record<string, unknown>;
			const content = (d.content as Array<{ text?: string }>) ?? [];
			const text = content
				.map((c) => (typeof c?.text === 'string' ? c.text : ''))
				.join(' ')
				.toLowerCase();
			return text.includes(q);
		});
	}
	return list;
}

/** Sandbox provisioning timeline derived from the durable `session.provisioning_*`
 * events the capacity-observer pushed. Survives the pod, so a terminal session
 * still shows how its sandbox came up (admitted → … → running, with durations). */
export interface ProvisioningTimeline {
	phase: string;
	failedReason: string | null;
	marks: { phase: string; at: string; durationMs: number | null }[];
}

const PROV_PREFIX = 'session.provisioning_';

export function buildProvisioningTimeline(
	events: SessionEventEnvelope[]
): ProvisioningTimeline | null {
	const marks: ProvisioningTimeline['marks'] = [];
	let failedReason: string | null = null;
	for (const e of events) {
		if (!e.type.startsWith(PROV_PREFIX)) continue;
		const d = (e.data ?? {}) as Record<string, unknown>;
		const phase =
			typeof d.phase === 'string' && d.phase ? d.phase : e.type.slice(PROV_PREFIX.length);
		const at = typeof d.at === 'string' ? d.at : (e.processedAt ?? e.createdAt ?? '');
		const durationMs =
			typeof d.durationMs === 'number' && Number.isFinite(d.durationMs) ? d.durationMs : null;
		if (phase === 'failed' && typeof d.reason === 'string') failedReason = d.reason;
		// Dedupe by phase (idempotent ingest may re-deliver); keep the first.
		if (!marks.some((m) => m.phase === phase)) marks.push({ phase, at, durationMs });
	}
	if (marks.length === 0) return null;
	const overall = failedReason ? 'failed' : marks[marks.length - 1].phase;
	return { phase: overall, failedReason, marks };
}

/** A run of consecutive same-tool events collapsed into one row — CMA shows
 * "Web Search × 5" for 5 `agent.tool_use` events with the same tool name. */
export type BatchedEvent = {
	event: SessionEventEnvelope;
	children: SessionEventEnvelope[];
	count: number;
};

function toolNameOf(e: SessionEventEnvelope): string {
	const d = e.data as { name?: string; tool_name?: string };
	return d.name ?? d.tool_name ?? '';
}

function isToolEvent(type: string): boolean {
	return (
		type === 'agent.tool_use' ||
		type === 'agent.mcp_tool_use' ||
		type === 'agent.custom_tool_use'
	);
}

/** Collapse consecutive same-tool rows into batches (transcript mode); in debug
 * mode every event is its own batch of one. */
export function batchEvents(displayEvents: SessionEventEnvelope[], debug: boolean): BatchedEvent[] {
	if (debug) {
		return displayEvents.map((event) => ({ event, children: [event], count: 1 }));
	}
	const out: BatchedEvent[] = [];
	for (const e of displayEvents) {
		const isTool = isToolEvent(e.type);
		const name = toolNameOf(e);
		const last = out[out.length - 1];
		const lastIsTool = last && isToolEvent(last.event.type);
		const lastName = last ? toolNameOf(last.event) : '';
		if (isTool && lastIsTool && name === lastName && name) {
			last.count += 1;
			last.children.push(e);
			// Representative = latest invocation (its latest input wins in the
			// detail panel header).
			last.event = e;
		} else {
			out.push({ event: e, children: [e], count: 1 });
		}
	}
	return out;
}

/** A row in the rendered list — either a batch of events or an idle-gap
 * separator inserted between turns. */
export type ListRow =
	| { kind: 'batch'; key: string; batch: BatchedEvent }
	| { kind: 'separator'; key: string; sinceMs: number };

/** Threshold above which an idle gap before a `user.*` event becomes a visible
 * "Session idle · {duration}" separator. */
const IDLE_SEPARATOR_MS = 30_000;

/** Build the row list, inserting idle-gap separators between turns (transcript
 * mode only). In debug mode rows map 1:1 to batches. */
export function buildListRows(batchedEvents: BatchedEvent[], debug: boolean): ListRow[] {
	if (debug) {
		return batchedEvents.map((b) => ({ kind: 'batch' as const, key: String(b.event.id), batch: b }));
	}
	const out: ListRow[] = [];
	let prev: BatchedEvent | null = null;
	for (const b of batchedEvents) {
		if (prev && b.event.type.startsWith('user.')) {
			const sinceMs =
				new Date(b.event.createdAt).getTime() - new Date(prev.event.createdAt).getTime();
			if (Number.isFinite(sinceMs) && sinceMs >= IDLE_SEPARATOR_MS) {
				out.push({
					kind: 'separator' as const,
					key: `sep:${prev.event.id}:${b.event.id}`,
					sinceMs
				});
			}
		}
		out.push({ kind: 'batch' as const, key: String(b.event.id), batch: b });
		prev = b;
	}
	return out;
}

/** Human-readable idle-gap duration (e.g. "45s", "3m", "1h 5m"). */
export function fmtIdleGap(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
	if (ms < 86_400_000) {
		const h = Math.floor(ms / 3_600_000);
		const m = Math.floor((ms % 3_600_000) / 60_000);
		return m > 0 ? `${h}h ${m}m` : `${h}h`;
	}
	const d = Math.floor(ms / 86_400_000);
	const h = Math.floor((ms % 86_400_000) / 3_600_000);
	return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/** Every event type seen, in first-seen order — for the "All events" filter. */
export function collectEventTypes(events: SessionEventEnvelope[]): string[] {
	const seen: string[] = [];
	const set = new Set<string>();
	for (const e of events) {
		if (!set.has(e.type)) {
			set.add(e.type);
			seen.push(e.type);
		}
	}
	return seen;
}
