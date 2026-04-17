import { writable, type Readable } from "svelte/store";
import type {
	SessionDetail,
	SessionEventEnvelope,
} from "$lib/types/sessions";

export interface SessionStreamState {
	isConnected: boolean;
	error: string | null;
	session: SessionDetail | null;
	events: SessionEventEnvelope[];
	lastSequence: number;
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
	};
	const { subscribe, update } = writable<SessionStreamState>(initial);

	let es: EventSource | null = null;

	function patch(mutator: (state: SessionStreamState) => SessionStreamState) {
		update((s) => mutator(s));
	}

	function connect() {
		es = new EventSource(`/api/v1/sessions/${sessionId}/events/stream`);
		es.onopen = () => {
			patch((s) => ({ ...s, isConnected: true, error: null }));
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
		// Catch-all for typed session events (agent.message, agent.tool_use, etc.)
		const genericHandler = (ev: MessageEvent) => {
			try {
				const envelope = JSON.parse(ev.data) as SessionEventEnvelope;
				patch((s) => ({
					...s,
					events: [...s.events, envelope].slice(-500),
					lastSequence: Math.max(s.lastSequence, envelope.sequence),
				}));
			} catch {
				/* ignore */
			}
		};
		// Subscribe to every event type we care about.
		const types = [
			"agent.message",
			"agent.thinking",
			"agent.tool_use",
			"agent.mcp_tool_use",
			"agent.custom_tool_use",
			"agent.tool_result",
			"agent.mcp_tool_result",
			"agent.thread_context_compacted",
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
