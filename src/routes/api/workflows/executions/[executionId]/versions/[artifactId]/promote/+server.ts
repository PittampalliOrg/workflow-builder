/**
 * POST /api/workflows/executions/[executionId]/versions/[artifactId]/promote
 *
 * Applies a chosen source-bundle version on demand. The application service
 * handles scope, promotion gate, helper execution, and durable metadata.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	const result =
		await getApplicationAdapters().workflowCodeVersionPromotion.promote({
			executionId: params.executionId,
			artifactId: params.artifactId,
			userId: locals.session.userId,
			projectId: locals.session.projectId ?? null,
			body: await request.json().catch(() => ({})),
		});

	if (result.status === "error") return error(result.httpStatus, result.message);
	return json(result.body, { status: result.httpStatus ?? 200 });
};
