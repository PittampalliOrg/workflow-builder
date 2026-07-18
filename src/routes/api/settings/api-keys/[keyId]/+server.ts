import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * DELETE /api/settings/api-keys/[keyId]
 *
 * Delete an API key by ID (only if it belongs to the current user).
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
  const userId = locals.session?.userId;
  const projectId = locals.session?.projectId?.trim();
  if (!userId) return error(401, "Unauthorized");
  if (!projectId)
    return error(400, "Current session does not include a project");

	const { keyId } = params;

	const deleted = await getApplicationAdapters().workflowData.deleteUserApiKey({
    userId,
    projectId,
		keyId,
	});
	if (!deleted) {
    return error(404, { message: "API key not found" });
	}

	return json({ success: true });
};
