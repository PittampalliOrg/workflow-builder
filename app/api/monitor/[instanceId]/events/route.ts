import type { WorkflowDetail } from "@/lib/types/workflow-ui";

export const dynamic = "force-dynamic";

function isActiveStatus(status: WorkflowDetail["status"] | undefined): boolean {
	return status === "RUNNING" || status === "PENDING" || status === "SUSPENDED";
}

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ instanceId: string }> },
) {
	const { instanceId } = await params;
	const url = new URL(request.url);
	const pollMs = Math.max(
		1000,
		Number.parseInt(url.searchParams.get("pollMs") || "2000", 10) || 2000,
	);
	const detailUrl = new URL(
		`/api/monitor/${instanceId}`,
		request.url,
	).toString();
	const encoder = new TextEncoder();
	let closed = false;

	const stream = new ReadableStream({
		async start(controller) {
			let lastSnapshot = "";

			const send = (event: string, data: unknown) => {
				if (closed) return;
				controller.enqueue(
					encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
				);
			};

			const poll = async () => {
				while (!closed) {
					try {
						const response = await fetch(detailUrl, {
							method: "GET",
							cache: "no-store",
						});
						if (!response.ok) {
							throw new Error(`Monitor fetch failed (${response.status})`);
						}
						const detail = (await response.json()) as WorkflowDetail;
						const snapshot = JSON.stringify({
							status: detail.status,
							phase: detail.customStatus?.phase ?? null,
							progress: detail.customStatus?.progress ?? null,
							currentNodeName: detail.daprStatus?.currentNodeName ?? null,
							error: detail.error ?? detail.daprStatus?.error ?? null,
							rerunOfExecutionId: detail.rerunOfExecutionId ?? null,
							rerunFromEventId: detail.rerunFromEventId ?? null,
						});

						if (snapshot !== lastSnapshot) {
							send("workflow", detail);
							lastSnapshot = snapshot;
						}

						if (!isActiveStatus(detail.status)) {
							send("complete", {
								instanceId: detail.instanceId,
								status: detail.status,
							});
							closed = true;
							controller.close();
							return;
						}
					} catch (error) {
						send("error", {
							message:
								error instanceof Error
									? error.message
									: "Failed to stream workflow state",
						});
					}

					await new Promise((resolve) => setTimeout(resolve, pollMs));
				}
			};

			send("ready", { instanceId, pollMs });
			void poll();
		},
		cancel() {
			closed = true;
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		},
	});
}
