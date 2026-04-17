import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { duplicateAgent } from "$lib/server/agents/registry";

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const name = typeof body.name === "string" ? body.name : undefined;
	const description =
		typeof body.description === "string" ? body.description : undefined;
	const agent = await duplicateAgent(params.id, {
		name,
		description,
		createdBy: locals.session.userId,
	});
	if (!agent) return error(404, "Agent not found");
	return json({ agent }, { status: 201 });
};
