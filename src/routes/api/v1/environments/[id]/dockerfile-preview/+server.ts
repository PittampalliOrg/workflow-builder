import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { previewEnvironmentDockerfile } from "$lib/server/environments/builder";
import {
	getBaseImageResolver,
	getEnvironment,
} from "$lib/server/environments/registry";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const env = await getEnvironment(params.id);
	if (!env) return error(404, "Environment not found");
	const resolver = await getBaseImageResolver();
	const dockerfile = await previewEnvironmentDockerfile(env, resolver);
	return json({ dockerfile });
};
