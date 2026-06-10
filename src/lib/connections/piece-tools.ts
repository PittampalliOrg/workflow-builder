/**
 * Browser-safe piece tool/action helpers.
 *
 * These are pure functions with no server dependencies, kept OUT of
 * `$lib/server/*` so Svelte components (piece detail page, agent tool cards)
 * can import them — SvelteKit forbids importing server modules into
 * browser code. `$lib/server/mcp-catalog` re-exports them for server callers.
 */

export type PieceMetadataAction = {
	name: string;
	displayName: string;
	description: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Flatten the `piece_metadata.actions` JSONB into a sorted action list
 * (the per-tool surface). Shared by the piece-detail loader, the agent
 * Tools & Integrations endpoint, and the UI so all render the same list.
 */
export function pieceActionsFromMetadata(actions: unknown): PieceMetadataAction[] {
	if (!isRecord(actions)) return [];
	return Object.entries(actions)
		.map(([key, raw]) => {
			const def = isRecord(raw) ? raw : {};
			const displayName =
				typeof def.displayName === 'string' && def.displayName.trim() ? def.displayName : key;
			const description =
				typeof def.description === 'string' && def.description.trim() ? def.description : null;
			return { name: key, displayName, description };
		})
		.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Read-vs-write heuristic shared by the piece detail page + agent tool cards. */
export const READ_ONLY_ACTION_PREFIXES = ['get', 'list', 'search', 'find', 'read', 'download'];

export function isReadOnlyPieceAction(action: { name: string; displayName?: string }): boolean {
	const probes = [action.name, action.displayName ?? '']
		.map((value) => String(value || '').trim().toLowerCase())
		.filter(Boolean);
	return probes.some((probe) =>
		READ_ONLY_ACTION_PREFIXES.some((prefix) => probe.startsWith(prefix))
	);
}
