import type {
	PreviewRunEvent,
	PreviewRunFeedPort,
	PreviewRunTarget,
} from "$lib/server/application/ports";

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_PREVIEW_REFRESH_MS = 20_000;

export type PreviewRunFeedDeps = {
	feed: PreviewRunFeedPort;
	/** Lists the previews to tail (ready Tier-2 vclusters), name + browsable url. */
	listPreviews: () => Promise<PreviewRunTarget[]>;
	heartbeatIntervalMs?: number;
	previewRefreshIntervalMs?: number;
};

/**
 * Dev-hub "runs across environments" feed (E1). Emits an SSE stream that tails
 * every active preview's run stream over the shared NATS and re-scans the
 * preview set periodically so new/torn-down previews join/leave the feed. All
 * consumers are read-only; nothing is written back to any preview.
 */
export class ApplicationPreviewRunFeedService {
	constructor(private readonly deps: PreviewRunFeedDeps) {}

	createEventStream(): ReadableStream<Uint8Array> {
		const deps = this.deps;
		const heartbeatMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
		const refreshMs = deps.previewRefreshIntervalMs ?? DEFAULT_PREVIEW_REFRESH_MS;
		let cancelled = false;
		let cleanup: (() => Promise<void>) | null = null;

		return new ReadableStream<Uint8Array>({
			async start(controller) {
				const encoder = new TextEncoder();
				let unsubscribe: (() => Promise<void>) | null = null;
				let subscribedKey = "";
				let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
				let refreshTimer: ReturnType<typeof setInterval> | null = null;

				function send(event: string, data: unknown) {
					if (cancelled) return;
					const payload = typeof data === "string" ? data : JSON.stringify(data);
					try {
						controller.enqueue(encoder.encode(`event: ${event}\ndata: ${payload}\n\n`));
					} catch {
						cancelled = true;
					}
				}
				function sendComment(text: string) {
					if (cancelled) return;
					try {
						controller.enqueue(encoder.encode(`: ${text}\n\n`));
					} catch {
						cancelled = true;
					}
				}

				async function resubscribe() {
					if (cancelled) return;
					let previews: PreviewRunTarget[];
					try {
						previews = await deps.listPreviews();
					} catch (err) {
						send("feed-error", { error: err instanceof Error ? err.message : String(err) });
						return;
					}
					const key = previews.map((p) => p.name).sort().join(",");
					if (key === subscribedKey && unsubscribe) return; // no change
					subscribedKey = key;
					const previous = unsubscribe;
					unsubscribe = null;
					if (previous) await previous().catch(() => {});
					send("previews", { previews });
					if (previews.length === 0) return;
					unsubscribe = await deps.feed.subscribe({
						previews,
						onEvent: (event: PreviewRunEvent) => send("run", event),
						onError: (previewName, error) =>
							send("feed-error", {
								previewName,
								error: error instanceof Error ? error.message : String(error),
							}),
					});
				}

				// Pad so proxies flush the stream immediately.
				sendComment(" ".repeat(2048));
				send("hello", { at: new Date().toISOString() });
				await resubscribe();

				heartbeatTimer = setInterval(() => sendComment("heartbeat"), heartbeatMs);
				refreshTimer = setInterval(() => {
					void resubscribe();
				}, refreshMs);

				cleanup = async () => {
					cancelled = true;
					if (heartbeatTimer) clearInterval(heartbeatTimer);
					if (refreshTimer) clearInterval(refreshTimer);
					if (unsubscribe) await unsubscribe().catch(() => {});
				};
			},
			async cancel() {
				cancelled = true;
				if (cleanup) await cleanup();
			},
		});
	}
}
