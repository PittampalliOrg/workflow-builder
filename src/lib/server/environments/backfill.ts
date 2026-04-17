import { eq, isNull } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	agents,
	environments,
	environmentVersions,
} from "$lib/server/db/schema";
import type { EnvironmentConfig } from "$lib/types/environments";
import { createDefaultEnvironmentConfig } from "$lib/types/environments";
import { hashEnvironmentConfig } from "./config-hash";

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

export type EnvironmentBackfillReport = {
	defaultEnvironmentCreated: boolean;
	defaultEnvironmentId: string;
	agentsLinked: number;
	totalAgents: number;
};

/**
 * One-shot backfill run at Phase 1 cutover:
 *   1. Ensure a "default-sandbox" environment exists (creates if missing).
 *   2. Link every agent that has no `environment_id` to it.
 *
 * Idempotent — reruns do nothing if everything is already linked.
 */
export async function backfillDefaultEnvironment(): Promise<EnvironmentBackfillReport> {
	const database = requireDb();
	const defaultConfig: EnvironmentConfig = createDefaultEnvironmentConfig();

	let defaultEnv = await findDefaultEnvironment();
	let created = false;
	if (!defaultEnv) {
		const configHash = hashEnvironmentConfig(defaultConfig);
		defaultEnv = await database.transaction(async (tx) => {
			const [env] = await tx
				.insert(environments)
				.values({
					slug: "default-sandbox",
					name: "Default sandbox",
					description:
						"Auto-created default environment for agents migrated from the legacy SandboxPolicy model.",
					avatar: "🧱",
					tags: ["migrated"],
				})
				.returning();
			const [version] = await tx
				.insert(environmentVersions)
				.values({
					environmentId: env.id,
					version: 1,
					config: defaultConfig as unknown as Record<string, unknown>,
					configHash,
					publishedAt: new Date(),
					changelog: "Backfilled default environment",
				})
				.returning();
			const [updated] = await tx
				.update(environments)
				.set({ currentVersionId: version.id, updatedAt: new Date() })
				.where(eq(environments.id, env.id))
				.returning();
			return updated;
		});
		created = true;
	}

	const unlinked = await database
		.select({ id: agents.id })
		.from(agents)
		.where(isNull(agents.environmentId));

	if (unlinked.length > 0) {
		await database
			.update(agents)
			.set({
				environmentId: defaultEnv.id,
				environmentVersion: 1,
				updatedAt: new Date(),
			})
			.where(isNull(agents.environmentId));
	}

	const allAgents = await database.select({ id: agents.id }).from(agents);

	return {
		defaultEnvironmentCreated: created,
		defaultEnvironmentId: defaultEnv.id,
		agentsLinked: unlinked.length,
		totalAgents: allAgents.length,
	};
}

async function findDefaultEnvironment() {
	const database = requireDb();
	const [row] = await database
		.select()
		.from(environments)
		.where(eq(environments.slug, "default-sandbox"))
		.limit(1);
	return row ?? null;
}
