import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

function requireApiKeyWorkspace(locals: App.Locals): {
  userId: string;
  projectId: string;
} {
  const userId = locals.session?.userId;
  const projectId = locals.session?.projectId?.trim();
  if (!userId) throw error(401, "Unauthorized");
  if (!projectId)
    throw error(400, "Current session does not include a project");
  return { userId, projectId };
}

/**
 * GET /api/settings/api-keys
 *
 * List keys for the current workspace plus the caller's legacy webhook keys.
 */
export const GET: RequestHandler = async ({ locals }) => {
  const scope = requireApiKeyWorkspace(locals);

  return json(
    await getApplicationAdapters().workflowData.listUserApiKeys(scope),
  );
};

/**
 * POST /api/settings/api-keys
 *
 * Create a new API key. Returns the plaintext key once — it cannot be retrieved again.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  const scope = requireApiKeyWorkspace(locals);

	const body = await request.json();
	const { name } = body;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return error(400, { message: "name is required" });
	}

	const created = await getApplicationAdapters().workflowData.createUserApiKey({
    ...scope,
		name,
	});
  if (!created) {
    return error(403, {
      message: "An authoring role is required to create API keys",
    });
  }

	return json(created, { status: 201 });
};
