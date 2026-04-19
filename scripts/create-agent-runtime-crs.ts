/**
 * One-shot cutover script — Phase 4 of the per-agent sandbox runtime plan.
 *
 * For every published, non-archived agent in the DB, upsert an
 * AgentRuntime CR so the agent-runtime-controller materializes a dedicated
 * Deployment (replicas=0 by default). The controller scales to 1 on the
 * first session dispatch via the BFF's wake endpoint.
 *
 * Expected to run exactly once after migration 0039 lands and the
 * workflow-builder pod picks up the new runtime_app_id column. Idempotent:
 * re-running upserts CRs and converges them to the current DB state.
 *
 * Usage (from inside the workflow-builder pod, or any pod with the kube SA
 * bound to workflow-builder-agent-runtimes ClusterRole):
 *
 *     pnpm tsx scripts/create-agent-runtime-crs.ts
 */

import { config as loadEnv } from "dotenv";
loadEnv();

import { eq, and } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

import { agents, environments, environmentVersions } from "../src/lib/server/db/schema";
import {
	upsertAgentRuntime,
	type AgentRuntimeMcpServer,
} from "../src/lib/server/kube/client";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error("DATABASE_URL not set");
	process.exit(1);
}

const DEFAULT_IMAGE =
	process.env.AGENT_RUNTIME_DEFAULT_IMAGE ??
	"gitea-ryzen.tail286401.ts.net/giteaadmin/dapr-agent-py-sandbox:latest";

async function main() {
	const sql = postgres(DATABASE_URL, { max: 3 });
	const db = drizzle(sql);

	const rows = await db
		.select({
			agent: agents,
			envSlug: environments.slug,
			envId: environments.id,
			envVersion: environmentVersions.version,
			imageTag: environmentVersions.imageTag,
		})
		.from(agents)
		.leftJoin(environments, eq(environments.id, agents.environmentId))
		.leftJoin(
			environmentVersions,
			eq(environmentVersions.id, environments.currentVersionId),
		)
		.where(eq(agents.isArchived, false));

	console.log(`Upserting AgentRuntime CRs for ${rows.length} non-archived agents…`);

	let created = 0;
	let skipped = 0;
	let failed = 0;

	for (const row of rows) {
		const slug = row.agent.slug;
		if (!slug) {
			console.warn("skip: agent has no slug", row.agent.id);
			skipped++;
			continue;
		}
		// Parse mcpServers from the agent's current version config. We
		// re-query here to avoid pulling the whole agent_versions table.
		let mcpServers: AgentRuntimeMcpServer[] = [];
		if (row.agent.currentVersionId) {
			const [versionRow] = await sql`
				SELECT config FROM agent_versions WHERE id = ${row.agent.currentVersionId} LIMIT 1
			`;
			const declared = (versionRow?.config as { mcpServers?: unknown } | undefined)?.mcpServers;
			if (Array.isArray(declared)) {
				mcpServers = declared
					.map((s: unknown) => {
						if (!s || typeof s !== "object") return null;
						const o = s as Record<string, unknown>;
						const name = (o.serverName ?? o.name) as string | undefined;
						if (!name) return null;
						return {
							name,
							transport: (o.transport ?? "streamable_http") as
								| "streamable_http"
								| "sse"
								| "stdio"
								| "websocket",
							url: o.url as string | undefined,
							command: o.command as string | undefined,
							args: o.args as string[] | undefined,
							env: o.env as Record<string, string> | undefined,
							headers: o.headers as Record<string, string> | undefined,
						};
					})
					.filter((s): s is AgentRuntimeMcpServer => s !== null);
			}
		}

		const imageTag = row.imageTag ?? DEFAULT_IMAGE;
		try {
			await upsertAgentRuntime({
				agentSlug: slug,
				projectId: row.agent.projectId,
				appId: row.agent.runtimeAppId ?? `agent-runtime-${slug}`,
				environment: {
					id: row.envId ?? undefined,
					slug: row.envSlug ?? undefined,
					version: row.envVersion ?? undefined,
					imageTag,
				},
				mcpServers,
				lifecycle: { idleTtlSeconds: 1800 },
			});
			created++;
			if (created % 10 === 0) {
				console.log(`  …${created} upserted`);
			}
		} catch (err) {
			failed++;
			console.warn(
				`  fail ${slug}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	console.log(
		`Done: ${created} upserted, ${skipped} skipped, ${failed} failed, ${rows.length} total`,
	);
	await sql.end();
	if (failed > 0) process.exit(1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
