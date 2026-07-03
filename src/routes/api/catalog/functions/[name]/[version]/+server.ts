import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationCatalogFunctionDefinitionError } from "$lib/server/application/catalog-function-definition";

export const GET: RequestHandler = async ({ params, locals }) => {
	try {
		return json(
			await getApplicationAdapters().catalogFunctionDefinition.getDefinition({
				name: params.name,
				version: params.version,
				userId: locals.session?.userId ?? null,
			}),
		);
	} catch (err) {
		if (err instanceof ApplicationCatalogFunctionDefinitionError) {
			return json({ error: err.message }, { status: err.status });
		}
		throw err;
	}
};
