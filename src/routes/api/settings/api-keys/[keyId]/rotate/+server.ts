import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * POST /api/settings/api-keys/[keyId]/rotate
 *
 * Rotate an API key: generate a fresh secret in place (same `id`, same
 * `name`), invalidate the old one. The plaintext is returned once.
 *
 * Callers using the old secret will start getting 401 immediately — the
 * old key hash is overwritten. Keeping the row's id stable avoids dangling
 * references from any external systems that persist the key id.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
  const userId = locals.session?.userId;
  const projectId = locals.session?.projectId?.trim();
  if (!userId) return error(401, "Unauthorized");
  if (!projectId)
    return error(400, "Current session does not include a project");

	const { keyId } = params;

	const rotated = await getApplicationAdapters().workflowData.rotateUserApiKey({
    userId,
    projectId,
		keyId,
	});

  if (!rotated) return error(404, { message: "API key not found" });
	return json(rotated);
};
