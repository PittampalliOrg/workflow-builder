import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { SwebenchEnvironmentEnsureRequestError } from "$lib/server/environments/swebench-environment-ensure";
import { requireInternal } from "$lib/server/internal-auth";

export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	const result = await getApplicationAdapters()
		.benchmarkEnvironmentValidation.ensureInternalRequest(body)
		.catch(mapEnsureError);
	return json(result);
};

function mapEnsureError(err: unknown): never {
	if (err instanceof SwebenchEnvironmentEnsureRequestError) {
		throw error(err.status, err.message);
	}
	throw err;
}
