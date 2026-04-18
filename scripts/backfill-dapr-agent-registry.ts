/**
 * Backfill the Dapr agent registry from Postgres.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-dapr-agent-registry.ts           # dry run (default)
 *   pnpm tsx scripts/backfill-dapr-agent-registry.ts --apply   # perform writes
 *   pnpm tsx scripts/backfill-dapr-agent-registry.ts --apply --project=<slug-or-id>
 *
 * Iterates every non-archived, non-ephemeral agent in Postgres and calls
 * registerAgent() to mirror it into the Dapr state store (component
 * `DAPR_AGENT_REGISTRY_STORE`, default `agent-registry`). Safe to re-run —
 * the per-agent write is overwrite and the team index uses ETag retry.
 *
 * Requires the Dapr sidecar to be reachable at DAPR_HTTP_PORT (default 3500).
 * When run inside a pod with a Dapr sidecar attached, this Just Works. Locally,
 * run `dapr run --app-id workflow-builder -- pnpm tsx scripts/...`.
 */

import { and, eq, or, sql } from "drizzle-orm";
import { db } from "../src/lib/server/db";
import { agents, projects } from "../src/lib/server/db/schema";
import { registerAgent } from "../src/lib/server/agents/registry-sync";

type Args = {
	apply: boolean;
	projectFilter: string | null;
};

function parseArgs(argv: string[]): Args {
	let apply = false;
	let projectFilter: string | null = null;
	for (const a of argv.slice(2)) {
		if (a === "--apply") apply = true;
		else if (a === "--dry-run") apply = false;
		else if (a.startsWith("--project=")) projectFilter = a.slice(10);
	}
	return { apply, projectFilter };
}

async function resolveProject(
	filter: string,
): Promise<{ id: string; name: string } | null> {
	if (!db) return null;
	const [row] = await db
		.select({ id: projects.id, name: projects.displayName })
		.from(projects)
		.where(or(eq(projects.id, filter), eq(projects.externalId, filter)))
		.limit(1);
	return row ?? null;
}

async function main() {
	const { apply, projectFilter } = parseArgs(process.argv);
	if (!db) {
		console.error("Database not configured (check DATABASE_URL).");
		process.exit(2);
	}

	let projectId: string | null = null;
	if (projectFilter) {
		const resolved = await resolveProject(projectFilter);
		if (!resolved) {
			console.error(`Project not found: ${projectFilter}`);
			process.exit(3);
		}
		projectId = resolved.id;
		console.log(`Scoped to project ${resolved.name} (${resolved.id})`);
	}

	const where = and(
		eq(agents.isArchived, false),
		sql`NOT (${agents.tags} @> '["workflow-ephemeral"]'::jsonb)`,
		projectId ? eq(agents.projectId, projectId) : undefined,
	);

	const rows = await db
		.select({
			id: agents.id,
			slug: agents.slug,
			name: agents.name,
			projectId: agents.projectId,
			currentVersionId: agents.currentVersionId,
			registryStatus: agents.registryStatus,
		})
		.from(agents)
		.where(where);

	console.log(
		`${apply ? "APPLY" : "DRY RUN"} — found ${rows.length} eligible agent(s)`,
	);

	let ok = 0;
	let skipped = 0;
	let failed = 0;

	for (const row of rows) {
		const prefix = `  ${row.name} (${row.slug}, ${row.id})`;
		if (!row.projectId) {
			console.log(`${prefix}: SKIP — no projectId`);
			skipped++;
			continue;
		}
		if (!row.currentVersionId) {
			console.log(`${prefix}: SKIP — no currentVersionId`);
			skipped++;
			continue;
		}
		if (!apply) {
			console.log(
				`${prefix}: would register → team=${row.projectId} key=agents:${row.projectId}:${row.slug} (current status=${row.registryStatus})`,
			);
			ok++;
			continue;
		}
		try {
			const result = await registerAgent(row.id);
			if (result.status === "registered") {
				console.log(`${prefix}: OK (team=${result.team}, key=${result.key})`);
				ok++;
			} else {
				console.log(
					`${prefix}: FAIL status=${result.status} error=${result.error ?? "n/a"}`,
				);
				failed++;
			}
		} catch (err) {
			console.log(
				`${prefix}: THROW ${err instanceof Error ? err.message : String(err)}`,
			);
			failed++;
		}
	}

	console.log(
		`\nSummary: ok=${ok} skipped=${skipped} failed=${failed} total=${rows.length}`,
	);
	if (!apply) {
		console.log(
			"\nRe-run with --apply to perform the writes. Nothing has changed.",
		);
	}
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error("backfill crashed:", err);
	process.exit(1);
});
