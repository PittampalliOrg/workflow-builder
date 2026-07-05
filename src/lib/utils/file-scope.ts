/**
 * Resolve a Files-page `scopeId` to the page that owns it (Track 2). Files
 * carry a free-form `scopeId`; historically the Files page linked EVERY scope
 * to `/sessions/{scopeId}`, which 404s for archive scopes like
 * `preview-archive:pr-42`. Two categories today:
 *
 *   preview-archive:<name>  → the archived-previews browser
 *   <session-id>            → the session detail page
 *
 * Mirrors the server `previewArchiveScopeId(name)` prefix; kept as a pure
 * client util so the Files page (and any future scope surface) stays in sync.
 */
export const PREVIEW_ARCHIVE_SCOPE_PREFIX = "preview-archive:";

export type FileScope =
	| { kind: "preview-archive"; name: string }
	| { kind: "session"; sessionId: string };

export function parseFileScope(scopeId: string): FileScope {
	if (scopeId.startsWith(PREVIEW_ARCHIVE_SCOPE_PREFIX)) {
		return {
			kind: "preview-archive",
			name: scopeId.slice(PREVIEW_ARCHIVE_SCOPE_PREFIX.length),
		};
	}
	return { kind: "session", sessionId: scopeId };
}

export function resolveFileScopeLink(
	slug: string,
	scopeId: string | null | undefined,
): string | null {
	if (!scopeId) return null;
	const scope = parseFileScope(scopeId);
	if (scope.kind === "preview-archive") {
		return `/workspaces/${slug}/previews/archived/${encodeURIComponent(scope.name)}`;
	}
	return `/workspaces/${slug}/sessions/${scope.sessionId}`;
}

/** Short, human label for a scope chip (avoids leaking the raw prefix). */
export function fileScopeLabel(scopeId: string): string {
	const scope = parseFileScope(scopeId);
	if (scope.kind === "preview-archive") return `preview ${scope.name}`;
	return scope.sessionId.slice(0, 12);
}
