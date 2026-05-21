import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { createOrAttachOpenShellSession } from "$lib/server/openshell-sessions";

function routeError(err: unknown) {
	const status =
		typeof err === "object" && err !== null && "status" in err
			? Number((err as { status?: unknown }).status)
			: 500;
	return error(
		Number.isFinite(status) && status >= 400 ? status : 500,
		err instanceof Error ? err.message : "OpenShell session request failed",
	);
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const requestedWorkspaceId =
		typeof body.workspaceId === "string" && body.workspaceId.trim()
			? body.workspaceId.trim()
			: null;
	if (
		requestedWorkspaceId &&
		locals.session.projectId &&
		requestedWorkspaceId !== locals.session.projectId
	) {
		return error(404, "Workspace not found");
	}
	try {
		const session = await createOrAttachOpenShellSession(body, {
			userId: locals.session.userId,
			projectId: locals.session.projectId,
		});
		return json({ session });
	} catch (err) {
		throw routeError(err);
	}
};
