import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import {
	credentialAccessLogs,
	projectMembers,
	runtimeConfigAuditLogs,
	users,
} from "$lib/server/db/schema";
import { and, desc, eq, gte } from "drizzle-orm";

/**
 * GET /api/v1/security/audit
 *
 * Aggregated audit stream for the caller's active workspace. Stitches
 * three sources:
 *   - credential_access_logs (who/what pulled a secret)
 *   - project_members (who joined / changed role — joined time only)
 *   - runtime_config_audit_logs (dynamic config writes)
 *
 * Returns the 100 most recent events merged by timestamp DESC.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!db) return error(503, "Database not configured");

	const since = new Date(Date.now() - 30 * 86_400_000);

	const [creds, members, configs] = await Promise.all([
		db
			.select({
				id: credentialAccessLogs.id,
				at: credentialAccessLogs.accessedAt,
				integration: credentialAccessLogs.integrationType,
				source: credentialAccessLogs.source,
				executionId: credentialAccessLogs.executionId,
				fallbackAttempted: credentialAccessLogs.fallbackAttempted,
			})
			.from(credentialAccessLogs)
			.where(gte(credentialAccessLogs.accessedAt, since))
			.orderBy(desc(credentialAccessLogs.accessedAt))
			.limit(100),
		locals.session.projectId
			? db
					.select({
						id: projectMembers.id,
						at: projectMembers.createdAt,
						role: projectMembers.role,
						userId: users.id,
						email: users.email,
						name: users.name,
					})
					.from(projectMembers)
					.innerJoin(users, eq(users.id, projectMembers.userId))
					.where(
						and(
							eq(projectMembers.projectId, locals.session.projectId),
							gte(projectMembers.createdAt, since),
						),
					)
					.orderBy(desc(projectMembers.createdAt))
					.limit(50)
			: Promise.resolve([]),
		locals.session.projectId
			? db
					.select({
						id: runtimeConfigAuditLogs.id,
						at: runtimeConfigAuditLogs.createdAt,
						key: runtimeConfigAuditLogs.configKey,
						status: runtimeConfigAuditLogs.status,
						actor: runtimeConfigAuditLogs.userId,
					})
					.from(runtimeConfigAuditLogs)
					.where(
						and(
							eq(runtimeConfigAuditLogs.projectId, locals.session.projectId),
							gte(runtimeConfigAuditLogs.createdAt, since),
						),
					)
					.orderBy(desc(runtimeConfigAuditLogs.createdAt))
					.limit(50)
			: Promise.resolve([]),
	]);

	const events = [
		...creds.map((r) => ({
			id: `cred:${r.id}`,
			at: r.at.toISOString(),
			kind: "credential.access" as const,
			summary: `${r.integration} credential resolved via ${r.source}${r.fallbackAttempted ? ' (fallback)' : ''}`,
			executionId: r.executionId,
		})),
		...members.map((r) => ({
			id: `member:${r.id}`,
			at: r.at.toISOString(),
			kind: "member.added" as const,
			summary: `${r.name ?? r.email ?? r.userId} joined as ${r.role}`,
		})),
		...configs.map((r) => ({
			id: `config:${r.id}`,
			at: r.at.toISOString(),
			kind: "config.change" as const,
			summary: `${r.key} updated (${r.status})`,
			actor: r.actor,
		})),
	]
		.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
		.slice(0, 100);

	return json({ events, asOf: new Date().toISOString() });
};
