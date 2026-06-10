import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	getSession,
	updateSessionStatusUnlessTerminated,
} from "$lib/server/sessions/registry";
import { spawnSessionWorkflow } from "$lib/server/sessions/spawn";
import { CliTokenError } from "$lib/server/users/cli-credentials";

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const session = await getSession(params.id);
	if (!session) return error(404, "Session not found");

	if (session.daprInstanceId) {
		return json({
			instanceId: session.daprInstanceId,
			natsSubject: session.natsSubject,
			alreadyStarted: true,
		});
	}

	await updateSessionStatusUnlessTerminated(params.id, "rescheduling", {
		errorMessage: null,
	});
	try {
		const runtime = await spawnSessionWorkflow(params.id);
		return json({
			...runtime,
			alreadyStarted: false,
		});
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "Session workflow spawn failed";
		await updateSessionStatusUnlessTerminated(params.id, "rescheduling", {
			errorMessage: message,
		});
		// Interactive-CLI precondition failure → 412 with a settings deep-link
		// (mirrors the POST /api/v1/sessions create path).
		if (err instanceof CliTokenError) {
			return json(
				{
					code: err.code,
					provider: err.provider,
					settingsPath: "/settings/cli-tokens",
					message,
				},
				{ status: 412 },
			);
		}
		return error(502, message);
	}
};
