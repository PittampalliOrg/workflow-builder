/**
 * Migrate system/http-request node configs to include canonical keys.
 *
 * Fixes workflows where HTTP Request nodes were saved with legacy keys:
 *   { url, method, headers, body }
 * instead of:
 *   { endpoint, httpMethod, httpHeaders, httpBody }
 *
 * Usage:
 *   pnpm tsx scripts/migrate-system-http-request-input.ts
 *   pnpm tsx scripts/migrate-system-http-request-input.ts --dry-run
 */

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { normalizeWorkflowNodes } from "@/lib/workflows/normalize-nodes";

const DATABASE_URL =
	process.env.DATABASE_URL || "postgres://localhost:5432/workflow";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
	const qc = postgres(DATABASE_URL, { max: 1 });
	const db = drizzle(qc);

	let scanned = 0;
	let workflowsUpdated = 0;
	let nodesUpdated = 0;

	try {
		const rows = await db.execute(
			sql.raw("SELECT id, name, nodes FROM workflows ORDER BY updated_at DESC"),
		);

		for (const row of rows as any[]) {
			scanned += 1;
			const nodes = row.nodes as unknown;
			const normalized = normalizeWorkflowNodes(nodes);

			if (JSON.stringify(nodes) === JSON.stringify(normalized)) {
				continue;
			}

			const beforeCount = countLegacyHttpRequestNodes(nodes);
			const afterCount = countLegacyHttpRequestNodes(normalized);
			nodesUpdated += Math.max(0, beforeCount - afterCount);

			workflowsUpdated += 1;
			console.log(
				`${DRY_RUN ? "[dry-run] " : ""}Update workflow ${row.name} (${row.id}): legacyHttpRequestNodes ${beforeCount} -> ${afterCount}`,
			);

			if (!DRY_RUN) {
				await db.execute(sql`
					UPDATE workflows
					SET nodes = ${JSON.stringify(normalized)}::jsonb, updated_at = NOW()
					WHERE id = ${row.id}
				`);
			}
		}
	} finally {
		await qc.end();
	}

	console.log(
		JSON.stringify(
			{
				scanned,
				workflowsUpdated,
				nodesUpdated,
				dryRun: DRY_RUN,
			},
			null,
			2,
		),
	);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function countLegacyHttpRequestNodes(nodes: unknown): number {
	if (!Array.isArray(nodes)) return 0;
	let count = 0;
	for (const node of nodes) {
		if (!isObject(node)) continue;
		const data = node.data;
		if (!isObject(data)) continue;
		const config = data.config;
		if (!isObject(config)) continue;
		if (config.actionType !== "system/http-request") continue;
		const hasEndpoint = typeof config.endpoint === "string" && config.endpoint;
		const hasLegacyUrl = typeof config.url === "string" && config.url;
		if (!hasEndpoint && hasLegacyUrl) count += 1;
	}
	return count;
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
