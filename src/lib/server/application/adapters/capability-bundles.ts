import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { db as defaultDb } from "$lib/server/db";
import {
	capabilityBundles,
	capabilityBundleVersions,
} from "$lib/server/db/schema";
import type {
	CapabilityBundleCreateRecord,
	CapabilityBundleDetail,
	CapabilityBundleRepository,
	CapabilityBundleSummary,
	CapabilityBundleUpdateRecord,
} from "$lib/server/application/capability-bundles";
import type { CapabilityBundleConfig } from "$lib/types/agents";

type Database = typeof defaultDb;
type BundleRow = typeof capabilityBundles.$inferSelect;
type VersionRow = typeof capabilityBundleVersions.$inferSelect;

function requireDb(database: Database = defaultDb): NonNullable<Database> {
	if (!database) throw new Error("Database not configured");
	return database;
}

function rowToSummary(
	row: BundleRow,
	version: VersionRow | null,
): CapabilityBundleSummary {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		tags: row.tags ?? [],
		projectId: row.projectId,
		currentVersion: version?.version ?? null,
		isArchived: row.isArchived,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function rowToDetail(
	row: BundleRow,
	version: VersionRow,
): CapabilityBundleDetail {
	return {
		...rowToSummary(row, version),
		config: (version.config ?? {}) as CapabilityBundleConfig,
		configHash: version.configHash,
		changelog: version.changelog,
	};
}

export class PostgresCapabilityBundleRepository
	implements CapabilityBundleRepository
{
	constructor(private readonly database: Database = defaultDb) {}

	async listBundles(input: {
		projectId?: string | null;
		includeArchived?: boolean;
	}): Promise<CapabilityBundleSummary[]> {
		const database = requireDb(this.database);
		const filters: SQL[] = [];
		if (input.projectId !== undefined) {
			filters.push(
				input.projectId === null
					? isNull(capabilityBundles.projectId)
					: eq(capabilityBundles.projectId, input.projectId),
			);
		}
		if (!input.includeArchived) {
			filters.push(eq(capabilityBundles.isArchived, false));
		}
		const rows = await database
			.select()
			.from(capabilityBundles)
			.where(filters.length ? and(...filters) : undefined)
			.orderBy(desc(capabilityBundles.updatedAt));

		const out: CapabilityBundleSummary[] = [];
		for (const row of rows) {
			let version: VersionRow | null = null;
			if (row.currentVersionId) {
				[version] = await database
					.select()
					.from(capabilityBundleVersions)
					.where(eq(capabilityBundleVersions.id, row.currentVersionId))
					.limit(1);
			}
			out.push(rowToSummary(row, version ?? null));
		}
		return out;
	}

	async getBundle(id: string): Promise<CapabilityBundleDetail | null> {
		const database = requireDb(this.database);
		const [row] = await database
			.select()
			.from(capabilityBundles)
			.where(eq(capabilityBundles.id, id))
			.limit(1);
		if (!row) return null;
		const version = await this.getCurrentOrLatestVersion(id, row.currentVersionId);
		if (!version) return null;
		return rowToDetail(row, version);
	}

	async createBundle(
		input: CapabilityBundleCreateRecord,
	): Promise<CapabilityBundleDetail> {
		const database = requireDb(this.database);
		const slug = await this.ensureUniqueSlug(input.slugBase);
		const result = await database.transaction(async (tx) => {
			const [bundle] = await tx
				.insert(capabilityBundles)
				.values({
					slug,
					name: input.name,
					description: input.description,
					tags: input.tags,
					createdBy: input.createdBy,
					projectId: input.projectId,
				})
				.returning();
			const [version] = await tx
				.insert(capabilityBundleVersions)
				.values({
					bundleId: bundle.id,
					version: 1,
					config: input.config as unknown as Record<string, unknown>,
					configHash: input.configHash,
					publishedAt: new Date(),
					publishedBy: input.createdBy,
				})
				.returning();
			const [updated] = await tx
				.update(capabilityBundles)
				.set({ currentVersionId: version.id, updatedAt: new Date() })
				.where(eq(capabilityBundles.id, bundle.id))
				.returning();
			return { bundle: updated, version };
		});
		return rowToDetail(result.bundle, result.version);
	}

	async updateBundle(
		id: string,
		input: CapabilityBundleUpdateRecord,
	): Promise<CapabilityBundleDetail | null> {
		const database = requireDb(this.database);
		const [existing] = await database
			.select()
			.from(capabilityBundles)
			.where(eq(capabilityBundles.id, id))
			.limit(1);
		if (!existing) return null;

		const result = await database.transaction(async (tx) => {
			let version: VersionRow | null = null;
			if (input.config !== undefined && input.configHash) {
				const [{ maxVersion }] = await tx
					.select({
						maxVersion: sql<number>`coalesce(max(${capabilityBundleVersions.version}), 0)`,
					})
					.from(capabilityBundleVersions)
					.where(eq(capabilityBundleVersions.bundleId, id));
				const nextVersion = (Number(maxVersion) || 0) + 1;
				[version] = await tx
					.insert(capabilityBundleVersions)
					.values({
						bundleId: id,
						version: nextVersion,
						config: input.config as unknown as Record<string, unknown>,
						configHash: input.configHash,
						changelog: input.changelog ?? null,
						publishedAt: new Date(),
						publishedBy: input.publishedBy,
					})
					.returning();
			}
			const [updated] = await tx
				.update(capabilityBundles)
				.set({
					name: input.name ?? existing.name,
					description:
						input.description !== undefined
							? input.description
							: existing.description,
					tags: input.tags ?? existing.tags,
					...(version ? { currentVersionId: version.id } : {}),
					updatedAt: new Date(),
				})
				.where(eq(capabilityBundles.id, id))
				.returning();
			return { bundle: updated, version };
		});

		let version = result.version;
		if (!version && result.bundle.currentVersionId) {
			[version] = await database
				.select()
				.from(capabilityBundleVersions)
				.where(eq(capabilityBundleVersions.id, result.bundle.currentVersionId))
				.limit(1);
		}
		if (!version) return null;
		return rowToDetail(result.bundle, version);
	}

	async archiveBundle(id: string): Promise<boolean> {
		const database = requireDb(this.database);
		const [updated] = await database
			.update(capabilityBundles)
			.set({ isArchived: true, updatedAt: new Date() })
			.where(eq(capabilityBundles.id, id))
			.returning({ id: capabilityBundles.id });
		return !!updated;
	}

	private async ensureUniqueSlug(base: string): Promise<string> {
		const database = requireDb(this.database);
		let candidate = base || "bundle";
		let suffix = 1;
		while (true) {
			const [existing] = await database
				.select({ id: capabilityBundles.id })
				.from(capabilityBundles)
				.where(eq(capabilityBundles.slug, candidate))
				.limit(1);
			if (!existing) return candidate;
			suffix += 1;
			candidate = `${base}-${suffix}`;
		}
	}

	private async getCurrentOrLatestVersion(
		id: string,
		currentVersionId: string | null,
	): Promise<VersionRow | null> {
		const database = requireDb(this.database);
		let version: VersionRow | undefined;
		if (currentVersionId) {
			[version] = await database
				.select()
				.from(capabilityBundleVersions)
				.where(eq(capabilityBundleVersions.id, currentVersionId))
				.limit(1);
		}
		if (!version) {
			[version] = await database
				.select()
				.from(capabilityBundleVersions)
				.where(eq(capabilityBundleVersions.bundleId, id))
				.orderBy(desc(capabilityBundleVersions.version))
				.limit(1);
		}
		return version ?? null;
	}
}
