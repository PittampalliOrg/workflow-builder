import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getEnvironmentBuildActivity } from "$lib/server/environments/environment-image-builds";

const POLL_MS = 2_000;

const TERMINAL_STATUSES = new Set(["validated", "failed", "cancelled"]);

export const GET: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	let cancelled = false;
	request.signal.addEventListener("abort", () => {
		cancelled = true;
	});

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const encoder = new TextEncoder();
			const sentEventIds = new Set<string>();

			function send(event: string, data: unknown) {
				if (cancelled) return;
				try {
					controller.enqueue(
						encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
					);
				} catch {
					cancelled = true;
				}
			}

			function heartbeat(final = false) {
				send("heartbeat", {
					timestamp: new Date().toISOString(),
					final,
				});
			}

			try {
				controller.enqueue(encoder.encode(`: ${" ".repeat(2048)}\n\n`));
				while (!cancelled) {
					const activity = await getEnvironmentBuildActivity(params.buildId, {
						sync: true,
						forceTerminal: true,
					});
					if (!activity) {
						send("error", { error: "Environment build not found" });
						break;
					}

					send("snapshot", activity);
					for (const activityEvent of activity.events) {
						if (sentEventIds.has(activityEvent.id)) continue;
						sentEventIds.add(activityEvent.id);
						send("activity_event", activityEvent);
					}

					if (TERMINAL_STATUSES.has(activity.build.status)) {
						heartbeat(true);
						send("terminal", {
							buildId: activity.build.id,
							status: activity.build.status,
							completedAt: activity.build.completedAt,
							error: activity.build.error,
						});
						break;
					}

					heartbeat(false);
					await new Promise((resolve) => setTimeout(resolve, POLL_MS));
				}
			} catch (err) {
				send("stream_error", {
					error: err instanceof Error ? err.message : String(err),
				});
			} finally {
				cancelled = true;
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			}
		},
		cancel() {
			cancelled = true;
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
};
