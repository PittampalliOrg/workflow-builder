import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { duplicateEnvironment } from "$lib/server/environments/registry";

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const name = typeof body.name === "string" ? body.name : undefined;
	const environment = await duplicateEnvironment(params.id, {
		name,
		createdBy: locals.session.userId,
		projectId: locals.session.projectId ?? null,
	});
	if (!environment) return error(404, "Environment not found");
	return json({ environment }, { status: 201 });
};
