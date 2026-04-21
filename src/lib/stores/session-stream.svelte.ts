import { writable, type Readable } from "svelte/store";
import type {
	SessionDetail,
	SessionEventEnvelope,
} from "$lib/types/sessions";

/** Kind of in-flight partial assistant content — mirrors the agent-side
 * delta event type without the `agent.` prefix. */
export type InFlightKind = "message" | "thinking" | "tool_input";

export interface InFlightPartial {
	kind: InFlightKind;
	text: string;
	// For tool_input deltas — lets the UI associate streaming JSON with the
	// forthcoming agent.tool_use envelope.
	toolUseId?: string;
	updatedAt: number;
}

export interface SessionStreamState {
	isConnected: boolean;
	error: string | null;
	session: SessionDetail | null;
	events: SessionEventEnvelope[];
	lastSequence: number;
	// True while a history-catchup fetch is running after a (re)connect. UI
	// can show a "catching up…" indicator during this window.
	isConsolidating: boolean;
	/** Partial assistant content accumulating from *_delta events. Keyed by
	 * `${contentBlockIndex}` (block index is unique per LLM call; the agent
	 * side never interleaves calls on the same session, so collisions only
	 * happen if a new call starts before we clear the prior one — which the
	 * `agent.message` arrival handles). */
	inFlightPartials: Record<string, InFlightPartial>;
}

export type SessionStreamStore = Readable<SessionStreamState> & {
	dispose: () => void;
};

export function createSessionStream(sessionId: string): SessionStreamStore {
	const initial: SessionStreamState = {
		isConnected: false,
		error: null,
		session: null,
		events: [],
		lastSequence: 0,
		isConsolidating: false,
		inFlightPartials: {},
	};
	const { subscribe, update } = writable<SessionStreamState>(initial);

	let es: EventSource | null = null;
	// Track IDs we've seen across both the history fetch and the live stream
	// so we can dedupe after reconnect per the CMA consolidation pattern:
	// history covers the gap between disconnect and reconnect; the live
	// stream picks up from where it dropped off.
	const seenIds = new Set<string>();

	function patch(mutator: (state: SessionStreamState) => SessionStreamState) {
		update((s) => mutator(s));
	}

	async function consolidate(afterSequence: number) {
		// Fetch any events we missed while the stream was (re)connecting, dedupe
		// by envelope id, and splice into the events array. Safe to call on the
		// first connect too — afterSequence=0 returns everything since the
		// session started, which matches a browser refresh's semantics.
		patch((s) => ({ ...s, isConsolidating: true }));
		try {
			const qs = afterSequence > 0 ? `?afterSequence=${afterSequence}` : "";
			const res = await fetch(`/api/v1/sessions/${sessionId}/events${qs}`);
			if (!res.ok) return;
			const body = (await res.json()) as { events?: SessionEventEnvelope[] };
			const fresh = Array.isArray(body.events) ? body.events : [];
			if (fresh.length === 0) return;
			patch((s) => {
				const merged = [...s.events];
				let maxSeq = s.lastSequence;
				for (const ev of fresh) {
					if (seenIds.has(ev.id)) continue;
					seenIds.add(ev.id);
					merged.push(ev);
					if (ev.sequence > maxSeq) maxSeq = ev.sequence;
				}
				// Keep history ordered by sequence — the live stream appends
				// append-only, but catchup may land out-of-order with live events
				// written in between. Stable sort preserves live ordering within
				// ties.
				merged.sort((a, b) => a.sequence - b.sequence);
				return {
					...s,
					events: merged.slice(-500),
					lastSequence: maxSeq,
				};
			});
		} catch (err) {
			console.warn("[session-stream] consolidation fetch failed:", err);
		} finally {
			patch((s) => ({ ...s, isConsolidating: false }));
		}
	}

	function connect() {
		es = new EventSource(`/api/v1/sessions/${sessionId}/events/stream`);
		es.onopen = () => {
			patch((s) => ({ ...s, isConnected: true, error: null }));
			// Every (re)connect triggers a consolidation hop. On first connect
			// this also primes lastSequence; on reconnect it fills the gap.
			let lastSeq = 0;
			update((s) => {
				lastSeq = s.lastSequence;
				return s;
			});
			void consolidate(lastSeq);
		};
		es.onerror = () => {
			patch((s) => ({ ...s, isConnected: false, error: "stream disconnected" }));
			// Browser auto-retries; we just reflect state.
		};
		// Snapshot (session row)
		es.addEventListener("session.snapshot", (ev) => {
			try {
				const payload = JSON.parse((ev as MessageEvent).data) as {
					session: SessionDetail;
				};
				patch((s) => ({ ...s, session: payload.session }));
			} catch {
				/* ignore */
			}
		});
		es.addEventListener("session.terminated", (ev) => {
			try {
				const payload = JSON.parse((ev as MessageEvent).data) as {
					session: SessionDetail;
				};
				patch((s) => ({ ...s, session: payload.session }));
			} catch {
				/* ignore */
			}
			es?.close();
			es = null;
			patch((s) => ({ ...s, isConnected: false }));
		});
		es.addEventListener("error", (ev) => {
			const payload = (ev as MessageEvent).data;
			if (typeof payload === "string") {
				try {
					const parsed = JSON.parse(payload) as { message?: string };
					patch((s) => ({ ...s, error: parsed.message ?? "stream error" }));
				} catch {
					/* ignore */
				}
			}
		});
		// Delta events carry partial assistant content. They're still stored in
		// `events` (so sequence ordering + debug view show them) but also fold
		// into `inFlightPartials[block_index]` which the detail panel reads to
		// render a streaming bubble. `agent.message` / `agent.thinking` /
		// `agent.tool_use` arrival evicts the matching partial.
		const DELTA_TO_KIND: Record<string, InFlightKind> = {
			"agent.message_delta": "message",
			"agent.thinking_delta": "thinking",
			"agent.tool_input_delta": "tool_input",
		};
		const FINAL_TO_KIND: Record<string, InFlightKind> = {
			"agent.message": "message",
			"agent.thinking": "thinking",
			"agent.tool_use": "tool_input",
		};

		function applyDelta(
			s: SessionStreamState,
			envelope: SessionEventEnvelope,
		): SessionStreamState {
			const kind = DELTA_TO_KIND[envelope.type];
			if (!kind) return s;
			const data = envelope.data as {
				content_block_index?: number;
				text?: string;
				partial_json?: string;
				tool_use_id?: string;
			};
			const idx = Number(data.content_block_index ?? 0);
			const chunk = data.text ?? data.partial_json ?? "";
			const key = `${idx}`;
			const prior = s.inFlightPartials[key];
			const nextPartial: InFlightPartial = {
				kind,
				text: (prior?.text ?? "") + chunk,
				toolUseId: data.tool_use_id ?? prior?.toolUseId,
				updatedAt: Date.now(),
			};
			return {
				...s,
				inFlightPartials: { ...s.inFlightPartials, [key]: nextPartial },
			};
		}

		function clearFinalized(
			s: SessionStreamState,
			envelope: SessionEventEnvelope,
		): SessionStreamState {
			const kind = FINAL_TO_KIND[envelope.type];
			if (!kind) return s;
			// The agent side doesn't echo content_block_index on the final
			// envelope, so we clear every partial of the matching kind. This is
			// correct because a given LLM call only emits one content block per
			// kind of terminal text event at a time (message: one assistant
			// content block; thinking: one thinking block per call; tool_use:
			// multiple but each gets its own envelope and the index mapping is
			// no longer visible after flush).
			const next: Record<string, InFlightPartial> = {};
			for (const [k, v] of Object.entries(s.inFlightPartials)) {
				if (v.kind !== kind) next[k] = v;
			}
			return { ...s, inFlightPartials: next };
		}

		// Catch-all for typed session events (agent.message, agent.tool_use, etc.)
		const genericHandler = (ev: MessageEvent) => {
			try {
				const envelope = JSON.parse(ev.data) as SessionEventEnvelope;
				if (seenIds.has(envelope.id)) return;
				seenIds.add(envelope.id);
				patch((s) => {
					let next: SessionStreamState = {
						...s,
						events: [...s.events, envelope].slice(-500),
						lastSequence: Math.max(s.lastSequence, envelope.sequence),
					};
					if (envelope.type in DELTA_TO_KIND) {
						next = applyDelta(next, envelope);
					} else if (envelope.type in FINAL_TO_KIND) {
						next = clearFinalized(next, envelope);
					}
					return next;
				});
			} catch {
				/* ignore */
			}
		};
		// Subscribe to every event type we care about.
		const types = [
			"agent.message",
			"agent.message_delta",
			"agent.thinking",
			"agent.thinking_delta",
			"agent.tool_use",
			"agent.tool_input_delta",
			"agent.mcp_tool_use",
			"agent.custom_tool_use",
			"agent.tool_result",
			"agent.mcp_tool_result",
			"agent.thread_context_compacted",
			"agent.llm_usage",
			"session.status_running",
			"session.status_idle",
			"session.status_rescheduled",
			"session.error",
			"span.model_request_start",
			"span.model_request_end",
			"user.message",
			"user.interrupt",
			"user.tool_confirmation",
			"user.custom_tool_result",
		];
		for (const type of types) {
			es.addEventListener(type, genericHandler as EventListener);
		}
	}

	function dispose() {
		if (es) {
			es.close();
			es = null;
		}
		patch((s) => ({ ...s, isConnected: false }));
	}

	connect();

	return {
		subscribe,
		dispose,
	};
}
