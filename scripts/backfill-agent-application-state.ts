/**
 * Backfill MLflow LoggedModels for published agent application-state versions.
 *
 * Usage:
 *   node scripts/backfill-agent-application-state.bundle.js --dry-run
 *   node scripts/backfill-agent-application-state.bundle.js --apply
 *   node scripts/backfill-agent-application-state.bundle.js --apply --all-versions
 *   node scripts/backfill-agent-application-state.bundle.js --apply --agent=kimi-k26-swebench-canary
 *
 * The script intentionally uses registerAgentVersionInMlflow(), so the
 * backfill path matches runtime publication and remains idempotent by state
 * digest.
 */

import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../src/lib/server/db";
import { agents, agentVersions } from "../src/lib/server/db/schema";
import { compileAgentApplicationState } from "../src/lib/server/agents/application-state";
import { registerAgentVersionInMlflow } from "../src/lib/server/observability/mlflow-lifecycle";

type Args = {
	apply: boolean;
	allVersions: boolean;
	agentFilter: string | null;
	limit: number | null;
};

function parseArgs(argv: string[]): Args {
	let apply = false;
	let allVersions = false;
	let agentFilter: string | null = null;
	let limit: number | null = null;
	for (const arg of argv.slice(2)) {
		if (arg === "--apply") apply = true;
		else if (arg === "--dry-run") apply = false;
		else if (arg === "--all-versions") allVersions = true;
		else if (arg.startsWith("--agent=")) agentFilter = arg.slice("--agent=".length);
		else if (arg.startsWith("--limit=")) {
			const parsed = Number(arg.slice("--limit=".length));
			if (Number.isInteger(parsed) && parsed > 0) limit = parsed;
		}
	}
	return { apply, allVersions, agentFilter, limit };
}

async function main() {
	const args = parseArgs(process.argv);
	if (!process.env.DATABASE_URL) {
		console.error("DATABASE_URL is required.");
		process.exit(2);
	}
	if (!process.env.MLFLOW_TRACKING_URI) {
		console.error("MLFLOW_TRACKING_URI is required.");
		process.exit(2);
	}

	const currentOnly = eq(agentVersions.id, agents.currentVersionId);
	const filter = and(
		eq(agents.isArchived, false),
		isNotNull(agents.currentVersionId),
		sql`NOT (${agents.tags} @> '["workflow-ephemeral"]'::jsonb)`,
		args.allVersions ? undefined : currentOnly,
		args.agentFilter
			? or(eq(agents.id, args.agentFilter), eq(agents.slug, args.agentFilter))
			: undefined,
	);

	const query = db
		.select({ agent: agents, version: agentVersions })
		.from(agents)
		.innerJoin(agentVersions, eq(agentVersions.agentId, agents.id))
		.where(filter)
		.orderBy(agents.slug, agentVersions.version);

	const rows = args.limit ? await query.limit(args.limit) : await query;

	console.log(
		`${args.apply ? "APPLY" : "DRY RUN"} - ${rows.length} agent version(s), ` +
			`${args.allVersions ? "all published versions" : "current versions only"}`,
	);

	let ok = 0;
	let skipped = 0;
	let failed = 0;
	for (const row of rows) {
		const state = compileAgentApplicationState({
			agent: row.agent,
			version: row.version,
		});
		const label = `${row.agent.slug}@v${row.version.version}`;
		if (!args.apply) {
			console.log(
				`${label}: would register/refresh ` +
					`digest=${state.stateDigest} mlflow=${row.version.mlflowUri ?? "none"}`,
			);
			ok++;
			continue;
		}

		try {
			const registered = await registerAgentVersionInMlflow({
				agent: row.agent,
				version: row.version,
			});
			if (!registered) {
				console.log(`${label}: SKIP MLflow lifecycle disabled`);
				skipped++;
				continue;
			}
			console.log(
				`${label}: OK digest=${state.stateDigest} model=${registered.modelUri}`,
			);
			ok++;
		} catch (err) {
			failed++;
			console.error(
				`${label}: FAIL ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	console.log(`summary ok=${ok} skipped=${skipped} failed=${failed}`);
	if (failed > 0) process.exit(1);
}

main()
	.catch((err) => {
		console.error(err);
		process.exit(1);
	})
	.finally(async () => {
		await db.$client?.end?.();
	});
