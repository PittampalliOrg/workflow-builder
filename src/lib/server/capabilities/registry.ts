/**
 * Capability-bundle repository (Pillar 2) — CRUD + versioning for
 * `capability_bundles` / `capability_bundle_versions`. Mirrors the agents
 * registry (`$lib/server/agents/registry.ts`) shape: each write that changes the
 * config inserts a new immutable version row and repoints `currentVersionId`.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	capabilityBundles,
	capabilityBundleVersions,
} from "$lib/server/db/schema";
import { canonicalJson } from "$lib/server/agents/config-hash";
import type { CapabilityBundleConfig } from "$lib/types/agents";

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

export type CapabilityBundleSummary = {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	tags: string[];
	projectId: string | null;
	currentVersion: number | null;
	isArchived: boolean;
	createdAt: string;
	updatedAt: string;
};

export type CapabilityBundleDetail = CapabilityBundleSummary & {
	config: CapabilityBundleConfig;
	configHash: string;
	changelog: string | null;
};

export type CreateBundleInput = {
	slug?: string;
	name: string;
	description?: string | null;
	tags?: string[];
	config: CapabilityBundleConfig;
	createdBy?: string | null;
	projectId?: string | null;
};

export type UpdateBundleInput = {
	name?: string;
	description?: string | null;
	tags?: string[];
	config?: CapabilityBundleConfig;
	changelog?: string | null;
	publishedBy?: string | null;
};

function hashBundleConfig(config: CapabilityBundleConfig): string {
	return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

/** Light normalization: every capability surface a bundle declares is an array. */
function normalizeBundleConfig(config: CapabilityBundleConfig): CapabilityBundleConfig {
	const out: CapabilityBundleConfig = {};
	if (Array.isArray(config.mcpServers)) out.mcpServers = config.mcpServers;
	if (Array.isArray(config.skills)) out.skills = config.skills;
	if (Array.isArray(config.tools)) out.tools = config.tools.map((t) => String(t));
	if (Array.isArray(config.builtinTools)) out.builtinTools = config.builtinTools.map((t) => String(t));
	if (Array.isArray(config.plugins)) out.plugins = config.plugins.map((p) => String(p));
	if (Array.isArray(config.staticPromptPresetRefs)) out.staticPromptPresetRefs = config.staticPromptPresetRefs;
	if (Array.isArray(config.dynamicPromptPresetRefs)) out.dynamicPromptPresetRefs = config.dynamicPromptPresetRefs;
	if (config.hooks && typeof config.hooks === "object") out.hooks = config.hooks;
	return out;
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

async function ensureUniqueSlug(base: string): Promise<string> {
	const database = requireDb();
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

type BundleRow = typeof capabilityBundles.$inferSelect;
type VersionRow = typeof capabilityBundleVersions.$inferSelect;

function rowToSummary(row: BundleRow, version: VersionRow | null): CapabilityBundleSummary {
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

function rowToDetail(row: BundleRow, version: VersionRow): CapabilityBundleDetail {
	return {
		...rowToSummary(row, version),
		config: (version.config ?? {}) as CapabilityBundleConfig,
		configHash: version.configHash,
		changelog: version.changelog,
	};
}

export async function listBundles(opts?: {
	projectId?: string | null;
	includeArchived?: boolean;
}): Promise<CapabilityBundleSummary[]> {
	const database = requireDb();
	const filters = [];
	if (opts?.projectId !== undefined) {
		filters.push(
			opts.projectId === null
				? isNull(capabilityBundles.projectId)
				: eq(capabilityBundles.projectId, opts.projectId),
		);
	}
	if (!opts?.includeArchived) filters.push(eq(capabilityBundles.isArchived, false));
	const rows = await database
		.select()
		.from(capabilityBundles)
		.where(filters.length ? and(...filters) : undefined)
		.orderBy(desc(capabilityBundles.updatedAt));
	// Resolve each current version for the version label.
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

export async function getBundle(id: string): Promise<CapabilityBundleDetail | null> {
	const database = requireDb();
	const [row] = await database
		.select()
		.from(capabilityBundles)
		.where(eq(capabilityBundles.id, id))
		.limit(1);
	if (!row) return null;
	let version: VersionRow | undefined;
	if (row.currentVersionId) {
		[version] = await database
			.select()
			.from(capabilityBundleVersions)
			.where(eq(capabilityBundleVersions.id, row.currentVersionId))
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
	if (!version) return null;
	return rowToDetail(row, version);
}

export async function createBundle(input: CreateBundleInput): Promise<CapabilityBundleDetail> {
	const database = requireDb();
	const config = normalizeBundleConfig(input.config);
	const slug = await ensureUniqueSlug(input.slug?.trim() || slugify(input.name) || "bundle");
	const configHash = hashBundleConfig(config);

	const result = await database.transaction(async (tx) => {
		const [bundle] = await tx
			.insert(capabilityBundles)
			.values({
				slug,
				name: input.name,
				description: input.description ?? null,
				tags: input.tags ?? [],
				createdBy: input.createdBy ?? null,
				projectId: input.projectId ?? null,
			})
			.returning();
		const [version] = await tx
			.insert(capabilityBundleVersions)
			.values({
				bundleId: bundle.id,
				version: 1,
				config: config as unknown as Record<string, unknown>,
				configHash,
				publishedAt: new Date(),
				publishedBy: input.createdBy ?? null,
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

export async function updateBundle(
	id: string,
	input: UpdateBundleInput,
): Promise<CapabilityBundleDetail | null> {
	const database = requireDb();
	const [existing] = await database
		.select()
		.from(capabilityBundles)
		.where(eq(capabilityBundles.id, id))
		.limit(1);
	if (!existing) return null;

	const normalizedConfig =
		input.config !== undefined ? normalizeBundleConfig(input.config) : undefined;
	const result = await database.transaction(async (tx) => {
		let version: VersionRow | null = null;
		if (normalizedConfig !== undefined) {
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
					config: normalizedConfig as unknown as Record<string, unknown>,
					configHash: hashBundleConfig(normalizedConfig),
					changelog: input.changelog ?? null,
					publishedAt: new Date(),
					publishedBy: input.publishedBy ?? null,
				})
				.returning();
		}
		const [updated] = await tx
			.update(capabilityBundles)
			.set({
				name: input.name ?? existing.name,
				description: input.description !== undefined ? input.description : existing.description,
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

export async function archiveBundle(id: string): Promise<boolean> {
	const database = requireDb();
	const [updated] = await database
		.update(capabilityBundles)
		.set({ isArchived: true, updatedAt: new Date() })
		.where(eq(capabilityBundles.id, id))
		.returning({ id: capabilityBundles.id });
	return !!updated;
}
