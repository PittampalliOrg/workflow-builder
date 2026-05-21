import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { resolveOpenShellTerminalTarget } from "$lib/server/openshell-sessions";

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		const target = await resolveOpenShellTerminalTarget(
			params.id,
			params.terminalId,
			{
				userId: locals.session.userId,
				projectId: locals.session.projectId,
			},
		);
		if (!target) return error(404, "OpenShell session not found");
		return json(target);
	} catch (err) {
		const status =
			typeof err === "object" && err !== null && "status" in err
				? Number((err as { status?: unknown }).status)
				: 500;
		return error(
			Number.isFinite(status) && status >= 400 ? status : 500,
			err instanceof Error ? err.message : "Terminal target resolution failed",
		);
	}
};
