import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		const result = await getApplicationAdapters().workflowBrowserArtifacts.listArtifacts({
			executionId: params.executionId,
			userId: locals.session.userId,
			projectId: locals.session.projectId,
		});
		if (result.status === "error") {
			return error(result.httpStatus, result.message);
		}
		return json(result.body);
	} catch (err) {
		if (isHttpErrorLike(err)) throw err;
		throw error(
			500,
			err instanceof Error ? err.message : "Failed to load browser artifacts",
		);
	}
};

function isHttpErrorLike(err: unknown): err is { status: number } {
	return (
		typeof err === "object" &&
		err !== null &&
		"status" in err &&
		typeof (err as { status?: unknown }).status === "number"
	);
}
