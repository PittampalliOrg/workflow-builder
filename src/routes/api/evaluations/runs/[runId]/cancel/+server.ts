import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { env } from "$env/dynamic/private";
import {
	cancelEvaluationRun,
	getEvaluationCoordinatorUrl,
} from "$lib/server/evaluations/service";
import { daprFetch } from "$lib/server/dapr-client";

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation run not found");
	const run = await cancelEvaluationRun(locals.session.projectId, params.runId);

	let coordinatorCancelError: string | null = null;
	if (env.INTERNAL_API_TOKEN) {
		try {
			const res = await daprFetch(
				`${getEvaluationCoordinatorUrl()}/api/v1/evaluation-runs/${params.runId}/cancel`,
				{
					method: "POST",
					headers: { "X-Internal-Token": env.INTERNAL_API_TOKEN },
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
