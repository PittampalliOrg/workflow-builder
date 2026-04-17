/**
 * Prepend the current workspace slug to a resource path. Mirrors the CMA
 * console's `/workspaces/{slug}/{resource}` URL shape.
 *
 * Until per-user workspaces ship, `DEFAULT_WORKSPACE_SLUG = "default"`
 * resolves to the user's primary project server-side. Call sites pass the
 * slug explicitly so we can swap in a reactive value once we have one.
 */

export const DEFAULT_WORKSPACE_SLUG = "default";

export function wsPath(slug: string, suffix: string): string {
	const clean = suffix.startsWith("/") ? suffix : `/${suffix}`;
	return `/workspaces/${slug}${clean}`;
}
