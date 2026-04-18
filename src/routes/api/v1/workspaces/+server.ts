import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	createWorkspace,
	listWorkspaces,
} from "$lib/server/workspaces/registry";

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const workspaces = await listWorkspaces({
		userId: locals.session.userId,
		currentProjectId: locals.session.projectId,
	});
	return json({
		currentProjectId: locals.session.projectId,
		workspaces,
	});
};

/**
 * Create a new workspace. Caller becomes ADMIN.
 * Body: { displayName: string, externalId?: string }
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const displayName =
		typeof body.displayName === "string" ? body.displayName.trim() : "";
	if (!displayName) return error(400, "displayName is required");
	const externalId =
		typeof body.externalId === "string" && body.externalId.trim()
			? body.externalId.trim()
			: undefined;
	try {
		const workspace = await createWorkspace({
			displayName,
			externalId,
			userId: locals.session.userId,
			platformId: locals.session.platformId,
		});
		return json({ workspace }, { status: 201 });
	} catch (err) {
		// external_id unique collision lands here
		return error(
			400,
			err instanceof Error ? err.message : "Workspace create failed",
		);
	}
};
