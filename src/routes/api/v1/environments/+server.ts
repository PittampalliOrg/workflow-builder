import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationEnvironmentError } from "$lib/server/application/environment-management";

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		return json(
			await getApplicationAdapters().environments.list({
				query: url.searchParams,
				sessionProjectId: locals.session.projectId,
			}),
		);
	} catch (err) {
		handleEnvironmentError(err);
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		return json(
			await getApplicationAdapters().environments.create({
				userId: locals.session.userId,
				sessionProjectId: locals.session.projectId,
				body: await request.json().catch(() => ({})),
			}),
			{ status: 201 },
		);
	} catch (err) {
		handleEnvironmentError(err);
	}
};

function handleEnvironmentError(err: unknown): never {
	if (err instanceof ApplicationEnvironmentError) {
		throw error(err.status, err.message);
	}
	throw err;
}
