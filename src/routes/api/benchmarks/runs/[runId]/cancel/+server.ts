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

	let coordinatorCancelError: string | null = null;
	if (env.INTERNAL_API_TOKEN) {
		try {
			const res = await daprFetch(
				`${getSwebenchCoordinatorUrl()}/api/v1/benchmark-runs/${params.runId}/cancel`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Internal-Token": env.INTERNAL_API_TOKEN,
					},
					body: JSON.stringify({ reason: "cancelled by user" }),
					maxRetries: 0,
				},
			);
			if (!res.ok) coordinatorCancelError = await res.text();
		} catch (err) {
			coordinatorCancelError = err instanceof Error ? err.message : String(err);
		}
	}

	return json({ run, coordinatorCancelError });
};
