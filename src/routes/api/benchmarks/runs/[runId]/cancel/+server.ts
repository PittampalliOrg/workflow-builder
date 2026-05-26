import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	cancelBenchmarkRun,
	getSwebenchCoordinatorUrl,
} from "$lib/server/benchmarks/service";
import { daprFetch } from "$lib/server/dapr-client";
import { env } from "$env/dynamic/private";

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Benchmark run not found");
	const run = await cancelBenchmarkRun(locals.session.projectId, params.runId, {
		terminalCleanup: "background",
	});
	if (!run) return error(404, "Benchmark run not found");

	const internalApiToken = env.INTERNAL_API_TOKEN;
	if (internalApiToken) {
		void (async () => {
			try {
				const res = await daprFetch(
					`${getSwebenchCoordinatorUrl()}/api/v1/benchmark-runs/${params.runId}/cancel`,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Internal-Token": internalApiToken,
						},
						body: JSON.stringify({ reason: "cancelled by user" }),
						maxRetries: 0,
						signal: AbortSignal.timeout(120_000),
					},
				);
				if (!res.ok) {
					console.warn(
						`Coordinator benchmark cancel failed for ${params.runId}: ${res.status} ${await res.text()}`,
					);
				}
			} catch (err) {
				console.warn(
					`Coordinator benchmark cancel failed for ${params.runId}:`,
					err instanceof Error ? err.message : err,
				);
			}
		})();
	}

	return json({ run, coordinatorCancelScheduled: Boolean(internalApiToken) });
};
