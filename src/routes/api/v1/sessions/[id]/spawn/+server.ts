import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await getApplicationAdapters().sessionCommands.startSessionWorkflow({
		sessionId: params.id,
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
	});

	if (result.status === "not_found") return error(404, result.message);
	if (result.status === "failed") return error(502, result.message);
	if (result.status === "precondition_failed") {
		return json(
			{
				code: result.code,
				provider: result.provider,
				settingsPath: result.settingsPath,
				message: result.message,
			},
			{ status: 412 },
		);
	}

	return json({
		instanceId: result.instanceId,
		natsSubject: result.natsSubject,
		alreadyStarted: result.alreadyStarted,
	});
};
