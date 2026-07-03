import type { RequestHandler } from "./$types";

import {
	getLatestGitOpsActivitySequence,
	listGitOpsActivityEvents,
	subscribeGitOpsActivityEvents,
} from "$lib/server/gitops/activity-events";
import { requirePlatformAdmin } from "$lib/server/platform-admin";

const HEARTBEAT_INTERVAL_MS = 15_000;

export const GET: RequestHandler = async ({ locals, request, url }) => {
	await requirePlatformAdmin(locals);

	const lastEventId = Number.parseInt(request.headers.get("last-event-id") ?? "", 10);
	const sinceParam = url.searchParams.get("since");
	let lastSequence =
		Number.isFinite(lastEventId) && lastEventId >= 0 ? lastEventId : Number.NaN;
	if (!Number.isFinite(lastSequence) && /^\d+$/.test(sinceParam ?? "")) {
		lastSequence = Number(sinceParam);
	}
	if (!Number.isFinite(lastSequence) && sinceParam === "latest") {
		lastSequence = await getLatestGitOpsActivitySequence();
	}
	if (!Number.isFinite(lastSequence)) lastSequence = 0;

	let cancelled = false;
	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
			let unlisten: (() => Promise<void>) | null = null;
			let draining = false;
			let drainAgain = false;

			function send(event: string, data: unknown, id?: number) {
				if (cancelled) return;
				const lines: string[] = [];
				if (id !== undefined) lines.push(`id: ${id}`);
				lines.push(`event: ${event}`);
				lines.push(`data: ${JSON.stringify(data)}`);
				lines.push("", "");
				try {
					controller.enqueue(encoder.encode(lines.join("\n")));
				} catch {
					cancelled = true;
				}
			}

			function comment(text: string) {
				if (cancelled) return;
				try {
					controller.enqueue(encoder.encode(`: ${text}\n\n`));
				} catch {
					cancelled = true;
				}
			}

			async function drain() {
				if (cancelled) return;
				if (draining) {
					drainAgain = true;
					return;
				}
				draining = true;
				try {
					do {
						drainAgain = false;
						const events = await listGitOpsActivityEvents({
							afterSequence: lastSequence,
							ascending: true,
							limit: 500,
						});
						for (const event of events) {
							send("gitops.event", event, event.sequence);
							lastSequence = Math.max(lastSequence, event.sequence);
						}
					} while (drainAgain && !cancelled);
				} catch (err) {
					send("error", {
						message: err instanceof Error ? err.message : String(err),
					});
				} finally {
					draining = false;
				}
			}

			function cleanup() {
				if (heartbeatTimer) clearInterval(heartbeatTimer);
				heartbeatTimer = null;
				if (unlisten) {
					const u = unlisten;
					unlisten = null;
					void u().catch(() => {
						/* ignore */
					});
				}
			}

			comment(" ".repeat(2048));
			send("gitops.ready", { since: lastSequence });
			await drain();

			if (!cancelled) {
				try {
					unlisten = await subscribeGitOpsActivityEvents(() => {
						void drain();
					});
					void drain();
				} catch (err) {
					send("error", {
						message: `LISTEN arm failed: ${err instanceof Error ? err.message : String(err)}`,
					});
				}
			}

			heartbeatTimer = setInterval(() => comment("heartbeat"), HEARTBEAT_INTERVAL_MS);
			request.signal.addEventListener("abort", () => {
				cancelled = true;
				cleanup();
				try {
					controller.close();
				} catch {
					/* ignore */
				}
			});
		},
		cancel() {
			cancelled = true;
		},
	});

	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		},
	});
};
