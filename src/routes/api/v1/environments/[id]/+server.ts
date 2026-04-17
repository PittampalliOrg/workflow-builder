import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	archiveEnvironment,
	getEnvironment,
	updateEnvironment,
} from "$lib/server/environments/registry";
import type { EnvironmentConfig } from "$lib/types/environments";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const environment = await getEnvironment(params.id);
	if (!environment) return error(404, "Environment not found");
	return json({ environment });
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const environment = await updateEnvironment(params.id, {
		name: typeof body.name === "string" ? body.name : undefined,
		description:
			typeof body.description === "string" || body.description === null
				? (body.description as string | null)
				: undefined,
		avatar:
			typeof body.avatar === "string" || body.avatar === null
				? (body.avatar as string | null)
				: undefined,
		tags: Array.isArray(body.tags)
			? body.tags.map((t) => String(t))
			: undefined,
		config:
			body.config && typeof body.config === "object"
				? (body.config as EnvironmentConfig)
				: undefined,
		changelog:
			typeof body.changelog === "string" ? body.changelog : undefined,
		publishedBy: locals.session.userId,
	});
	if (!environment) return error(404, "Environment not found");
	return json({ environment });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const ok = await archiveEnvironment(params.id);
	if (!ok) return error(404, "Environment not found");
	return json({ archived: true });
};
