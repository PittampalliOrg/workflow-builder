import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationEnvironmentError } from "$lib/server/application/environment-management";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		return json(
			await getApplicationAdapters().environments.getVersion({
				id: params.id,
				versionParam: params.version,
			}),
		);
	} catch (err) {
		handleEnvironmentError(err);
	}
};

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		return json(
			await getApplicationAdapters().environments.restoreVersion({
				id: params.id,
				versionParam: params.version,
				userId: locals.session.userId,
			}),
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
