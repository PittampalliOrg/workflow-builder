import { getApplicationAdapters } from "$lib/server/application";

/**
 * Resolve a URL `[slug]` segment to the authoritative project id, given the
 * caller's userId. Enforces membership — returns null if the slug doesn't
 * map to any project OR the caller isn't in `project_members` for it.
 *
 * The magic slug `default` always maps to the caller's JWT `projectId` (via
 * the `currentProjectId` argument). Any other string resolves via
 * `projects.external_id`.
 *
 * Page loaders under `/workspaces/[slug]/` should call this and 404 on
 * null; API endpoints that accept an explicit `?workspace=` override
 * should do the same.
 */
export async function resolveWorkspaceProjectId(
	slug: string | undefined | null,
	userId: string,
	currentProjectId: string,
): Promise<string | null> {
	return getApplicationAdapters().workflowData.resolveWorkspaceProjectId({
		slug,
		userId,
		currentProjectId,
	});
}
