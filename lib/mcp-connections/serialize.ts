import type { McpConnection as DbMcpConnection } from "@/lib/db/schema";
import type { McpConnection } from "@/lib/types/mcp-connection";

export function toMcpConnectionDto(row: DbMcpConnection): McpConnection {
	return {
		id: row.id,
		projectId: row.projectId,
		sourceType: row.sourceType,
		pieceName: row.pieceName,
		displayName: row.displayName,
		registryRef: row.registryRef,
		serverUrl: row.serverUrl,
		status: row.status,
		lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
		lastError: row.lastError,
		metadata: (row.metadata ?? null) as Record<string, unknown> | null,
		createdBy: row.createdBy,
		updatedBy: row.updatedBy,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}
