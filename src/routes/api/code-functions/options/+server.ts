import { error, json, type RequestHandler } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationCodeFunctionOptionsError } from "$lib/server/application/code-function-options";

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) {
		throw error(401, "Authentication required");
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, "Invalid JSON body");
	}

	try {
		return json(
			await getApplicationAdapters().codeFunctionOptions.getOptions({
				userId: locals.session.userId,
				body,
			}),
		);
	} catch (err) {
		if (err instanceof ApplicationCodeFunctionOptionsError) {
			throw error(err.status, err.message);
		}
		throw err;
	}
};
