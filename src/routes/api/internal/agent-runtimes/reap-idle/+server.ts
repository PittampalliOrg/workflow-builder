import { json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { db } from "$lib/server/db";
import { agents, sessions } from "$lib/server/db/schema";
import {
	listSandboxWarmPools,
	setSandboxWarmPoolReplicas,
} from "$lib/server/kube/client";

/**
 * POST /api/internal/agent-runtimes/reap-idle
 *
 * Idle-reaper for the upstream `SandboxWarmPool`-backed agents (browser/
 * Playwright). For every pool with `spec.replicas > 0`, query the DB for
 * any session of the same agent slug that's either currently `running` or
 * has been touched within `idleTtlSeconds`. If none, patch the pool's
 * replicas back to 0.
 *
 * Driven by the `agent-runtime-idle-reaper` CronJob (every 5 min). Auth via
 * `INTERNAL_API_TOKEN` like the rest of the internal control-plane endpoints.
 */

const ACTIVE_SESSION_STATUSES = ["running", "rescheduling", "queued"] as const;

function idleTtlSeconds(): number {
	const raw = (
		env.AGENT_RUNTIME_IDLE_TTL_SECONDS ??
		process.env.AGENT_RUNTIME_IDLE_TTL_SECONDS ??
		"1800"
	).trim();
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 60) return 1800;
	return Math.min(86_400, parsed);
}

export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	if (!db) return json({ error: "database not configured" }, { status: 500 });

	const ttlSeconds = idleTtlSeconds();
	const namespace =
		env.AGENT_RUNTIME_NAMESPACE ??
		process.env.AGENT_RUNTIME_NAMESPACE ??
		"workflow-builder";

	const pools = await listSandboxWarmPools(namespace);
	const candidates = pools.filter(
		(p) =>
			(p.spec?.replicas ?? 0) > 0 &&
			p.metadata.labels?.["agents.x-k8s.io/slug"],
	);
	if (candidates.length === 0) {
		return json({ namespace, ttlSeconds, reaped: [], skipped: [] });
	}

	const slugs = candidates
		.map((p) => p.metadata.labels?.["agents.x-k8s.io/slug"])
		.filter((s): s is string => Boolean(s));

	// Active = either currently running OR updated within the idle TTL.
	// `updatedAt` advances on every workflow event (event_publisher mirrors
	// agent.message / tool_use back to the BFF), so a recently-active
	// session that's now `idle` still extends the keep-warm window — same
	// semantics the controller's `lastActiveAt` annotation provided.
	const cutoff = sql`now() - (${ttlSeconds}::int * interval '1 second')`;
	const activeRows = await db
		.select({ slug: agents.slug })
		.from(sessions)
		.innerJoin(agents, eq(agents.id, sessions.agentId))
		.where(
			and(
				inArray(agents.slug, slugs),
				isNull(sessions.archivedAt),
				or(
					inArray(
						sessions.status,
						ACTIVE_SESSION_STATUSES as unknown as string[],
					),
					gt(sessions.updatedAt, cutoff as unknown as Date),
				),
			),
		);
	const activeSlugs = new Set(activeRows.map((r) => r.slug));

	const reaped: string[] = [];
	const skipped: string[] = [];
	for (const pool of candidates) {
		const slug = pool.metadata.labels?.["agents.x-k8s.io/slug"];
		if (!slug) continue;
		if (activeSlugs.has(slug)) {
			skipped.push(slug);
			continue;
		}
		try {
			await setSandboxWarmPoolReplicas(pool.metadata.name, 0, namespace);
			reaped.push(slug);
		} catch (err) {
			console.warn(
				`[reap-idle] scale ${pool.metadata.name} to 0 failed:`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	return json({ namespace, ttlSeconds, reaped, skipped });
};
