/**
 * CMA-style workspace-scoped URL helper. Given the current workspace slug
 * and a path suffix (e.g. `sessions/abc123`), returns the absolute path
 * `/workspaces/{slug}/sessions/abc123`. Mirrors platform.claude.com's URL
 * shape 1:1.
 *
 * The magic slug `DEFAULT_WORKSPACE_SLUG` always resolves server-side to
 * the caller's current `projectId` (from the JWT), so components that
 * don't have a reactive slug handy can still build safe URLs.
 */

export const DEFAULT_WORKSPACE_SLUG = "default";

export function wsPath(slug: string | null | undefined, suffix: string): string {
	const effectiveSlug = (slug && slug.trim()) || DEFAULT_WORKSPACE_SLUG;
	const clean = suffix.startsWith("/") ? suffix.slice(1) : suffix;
	return `/workspaces/${effectiveSlug}/${clean}`;
}
