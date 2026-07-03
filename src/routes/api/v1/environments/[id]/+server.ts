import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationEnvironmentError } from "$lib/server/application/environment-management";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		return json(await getApplicationAdapters().environments.get({ id: params.id }));
	} catch (err) {
		handleEnvironmentError(err);
	}
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		return json(
			await getApplicationAdapters().environments.update({
				id: params.id,
				userId: locals.session.userId,
				body: await request.json().catch(() => ({})),
			}),
		);
	} catch (err) {
		handleEnvironmentError(err);
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		return json(await getApplicationAdapters().environments.archive({ id: params.id }));
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
