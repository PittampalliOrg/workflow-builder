/**
 * E2: tiny cross-component bridge from the E1 live run feed (SSE, one
 * connection owned by PreviewRunFeedPanel) to per-preview UI that wants to
 * react to "something ran in preview X" — e.g. the read-proxy runs panel
 * re-fetches its execution list when its preview sees an event, instead of
 * opening a second EventSource. Module-level $state singleton; publishing is
 * harmless when nobody listens (feed flag on, proxy flag off).
 */

export type PreviewRunEventPing = {
	previewName: string;
	eventType: string;
	executionId: string | null;
	at: number;
};

let last = $state<PreviewRunEventPing | null>(null);
let counts = $state<Record<string, number>>({});

export const previewRunEvents = {
	get last(): PreviewRunEventPing | null {
		return last;
	},
	/** Monotonic per-preview event counter — cheap $effect dependency. */
	countFor(previewName: string): number {
		return counts[previewName] ?? 0;
	},
	publish(ping: PreviewRunEventPing): void {
		last = ping;
		counts = { ...counts, [ping.previewName]: (counts[ping.previewName] ?? 0) + 1 };
	},
};
