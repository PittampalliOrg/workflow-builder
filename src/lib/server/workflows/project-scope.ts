/**
 * Workspace/project scoping helpers for workflow-related API endpoints.
 *
 * The CMA-alignment plan (Deploy B, Tier 1) requires user-facing workflow
 * APIs to scope by `locals.session.projectId` resolved by `hooks.server.ts`
 * from the `X-Workspace` header or `/workspaces/[slug]/*` URL.
 *
 * These helpers enforce the scope consistently with the CMA pattern at
 * `/api/v1/projects/[projectId]/members/*`: fetch the resource by id, then
 * check that the caller's active workspace matches the resource's workspace.
 * Mismatch returns 404 (not 403) so cross-workspace existence isn't leaked.
 *
 * Backward compatibility: pre-CMA workflows / executions may have a null
 * `project_id`. For those, we fall back to a userId match — the resource is
 * accessible only to its original owner regardless of the caller's active
 * workspace. Internal/service-token endpoints do not use these helpers.
 */
import { error } from "@sveltejs/kit";

type ProjectScoped = {
	projectId: string | null;
	userId: string;
};

type CallerSession = {
	userId: string;
	projectId?: string | null;
};

/**
 * Returns true when the caller is allowed to view/mutate a resource based on
 * the workspace scoping contract. Call site loads the resource, then invokes
 * this — separated from the throw so handlers can choose their error code.
 */
export function isResourceInScope(
	resource: ProjectScoped | null | undefined,
	session: CallerSession | null | undefined,
): resource is ProjectScoped {
	if (!resource || !session) return false;
	// CMA-scoped resource: workspace must match.
	if (resource.projectId && session.projectId) {
		return resource.projectId === session.projectId;
	}
	// Pre-CMA resource (null projectId): ownership check as the legacy
	// fallback. Caller must be the original owner.
	if (!resource.projectId) {
		return resource.userId === session.userId;
	}
	// Resource has a projectId but the session doesn't carry one (e.g., no
	// X-Workspace header, no /workspaces/[slug]/ path): allow through for
	// org-scoped callers like the flat /workflows/[id] editor route. The
	// editor URL is intentionally workspace-agnostic per cma-parity.md.
	return resource.userId === session.userId;
}

/**
 * Throws 404 when the resource is out of scope. Intended for route handlers
 * that already loaded the resource and want a single assertion.
 */
export function assertInScope(
	resource: ProjectScoped | null | undefined,
	session: CallerSession | null | undefined,
	notFoundMessage = "Not found",
): asserts resource is ProjectScoped {
	if (!isResourceInScope(resource, session)) {
		throw error(404, notFoundMessage);
	}
}
