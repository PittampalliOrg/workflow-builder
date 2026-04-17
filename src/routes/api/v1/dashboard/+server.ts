import { error, json } from "@sveltejs/kit";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import {
	agents,
	agentVersions,
	environments,
	environmentVersions,
	sessions,
	vaults,
} from "$lib/server/db/schema";

/**
 * Dashboard summary: active sessions count, sessions today, 7-day token
 * usage, active-sessions list, recent-version-bump feed, resource counts.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!db) return error(503, "Database not configured");
	const userId = locals.session.userId;

	const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
	const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

	const [activeCount] = await db
		.select({ n: sql<number>`count(*)` })
		.from(sessions)
		.where(and(eq(sessions.userId, userId), eq(sessions.status, "running")));

	const [todayCount] = await db
		.select({ n: sql<number>`count(*)` })
		.from(sessions)
		.where(and(eq(sessions.userId, userId), gte(sessions.createdAt, dayAgo)));

	const [archivedCount] = await db
		.select({ n: sql<number>`count(*)` })
		.from(sessions)
		.where(
			and(
				eq(sessions.userId, userId),
				sql`${sessions.archivedAt} IS NOT NULL AND ${sessions.archivedAt} >= ${dayAgo.toISOString()}`,
			),
		);

	// Token usage in the last 7 days: sum output_tokens from the JSONB usage col.
	const [tokens] = await db
		.select({
			outTokens: sql<number>`coalesce(sum((usage->>'output_tokens')::int), 0)`,
			inTokens: sql<number>`coalesce(sum((usage->>'input_tokens')::int), 0)`,
		})
		.from(sessions)
		.where(
			and(eq(sessions.userId, userId), gte(sessions.createdAt, weekAgo)),
		);

	const activeSessions = await db
		.select({
			id: sessions.id,
			title: sessions.title,
			status: sessions.status,
			agentId: sessions.agentId,
			updatedAt: sessions.updatedAt,
			createdAt: sessions.createdAt,
		})
		.from(sessions)
		.where(
			and(
				eq(sessions.userId, userId),
				inArray(sessions.status, ["running", "idle"]),
				sql`${sessions.archivedAt} IS NULL`,
			),
		)
		.orderBy(desc(sessions.updatedAt))
		.limit(5);

	const agentIds = Array.from(
		new Set(activeSessions.map((s) => s.agentId).filter(Boolean)),
	);
	const agentRows = agentIds.length
		? await db
				.select({ id: agents.id, name: agents.name, avatar: agents.avatar })
				.from(agents)
				.where(inArray(agents.id, agentIds))
		: [];
	const agentMap = new Map(agentRows.map((a) => [a.id, a]));

	// Recent version bumps — last 10 across agents + environments.
	const recentAgentVersions = await db
		.select({
			id: agentVersions.id,
			version: agentVersions.version,
			publishedAt: agentVersions.publishedAt,
			agentId: agentVersions.agentId,
		})
		.from(agentVersions)
		.where(sql`${agentVersions.publishedAt} IS NOT NULL`)
		.orderBy(desc(agentVersions.publishedAt))
		.limit(10);

	const recentEnvVersions = await db
		.select({
			id: environmentVersions.id,
			version: environmentVersions.version,
			publishedAt: environmentVersions.publishedAt,
			environmentId: environmentVersions.environmentId,
		})
		.from(environmentVersions)
		.where(sql`${environmentVersions.publishedAt} IS NOT NULL`)
		.orderBy(desc(environmentVersions.publishedAt))
		.limit(10);

	const agentLookup = agentRows.length
		? new Map(agentRows.map((a) => [a.id, a.name]))
		: new Map<string, string>();
	if (recentAgentVersions.length > 0) {
		const missing = recentAgentVersions
			.map((v) => v.agentId)
			.filter((id) => !agentLookup.has(id));
		if (missing.length > 0) {
			const rows = await db
				.select({ id: agents.id, name: agents.name })
				.from(agents)
				.where(inArray(agents.id, missing));
			for (const r of rows) agentLookup.set(r.id, r.name);
		}
	}

	const envLookup = new Map<string, string>();
	if (recentEnvVersions.length > 0) {
		const envIds = Array.from(
			new Set(recentEnvVersions.map((v) => v.environmentId)),
		);
		const rows = await db
			.select({ id: environments.id, name: environments.name })
			.from(environments)
			.where(inArray(environments.id, envIds));
		for (const r of rows) envLookup.set(r.id, r.name);
	}

	const recentChanges = [
		...recentAgentVersions.map((v) => ({
			kind: "agent" as const,
			resourceId: v.agentId,
			resourceName: agentLookup.get(v.agentId) ?? v.agentId,
			version: v.version,
			publishedAt: v.publishedAt?.toISOString() ?? null,
		})),
		...recentEnvVersions.map((v) => ({
			kind: "environment" as const,
			resourceId: v.environmentId,
			resourceName: envLookup.get(v.environmentId) ?? v.environmentId,
			version: v.version,
			publishedAt: v.publishedAt?.toISOString() ?? null,
		})),
	]
		.sort(
			(a, b) =>
				new Date(b.publishedAt ?? 0).getTime() -
				new Date(a.publishedAt ?? 0).getTime(),
		)
		.slice(0, 10);

	// Resource counts
	const [{ n: totalAgents }] = await db
		.select({ n: sql<number>`count(*)` })
		.from(agents)
		.where(eq(agents.isArchived, false));
	const [{ n: totalEnvs }] = await db
		.select({ n: sql<number>`count(*)` })
		.from(environments)
		.where(eq(environments.isArchived, false));
	const [{ n: totalVaults }] = await db
		.select({ n: sql<number>`count(*)` })
		.from(vaults)
		.where(eq(vaults.isArchived, false));

	return json({
		stats: {
			activeSessions: Number(activeCount?.n ?? 0),
			sessionsToday: Number(todayCount?.n ?? 0),
			archivedLast24h: Number(archivedCount?.n ?? 0),
			tokensOut7d: Number(tokens?.outTokens ?? 0),
			tokensIn7d: Number(tokens?.inTokens ?? 0),
			totalAgents: Number(totalAgents ?? 0),
			totalEnvironments: Number(totalEnvs ?? 0),
			totalVaults: Number(totalVaults ?? 0),
		},
		activeSessions: activeSessions.map((s) => ({
			id: s.id,
			title: s.title ?? null,
			status: s.status,
			agentId: s.agentId,
			agentName: agentMap.get(s.agentId)?.name ?? s.agentId,
			agentAvatar: agentMap.get(s.agentId)?.avatar ?? null,
			updatedAt: s.updatedAt.toISOString(),
			createdAt: s.createdAt.toISOString(),
		})),
		recentChanges,
	});
};
