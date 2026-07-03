import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationEnvironmentError } from "$lib/server/application/environment-management";

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		return json(
			await getApplicationAdapters().environments.duplicate({
				id: params.id,
				userId: locals.session.userId,
				sessionProjectId: locals.session.projectId,
				body: await request.json().catch(() => ({})),
			}),
			{ status: 201 },
		);
	} catch (err) {
		if (err instanceof ApplicationEnvironmentError) {
			throw error(err.status, err.message);
		}
		throw err;
	}
};
