/**
 * Browser-side helpers for piece-backed MCP connections.
 *
 * Framework-free (plain fetch) so the Integrations hub, the piece detail
 * subroute, and later canvas surfaces share one implementation.
 */

export type PieceMcpConnection = {
	id: string;
	displayName: string;
	sourceType: string;
	pieceName: string | null;
	serverKey: string | null;
	connectionExternalId: string | null;
	serverUrl: string | null;
	status: string;
	metadata: Record<string, unknown> | null;
	createdAt?: string;
};

/** Tool selection persisted on `mcp_connection.metadata.toolSelection`. */
export type PieceToolSelection = { tools: string[] } | null;

/**
 * Enable (create or re-enable) the per-piece MCP server for this
 * workspace, optionally bound to an app connection.
 */
export async function createPieceMcp(
	pieceName: string,
	connectionExternalId?: string | null,
	fetchImpl: typeof fetch = fetch
): Promise<PieceMcpConnection> {
	const res = await fetchImpl('/api/mcp-connections', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			sourceType: 'nimble_piece',
			pieceName,
			connectionExternalId: connectionExternalId || null
		})
	});
	if (!res.ok) throw new Error(await res.text());
	return (await res.json()) as PieceMcpConnection;
}

/** Patch an MCP connection (status, credential binding, tool selection). */
export async function updateMcpConnection(
	id: string,
	patch: {
		status?: 'ENABLED' | 'DISABLED';
		connectionExternalId?: string | null;
		toolSelection?: PieceToolSelection;
	},
	fetchImpl: typeof fetch = fetch
): Promise<PieceMcpConnection> {
	const res = await fetchImpl(`/api/mcp-connections/${id}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(patch)
	});
	if (!res.ok) throw new Error(await res.text());
	return (await res.json()) as PieceMcpConnection;
}

/** Read the persisted tool selection from a connection's metadata (null = all tools enabled). */
export function toolSelectionFromMetadata(
	metadata: Record<string, unknown> | null | undefined
): string[] | null {
	const selection = metadata?.toolSelection;
	if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return null;
	const tools = (selection as Record<string, unknown>).tools;
	if (!Array.isArray(tools)) return null;
	return tools.map((tool) => String(tool || '').trim()).filter(Boolean);
}
