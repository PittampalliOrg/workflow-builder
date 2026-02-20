import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { normalizePieceName } from "@/lib/activepieces/installed-pieces";
import { generateId } from "@/lib/utils/id";
import { db } from "./index";
import {
	type McpConnection,
	type McpConnectionSourceType,
	type McpConnectionStatus,
	mcpConnections,
} from "./schema";

type ListParams = {
	projectId: string;
	status?: McpConnectionStatus;
	sourceType?: McpConnectionSourceType;
};

export async function listMcpConnections(
	params: ListParams,
): Promise<McpConnection[]> {
	const conditions = [eq(mcpConnections.projectId, params.projectId)];

	if (params.status) {
		conditions.push(eq(mcpConnections.status, params.status));
	}
	if (params.sourceType) {
		conditions.push(eq(mcpConnections.sourceType, params.sourceType));
	}

	return db
		.select()
		.from(mcpConnections)
		.where(and(...conditions))
		.orderBy(desc(mcpConnections.updatedAt));
}

export async function getMcpConnectionById(params: {
	id: string;
	projectId: string;
}): Promise<McpConnection | null> {
	const row = await db.query.mcpConnections.findFirst({
		where: and(
			eq(mcpConnections.id, params.id),
			eq(mcpConnections.projectId, params.projectId),
		),
	});
	return row ?? null;
}

export async function upsertPieceMcpConnection(params: {
	projectId: string;
	pieceName: string;
	displayName: string;
	status: McpConnectionStatus;
	serverUrl: string | null;
	registryRef?: string | null;
	metadata?: Record<string, unknown> | null;
	lastError?: string | null;
	actorUserId?: string | null;
}): Promise<McpConnection> {
	const now = new Date();
	const pieceName = normalizePieceName(params.pieceName);

	const existing = await db.query.mcpConnections.findFirst({
		where: and(
			eq(mcpConnections.projectId, params.projectId),
			eq(mcpConnections.sourceType, "nimble_piece"),
			eq(mcpConnections.pieceName, pieceName),
		),
	});

	if (existing) {
		const [updated] = await db
			.update(mcpConnections)
			.set({
				displayName: params.displayName,
				status: params.status,
				serverUrl: params.serverUrl,
				registryRef: params.registryRef ?? null,
				metadata: params.metadata ?? null,
				lastError: params.lastError ?? null,
				lastSyncAt: now,
				updatedBy: params.actorUserId ?? null,
				updatedAt: now,
			})
			.where(eq(mcpConnections.id, existing.id))
			.returning();
		return updated;
	}

	const [created] = await db
		.insert(mcpConnections)
		.values({
			id: generateId(),
			projectId: params.projectId,
			sourceType: "nimble_piece",
			pieceName,
			displayName: params.displayName,
			registryRef: params.registryRef ?? null,
			serverUrl: params.serverUrl,
			status: params.status,
			lastSyncAt: now,
			lastError: params.lastError ?? null,
			metadata: params.metadata ?? null,
			createdBy: params.actorUserId ?? null,
			updatedBy: params.actorUserId ?? null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	return created;
}

export async function createCustomMcpConnection(params: {
	projectId: string;
	displayName: string;
	serverUrl: string;
	status: McpConnectionStatus;
	actorUserId?: string | null;
	metadata?: Record<string, unknown> | null;
}): Promise<McpConnection> {
	const now = new Date();
	const [created] = await db
		.insert(mcpConnections)
		.values({
			id: generateId(),
			projectId: params.projectId,
			sourceType: "custom_url",
			pieceName: null,
			displayName: params.displayName,
			serverUrl: params.serverUrl,
			registryRef: null,
			status: params.status,
			lastSyncAt: now,
			lastError: null,
			metadata: params.metadata ?? null,
			createdBy: params.actorUserId ?? null,
			updatedBy: params.actorUserId ?? null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return created;
}

export async function upsertHostedWorkflowMcpConnection(params: {
	projectId: string;
	displayName?: string;
	serverUrl?: string | null;
	registryRef?: string | null;
	status: McpConnectionStatus;
	metadata?: Record<string, unknown> | null;
	lastError?: string | null;
	actorUserId?: string | null;
}): Promise<McpConnection> {
	const now = new Date();
	const displayName =
		params.displayName?.trim() || "Workflow Builder Hosted MCP";
	const existing = await db.query.mcpConnections.findFirst({
		where: and(
			eq(mcpConnections.projectId, params.projectId),
			eq(mcpConnections.sourceType, "hosted_workflow"),
		),
	});

	if (existing) {
		// Merge metadata so tool lists from sync aren't overwritten
		const existingMeta = (existing.metadata as Record<string, unknown>) ?? {};
		const mergedMeta = params.metadata
			? { ...existingMeta, ...params.metadata }
			: existingMeta;

		const [updated] = await db
			.update(mcpConnections)
			.set({
				displayName,
				serverUrl: params.serverUrl ?? existing.serverUrl,
				registryRef: params.registryRef ?? existing.registryRef,
				status: params.status,
				lastSyncAt: now,
				lastError: params.lastError ?? null,
				metadata: Object.keys(mergedMeta).length > 0 ? mergedMeta : null,
				updatedBy: params.actorUserId ?? null,
				updatedAt: now,
			})
			.where(eq(mcpConnections.id, existing.id))
			.returning();
		return updated;
	}

	const [created] = await db
		.insert(mcpConnections)
		.values({
			id: generateId(),
			projectId: params.projectId,
			sourceType: "hosted_workflow",
			pieceName: null,
			displayName,
			registryRef: params.registryRef ?? "mcp-gateway",
			serverUrl: params.serverUrl ?? null,
			status: params.status,
			lastSyncAt: now,
			lastError: params.lastError ?? null,
			metadata: params.metadata ?? null,
			createdBy: params.actorUserId ?? null,
			updatedBy: params.actorUserId ?? null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return created;
}

export async function updateMcpConnectionStatus(params: {
	id: string;
	projectId: string;
	status: McpConnectionStatus;
	actorUserId?: string | null;
	lastError?: string | null;
}): Promise<McpConnection | null> {
	const [updated] = await db
		.update(mcpConnections)
		.set({
			status: params.status,
			lastError: params.lastError ?? null,
			updatedBy: params.actorUserId ?? null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(mcpConnections.id, params.id),
				eq(mcpConnections.projectId, params.projectId),
			),
		)
		.returning();
	return updated ?? null;
}

export async function updateMcpConnectionSync(params: {
	id: string;
	projectId: string;
	serverUrl?: string | null;
	registryRef?: string | null;
	status?: McpConnectionStatus;
	lastError?: string | null;
	metadata?: Record<string, unknown> | null;
	actorUserId?: string | null;
}): Promise<McpConnection | null> {
	const [updated] = await db
		.update(mcpConnections)
		.set({
			serverUrl: params.serverUrl,
			registryRef: params.registryRef,
			status: params.status,
			lastError: params.lastError ?? null,
			lastSyncAt: new Date(),
			metadata: params.metadata,
			updatedBy: params.actorUserId ?? null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(mcpConnections.id, params.id),
				eq(mcpConnections.projectId, params.projectId),
			),
		)
		.returning();
	return updated ?? null;
}

export async function deleteMcpConnection(params: {
	id: string;
	projectId: string;
}): Promise<boolean> {
	const rows = await db
		.delete(mcpConnections)
		.where(
			and(
				eq(mcpConnections.id, params.id),
				eq(mcpConnections.projectId, params.projectId),
			),
		)
		.returning({ id: mcpConnections.id });
	return rows.length > 0;
}
