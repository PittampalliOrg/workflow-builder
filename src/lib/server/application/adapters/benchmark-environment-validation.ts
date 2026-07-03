import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { ensureDefaultBenchmarkSuites } from "$lib/server/benchmarks/service";
import { db as defaultDb } from "$lib/server/db";
import {
	benchmarkInstances,
	benchmarkSuites,
	environmentImageBuilds,
	type EnvironmentImageBuild,
} from "$lib/server/db/schema";
import {
	ensureSwebenchEnvironment,
	syncEnvironmentBuild,
} from "$lib/server/environments/environment-image-builds";
import type {
	SwebenchEnvironmentBuildProjection,
	SwebenchEnvironmentBuildProvisioner,
	SwebenchEnvironmentValidationRepository,
} from "$lib/server/application/benchmark-environment-validation";
import type { SwebenchSuiteSlug } from "$lib/server/benchmarks/swebench";

type Database = typeof defaultDb;

export class PostgresSwebenchEnvironmentValidationRepository
	implements SwebenchEnvironmentValidationRepository
{
	constructor(private readonly database: Database = defaultDb) {}

	ensureDefaultBenchmarkSuites(): Promise<void> {
		return ensureDefaultBenchmarkSuites();
	}

	async getSuiteBySlug(suiteSlug: SwebenchSuiteSlug) {
		const database = this.requireDatabase();
		const [suite] = await database
			.select({
				id: benchmarkSuites.id,
				slug: benchmarkSuites.slug,
				datasetName: benchmarkSuites.datasetName,
			})
			.from(benchmarkSuites)
			.where(eq(benchmarkSuites.slug, suiteSlug))
			.limit(1);
		return suite ?? null;
	}

	async listInstances(input: {
		suiteId: string;
		instanceIds: string[];
		limit: number | null;
	}) {
		const database = this.requireDatabase();
		const query = database
			.select({
				instanceId: benchmarkInstances.instanceId,
				repo: benchmarkInstances.repo,
				baseCommit: benchmarkInstances.baseCommit,
				testMetadata: benchmarkInstances.testMetadata,
			})
			.from(benchmarkInstances)
			.where(
				input.instanceIds.length > 0
					? and(
							eq(benchmarkInstances.suiteId, input.suiteId),
							inArray(benchmarkInstances.instanceId, input.instanceIds),
						)
					: eq(benchmarkInstances.suiteId, input.suiteId),
			)
			.orderBy(asc(benchmarkInstances.instanceId));
		const rows = input.limit ? await query.limit(input.limit) : await query;
		return rows.map((row) => ({
			instanceId: row.instanceId,
			repo: row.repo,
			baseCommit: row.baseCommit,
			testMetadata: isRecord(row.testMetadata) ? row.testMetadata : null,
		}));
	}

	async loadBuildStatusByHash(
		suiteSlug: SwebenchSuiteSlug,
	): Promise<Map<string, SwebenchEnvironmentBuildProjection>> {
		const database = this.requireDatabase();
		const rows = await database
			.select({
				id: environmentImageBuilds.id,
				envSpecHash: environmentImageBuilds.envSpecHash,
				status: environmentImageBuilds.status,
				validationStatus: environmentImageBuilds.validationStatus,
				sandboxImage: environmentImageBuilds.sandboxImage,
				digest: environmentImageBuilds.digest,
				environmentKey: environmentImageBuilds.environmentKey,
				pipelineRunName: environmentImageBuilds.pipelineRunName,
				pipelineRunNamespace: environmentImageBuilds.pipelineRunNamespace,
			})
			.from(environmentImageBuilds)
			.where(eq(environmentImageBuilds.suite, suiteSlug))
			.orderBy(desc(environmentImageBuilds.updatedAt));
		const byHash = new Map<string, SwebenchEnvironmentBuildProjection>();
		for (const row of rows) {
			if (!row.envSpecHash || byHash.has(row.envSpecHash)) continue;
			byHash.set(row.envSpecHash, row as SwebenchEnvironmentBuildProjection);
		}
		return byHash;
	}

	private requireDatabase(): Database {
		if (!this.database) throw new Error("Database not configured");
		return this.database;
	}
}

export class LegacySwebenchEnvironmentBuildProvisioner
	implements SwebenchEnvironmentBuildProvisioner
{
	constructor(private readonly database: Database = defaultDb) {}

	ensureEnvironment(input: Parameters<typeof ensureSwebenchEnvironment>[0]) {
		return ensureSwebenchEnvironment(input);
	}

	async syncSelectableBuilds(input: {
		envSpecHashes: string[];
		limit: number;
	}): Promise<void> {
		if (!this.database || input.envSpecHashes.length === 0 || input.limit <= 0) {
			return;
		}
		const rows = (await this.database
			.select()
			.from(environmentImageBuilds)
			.where(
				and(
					inArray(
						environmentImageBuilds.envSpecHash,
						Array.from(new Set(input.envSpecHashes)),
					),
					inArray(environmentImageBuilds.status, ["queued", "building"]),
				),
			)
			.orderBy(asc(environmentImageBuilds.updatedAt))
			.limit(input.limit)) as EnvironmentImageBuild[];
		for (const row of rows) {
			try {
				await syncEnvironmentBuild(row);
			} catch (err) {
				console.warn(
					"[benchmarks] failed to sync selectable SWE-bench environment build",
					{
						buildId: row.id,
						pipelineRunName: row.pipelineRunName,
						error: err instanceof Error ? err.message : String(err),
					},
				);
			}
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
