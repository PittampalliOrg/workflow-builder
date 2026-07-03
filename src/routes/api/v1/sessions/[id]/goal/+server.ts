import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await getApplicationAdapters().sessionGoals.getSessionGoal({
		sessionId: params.id,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
	});
	if (result.status === "not_found") return error(404, result.message);
	return json({
		goal: result.goal,
		nativeGoalAvailable: result.nativeGoalAvailable,
	});
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const result = await getApplicationAdapters().sessionGoals.setSessionGoal({
		sessionId: params.id,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
		body,
	});
	if (result.status === "invalid") return error(400, result.message);
	if (result.status === "not_found") return error(404, result.message);
	if (result.status === "native") {
		return json({ native: true, objective: result.objective });
	}
	return json({ goal: result.goal });
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const result =
		await getApplicationAdapters().sessionGoals.updateSessionGoalStatus({
			sessionId: params.id,
			projectId: locals.session.projectId ?? null,
			userId: locals.session.userId,
			body,
		});
	if (result.status === "invalid") return error(400, result.message);
	if (result.status === "not_found") return error(404, result.message);
	if (result.status === "native") return json({ native: true });
	return json({ goal: result.goal });
};
