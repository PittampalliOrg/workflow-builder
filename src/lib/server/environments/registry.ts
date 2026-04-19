import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	agents,
	environments,
	environmentVersions,
	type Environment,
	type EnvironmentVersion,
} from "$lib/server/db/schema";
import type {
	EnvironmentConfig,
	EnvironmentDetail,
	EnvironmentNetworking,
	EnvironmentRef,
	EnvironmentRuntime,
	EnvironmentSummary,
	EnvironmentVersionSummary,
} from "$lib/types/environments";
import {
	createDefaultEnvironmentConfig,
	PACKAGE_MANAGERS,
} from "$lib/types/environments";
import { hashEnvironmentConfig } from "./config-hash";

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

/**
 * Raised when a write-path caller submits an EnvironmentConfig whose
 * array-typed fields were stored as the wrong shape. Mirrors
 * AgentConfigValidationError and gets translated to HTTP 400 by the API
 * handlers. The openshell-agent-runtime policy renderer silently rejects
 * mis-shaped values (like the dapr-agents runtime does for agent config),
 * so catching this at the boundary keeps the sandbox-side assumptions simple.
 */
export class EnvironmentConfigValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EnvironmentConfigValidationError";
	}
}

const PACKAGE_MANAGER_SET = new Set(PACKAGE_MANAGERS);
// Conservative but permissive-enough for real package names + version pins:
// apt/deb names can have letters/digits/+ - . _, pip/npm add = @ /, cargo allows _
const PACKAGE_SPEC_RE = /^[a-zA-Z0-9._@/+-]+(?:==[^\s]+)?$/;
const BARE_HOST_RE = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export function validateEnvironmentConfig(config: unknown): void {
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		throw new EnvironmentConfigValidationError("config must be an object");
	}
	const c = config as Record<string, unknown>;

	const net = c.networking as Record<string, unknown> | undefined;
	if (!net || typeof net !== "object") {
		throw new EnvironmentConfigValidationError(
			"config.networking must be an object",
		);
	}
	const netType = net.type;
	if (netType !== "unrestricted" && netType !== "limited") {
		throw new EnvironmentConfigValidationError(
			`config.networking.type must be "unrestricted" or "limited" (got ${String(netType)})`,
		);
	}
	if (netType === "limited") {
		const hosts = net.allowedHosts;
		if (hosts !== undefined && hosts !== null) {
			if (!Array.isArray(hosts)) {
				throw new EnvironmentConfigValidationError(
					"config.networking.allowedHosts must be an array of strings",
				);
			}
			for (const h of hosts) {
				if (typeof h !== "string" || !BARE_HOST_RE.test(h)) {
					throw new EnvironmentConfigValidationError(
						`config.networking.allowedHosts entries must be bare hosts (no protocol/port): got "${String(h)}"`,
					);
				}
			}
		}
		for (const flag of ["allowMcpServers", "allowPackageManagers"] as const) {
			const v = net[flag];
			if (v !== undefined && v !== null && typeof v !== "boolean") {
				throw new EnvironmentConfigValidationError(
					`config.networking.${flag} must be a boolean`,
				);
			}
		}
	}

	const pkgs = c.packages;
	if (pkgs !== undefined && pkgs !== null) {
		if (!Array.isArray(pkgs)) {
			throw new EnvironmentConfigValidationError(
				"config.packages must be an array",
			);
		}
		for (const pkg of pkgs) {
			if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
				throw new EnvironmentConfigValidationError(
					"config.packages entries must be {manager, spec} objects",
				);
			}
			const p = pkg as Record<string, unknown>;
			if (typeof p.manager !== "string" || !PACKAGE_MANAGER_SET.has(p.manager as typeof PACKAGE_MANAGERS[number])) {
				throw new EnvironmentConfigValidationError(
					`config.packages.manager must be one of ${PACKAGE_MANAGERS.join(", ")} (got "${String(p.manager)}")`,
				);
			}
			if (typeof p.spec !== "string" || !PACKAGE_SPEC_RE.test(p.spec)) {
				throw new EnvironmentConfigValidationError(
					`config.packages.spec must match ${PACKAGE_SPEC_RE} (got "${String(p.spec)}")`,
				);
			}
		}
	}

	const meta = c.metadata;
	if (meta !== undefined && meta !== null) {
		if (typeof meta !== "object" || Array.isArray(meta)) {
			throw new EnvironmentConfigValidationError(
				"config.metadata must be an object of lowercase string keys",
			);
		}
		for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
			if (!/^[a-z0-9._-]+$/.test(k)) {
				throw new EnvironmentConfigValidationError(
					`config.metadata key "${k}" must be lowercase alphanumeric (with . _ -)`,
				);
			}
			if (typeof v !== "string") {
				throw new EnvironmentConfigValidationError(
					`config.metadata["${k}"] must be a string`,
				);
			}
		}
	}
}

function rowToSummary(
	row: Environment,
	currentVersion: number | null,
	config: EnvironmentConfig | null,
	usedByCount?: number,
): EnvironmentSummary {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description ?? null,
		avatar: row.avatar ?? null,
		tags: Array.isArray(row.tags) ? row.tags : [],
		runtime: row.runtime as EnvironmentRuntime,
		currentVersion,
		sandboxTemplate: config?.sandboxTemplate ?? null,
		networkingType: (config?.networking?.type as EnvironmentNetworking["type"]) ?? null,
		isArchived: row.isArchived,
		usedByCount,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function rowToDetail(
	row: Environment,
	version: EnvironmentVersion,
): EnvironmentDetail {
	const config = version.config as unknown as EnvironmentConfig;
	return {
		...rowToSummary(row, version.version, config),
		config,
	};
}

function versionToSummary(row: EnvironmentVersion): EnvironmentVersionSummary {
	return {
		id: row.id,
		environmentId: row.environmentId,
		version: row.version,
		configHash: row.configHash,
		changelog: row.changelog ?? null,
		publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
		publishedBy: row.publishedBy ?? null,
		createdAt: row.createdAt.toISOString(),
	};
}

export type ListEnvironmentsFilter = {
	q?: string;
	tag?: string;
	includeArchived?: boolean;
	projectId?: string;
};

export async function listEnvironments(
	filter: ListEnvironmentsFilter = {},
): Promise<EnvironmentSummary[]> {
	const database = requireDb();
	const conditions: ReturnType<typeof eq>[] = [];
	if (!filter.includeArchived) conditions.push(eq(environments.isArchived, false));
	if (filter.projectId) conditions.push(eq(environments.projectId, filter.projectId));

	const rows = await database
		.select()
		.from(environments)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(asc(environments.name));
	if (rows.length === 0) return [];

	const versionIds = rows
		.map((r) => r.currentVersionId)
		.filter((id): id is string => Boolean(id));
	const versionRows = versionIds.length
		? await database
				.select()
				.from(environmentVersions)
				.where(inArray(environmentVersions.id, versionIds))
		: [];
	const versionsById = new Map(versionRows.map((v) => [v.id, v]));

	const q = filter.q?.trim().toLowerCase();
	const tag = filter.tag?.trim().toLowerCase();

	return rows
		.map((row) => {
			const version = row.currentVersionId
				? versionsById.get(row.currentVersionId)
				: undefined;
			const config = version
				? (version.config as unknown as EnvironmentConfig)
				: null;
			return rowToSummary(row, version?.version ?? null, config);
		})
		.filter((summary) => {
			if (q) {
				const hay = `${summary.name} ${summary.slug} ${summary.description ?? ""}`.toLowerCase();
				if (!hay.includes(q)) return false;
			}
			if (tag) {
				const tags = summary.tags.map((t) => t.toLowerCase());
				if (!tags.includes(tag)) return false;
			}
			return true;
		});
}

export async function getEnvironment(
	id: string,
): Promise<EnvironmentDetail | null> {
	const database = requireDb();
	const [row] = await database
		.select()
		.from(environments)
		.where(eq(environments.id, id))
		.limit(1);
	if (!row) return null;
	if (!row.currentVersionId) {
		const fallback = createDefaultEnvironmentConfig();
		return {
			...rowToSummary(row, null, fallback),
			config: fallback,
		};
	}
	const [version] = await database
		.select()
		.from(environmentVersions)
		.where(eq(environmentVersions.id, row.currentVersionId))
		.limit(1);
	if (!version) return null;
	return rowToDetail(row, version);
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

async function ensureUniqueSlug(base: string): Promise<string> {
	const database = requireDb();
	let candidate = base;
	let suffix = 1;
	while (true) {
		const [existing] = await database
			.select({ id: environments.id })
			.from(environments)
			.where(eq(environments.slug, candidate))
			.limit(1);
		if (!existing) return candidate;
		suffix += 1;
		candidate = `${base}-${suffix}`;
	}
}

export type CreateEnvironmentInput = {
	slug?: string;
	name: string;
	description?: string | null;
	avatar?: string | null;
	tags?: string[];
	createdBy?: string | null;
	projectId?: string | null;
	config: EnvironmentConfig;
};

export async function createEnvironment(
	input: CreateEnvironmentInput,
): Promise<EnvironmentDetail> {
	validateEnvironmentConfig(input.config);
	const database = requireDb();
	const desiredSlug = input.slug?.trim() || slugify(input.name) || "environment";
	const slug = await ensureUniqueSlug(desiredSlug);
	const configHash = hashEnvironmentConfig(input.config);

	const result = await database.transaction(async (tx) => {
		const [env] = await tx
			.insert(environments)
			.values({
				slug,
				name: input.name,
				description: input.description ?? null,
				avatar: input.avatar ?? null,
				tags: input.tags ?? [],
				createdBy: input.createdBy ?? null,
				projectId: input.projectId ?? null,
			})
			.returning();
		const [version] = await tx
			.insert(environmentVersions)
			.values({
				environmentId: env.id,
				version: 1,
				config: input.config as unknown as Record<string, unknown>,
				configHash,
				publishedAt: new Date(),
				publishedBy: input.createdBy ?? null,
			})
			.returning();
		const [updated] = await tx
			.update(environments)
			.set({ currentVersionId: version.id, updatedAt: new Date() })
			.where(eq(environments.id, env.id))
			.returning();
		return { env: updated, version };
	});
	return rowToDetail(result.env, result.version);
}

export type UpdateEnvironmentInput = {
	name?: string;
	description?: string | null;
	avatar?: string | null;
	tags?: string[];
	config?: EnvironmentConfig;
	changelog?: string | null;
	publishedBy?: string | null;
};

export async function updateEnvironment(
	id: string,
	input: UpdateEnvironmentInput,
): Promise<EnvironmentDetail | null> {
	if (input.config !== undefined) validateEnvironmentConfig(input.config);
	const database = requireDb();
	const [existing] = await database
		.select()
		.from(environments)
		.where(eq(environments.id, id))
		.limit(1);
	if (!existing) return null;

	const shouldBumpVersion = input.config !== undefined;
	const result = await database.transaction(async (tx) => {
		let newVersion: EnvironmentVersion | null = null;
		if (shouldBumpVersion && input.config) {
			const [{ maxVersion }] = await tx
				.select({
					maxVersion: sql<number>`coalesce(max(${environmentVersions.version}), 0)`,
				})
				.from(environmentVersions)
				.where(eq(environmentVersions.environmentId, id));
			const nextVersionNumber = (Number(maxVersion) || 0) + 1;
			const configHash = hashEnvironmentConfig(input.config);
			const [inserted] = await tx
				.insert(environmentVersions)
				.values({
					environmentId: id,
					version: nextVersionNumber,
					config: input.config as unknown as Record<string, unknown>,
					configHash,
					changelog: input.changelog ?? null,
					publishedAt: new Date(),
					publishedBy: input.publishedBy ?? null,
				})
				.returning();
			newVersion = inserted;
		}

		const patch: Partial<Environment> & { updatedAt: Date } = {
			updatedAt: new Date(),
		};
		if (input.name !== undefined) patch.name = input.name;
		if (input.description !== undefined) patch.description = input.description;
		if (input.avatar !== undefined) patch.avatar = input.avatar;
		if (input.tags !== undefined) patch.tags = input.tags;
		if (newVersion) patch.currentVersionId = newVersion.id;

		const [updated] = await tx
			.update(environments)
			.set(patch)
			.where(eq(environments.id, id))
			.returning();

		const versionToReturn =
			newVersion ??
			(updated.currentVersionId
				? (
						await tx
							.select()
							.from(environmentVersions)
							.where(eq(environmentVersions.id, updated.currentVersionId))
							.limit(1)
					)[0]
				: null);
		return { env: updated, version: versionToReturn };
	});

	if (!result.version) {
		const fallback = createDefaultEnvironmentConfig();
		return {
			...rowToSummary(result.env, null, fallback),
			config: fallback,
		};
	}
	return rowToDetail(result.env, result.version);
}

export async function archiveEnvironment(id: string): Promise<boolean> {
	const database = requireDb();
	const [row] = await database
		.update(environments)
		.set({ isArchived: true, updatedAt: new Date() })
		.where(eq(environments.id, id))
		.returning({ id: environments.id });
	return Boolean(row);
}

export async function duplicateEnvironment(
	id: string,
	opts: {
		name?: string;
		createdBy?: string | null;
		projectId?: string | null;
	} = {},
): Promise<EnvironmentDetail | null> {
	const existing = await getEnvironment(id);
	if (!existing) return null;
	const name = opts.name?.trim() || `${existing.name} (copy)`;
	return createEnvironment({
		name,
		description: existing.description,
		avatar: existing.avatar,
		tags: existing.tags,
		createdBy: opts.createdBy ?? null,
		projectId: opts.projectId ?? null,
		config: existing.config,
	});
}

export async function listVersions(
	environmentId: string,
): Promise<EnvironmentVersionSummary[]> {
	const database = requireDb();
	const rows = await database
		.select()
		.from(environmentVersions)
		.where(eq(environmentVersions.environmentId, environmentId))
		.orderBy(desc(environmentVersions.version));
	return rows.map(versionToSummary);
}

export async function getVersion(
	environmentId: string,
	version: number,
): Promise<{ summary: EnvironmentVersionSummary; config: EnvironmentConfig } | null> {
	const database = requireDb();
	const [row] = await database
		.select()
		.from(environmentVersions)
		.where(
			and(
				eq(environmentVersions.environmentId, environmentId),
				eq(environmentVersions.version, version),
			),
		)
		.limit(1);
	if (!row) return null;
	return {
		summary: versionToSummary(row),
		config: row.config as unknown as EnvironmentConfig,
	};
}

export async function restoreVersion(
	environmentId: string,
	version: number,
	userId?: string | null,
): Promise<EnvironmentDetail | null> {
	const source = await getVersion(environmentId, version);
	if (!source) return null;
	return updateEnvironment(environmentId, {
		config: source.config,
		changelog: `Restored from v${version}`,
		publishedBy: userId ?? null,
	});
}

export type ResolvedEnvironment = {
	id: string;
	slug: string;
	version: number;
	config: EnvironmentConfig;
};

export async function resolveEnvironmentRef(
	ref: EnvironmentRef,
): Promise<ResolvedEnvironment | null> {
	const database = requireDb();
	const [env] = await database
		.select()
		.from(environments)
		.where(eq(environments.id, ref.id))
		.limit(1);
	if (!env) return null;

	let version: EnvironmentVersion | undefined;
	if (typeof ref.version === "number") {
		const [row] = await database
			.select()
			.from(environmentVersions)
			.where(
				and(
					eq(environmentVersions.environmentId, env.id),
					eq(environmentVersions.version, ref.version),
				),
			)
			.limit(1);
		version = row;
	} else if (env.currentVersionId) {
		const [row] = await database
			.select()
			.from(environmentVersions)
			.where(eq(environmentVersions.id, env.currentVersionId))
			.limit(1);
		version = row;
	}
	if (!version) return null;

	return {
		id: env.id,
		slug: env.slug,
		version: version.version,
		config: version.config as unknown as EnvironmentConfig,
	};
}

export type EnvironmentUsage = {
	agentId: string;
	agentName: string;
	agentSlug: string;
};

/**
 * Find agents that point at this environment. Used to render "Used by N agents"
 * on the environment editor and to block archive when referenced.
 */
export async function findEnvironmentUsages(
	environmentId: string,
): Promise<EnvironmentUsage[]> {
	const database = requireDb();
	const rows = await database
		.select({ id: agents.id, name: agents.name, slug: agents.slug })
		.from(agents)
		.where(eq(agents.environmentId, environmentId));
	return rows.map((r) => ({
		agentId: r.id,
		agentName: r.name,
		agentSlug: r.slug,
	}));
}
