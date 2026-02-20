import { desc, eq } from "drizzle-orm";
import { db } from "./index";
import { runtimeConfigAuditLogs } from "./schema";

export async function createRuntimeConfigAuditLog(input: {
	projectId: string;
	userId: string;
	storeName: string;
	configKey: string;
	value: string;
	metadata?: Record<string, string>;
	status: "success" | "error";
	provider?: string;
	providerResponse?: Record<string, unknown>;
	error?: string;
}) {
	const [row] = await db
		.insert(runtimeConfigAuditLogs)
		.values({
			projectId: input.projectId,
			userId: input.userId,
			storeName: input.storeName,
			configKey: input.configKey,
			value: input.value,
			metadata: input.metadata,
			status: input.status,
			provider: input.provider,
			providerResponse: input.providerResponse,
			error: input.error,
		})
		.returning();
	return row;
}

export async function listRuntimeConfigAuditLogs(input: {
	projectId: string;
	limit?: number;
}) {
	const limit = Math.min(Math.max(input.limit ?? 30, 1), 200);
	return await db
		.select({
			id: runtimeConfigAuditLogs.id,
			projectId: runtimeConfigAuditLogs.projectId,
			userId: runtimeConfigAuditLogs.userId,
			storeName: runtimeConfigAuditLogs.storeName,
			configKey: runtimeConfigAuditLogs.configKey,
			value: runtimeConfigAuditLogs.value,
			metadata: runtimeConfigAuditLogs.metadata,
			status: runtimeConfigAuditLogs.status,
			provider: runtimeConfigAuditLogs.provider,
			error: runtimeConfigAuditLogs.error,
			createdAt: runtimeConfigAuditLogs.createdAt,
		})
		.from(runtimeConfigAuditLogs)
		.where(eq(runtimeConfigAuditLogs.projectId, input.projectId))
		.orderBy(desc(runtimeConfigAuditLogs.createdAt))
		.limit(limit);
}
