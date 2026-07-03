import { error, json, type RequestHandler } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationCodeFunctionExecutionError } from "$lib/server/application/code-function-execution";

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) {
		throw error(401, "Authentication required");
	}
	if (!params.id) {
		throw error(400, "Code function id is required");
	}

	let body: unknown = {};
	try {
		body = await request.json();
	} catch {
		// Empty body is fine.
	}

	try {
		return json(
			await getApplicationAdapters().codeFunctionExecution.execute({
				id: params.id,
				userId: locals.session.userId,
				body,
			}),
		);
	} catch (err) {
		if (err instanceof ApplicationCodeFunctionExecutionError) {
			throw error(err.status, err.message);
		}
		throw err;
	}
};
