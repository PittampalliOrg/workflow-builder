import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	sandboxProfiles,
	environmentVersions,
	type SandboxProfile as SandboxProfileRow,
} from "$lib/server/db/schema";
import type {
	SandboxProfile,
	SandboxProfilePackages,
} from "$lib/types/sandbox-profiles";
import {
	BUILTIN_PROFILE_SLUGS,
	PROFILE_SLUG_REGEX,
} from "$lib/types/sandbox-profiles";
import { PACKAGE_MANAGERS } from "$lib/types/environments";

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

export class SandboxProfileValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxProfileValidationError";
	}
}

const PACKAGE_MANAGER_SET = new Set<string>(PACKAGE_MANAGERS);

// Package specs: alphanumerics + common pin syntax (== for pip, @ for npm,
// version literals). Matches the env validator pattern — anything the
// respective package manager would accept on the install CLI.
const PACKAGE_SPEC_RE = /^[a-zA-Z0-9._@/+=<>~-]+$/;
const CAPABILITY_RE = /^[a-z0-9-]+$/;

function validatePackages(packages: unknown): SandboxProfilePackages {
	if (packages === undefined || packages === null) return {};
	if (typeof packages !== "object" || Array.isArray(packages)) {
		throw new SandboxProfileValidationError(
			"packages must be an object keyed by manager name",
		);
	}
	const out: SandboxProfilePackages = {};
	for (const [manager, specs] of Object.entries(packages as Record<string, unknown>)) {
		if (!PACKAGE_MANAGER_SET.has(manager)) {
			throw new SandboxProfileValidationError(
				`packages.${manager} — unknown manager; expected one of ${PACKAGE_MANAGERS.join(", ")}`,
			);
		}
		if (!Array.isArray(specs)) {
			throw new SandboxProfileValidationError(
				`packages.${manager} must be an array of strings`,
			);
		}
		for (const spec of specs) {
			if (typeof spec !== "string" || !PACKAGE_SPEC_RE.test(spec)) {
				throw new SandboxProfileValidationError(
					`packages.${manager} entry "${String(spec)}" is not a valid package spec`,
				);
			}
		}
		(out as Record<string, string[]>)[manager] = specs as string[];
	}
	return out;
}

function validateCapabilities(caps: unknown): string[] {
	if (caps === undefined || caps === null) return [];
	if (!Array.isArray(caps)) {
		throw new SandboxProfileValidationError(
			"capabilities must be an array of lowercase-dash strings",
		);
	}
	for (const c of caps) {
		if (typeof c !== "string" || !CAPABILITY_RE.test(c)) {
			throw new SandboxProfileValidationError(
				`capability "${String(c)}" must match [a-z0-9-]+`,
			);
		}
	}
	return caps as string[];
}

function rowToProfile(row: SandboxProfileRow, usedByCount?: number): SandboxProfile {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description ?? null,
		baseProfileSlug: row.baseProfileSlug ?? null,
		packages: (row.packages ?? {}) as SandboxProfilePackages,
		capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
		dockerfilePath: row.dockerfilePath ?? null,
		imageTag: row.imageTag ?? null,
		lastBuild: {
			sha: row.lastBuildSha ?? null,
			at: row.lastBuildAt ? row.lastBuildAt.toISOString() : null,
			status: (row.lastBuildStatus as SandboxProfile["lastBuild"]["status"]) ?? null,
			error: row.lastBuildError ?? null,
		},
		isArchived: row.isArchived,
		isBuiltin: row.isBuiltin,
		usedByCount,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

export type ListProfilesFilter = {
	includeArchived?: boolean;
	projectId?: string;
};

export async function listProfiles(
	filter: ListProfilesFilter = {},
): Promise<SandboxProfile[]> {
	const database = requireDb();
	const conditions = [];
	if (!filter.includeArchived) conditions.push(eq(sandboxProfiles.isArchived, false));
	if (filter.projectId) conditions.push(eq(sandboxProfiles.projectId, filter.projectId));
	const rows = await database
		.select()
		.from(sandboxProfiles)
		.where(conditions.length ? and(...conditions) : undefined)
		.orderBy(asc(sandboxProfiles.name));
	if (rows.length === 0) return [];

	// usedByCount: number of environment_versions currently pointing at this
	// profile's slug via config.sandboxTemplate. Single pass — avoids N round
	// trips when the admin list has dozens of profiles.
	const slugs = rows.map((r) => r.slug);
	const envs = await database
		.select({
			envId: environmentVersions.environmentId,
			sandboxTemplate: environmentVersions.config,
		})
		.from(environmentVersions);
	const counts = new Map<string, number>();
	for (const e of envs) {
		const config = e.sandboxTemplate as { sandboxTemplate?: string };
		const tpl = config?.sandboxTemplate;
		if (tpl && slugs.includes(tpl)) {
			counts.set(tpl, (counts.get(tpl) ?? 0) + 1);
		}
	}
	return rows.map((r) => rowToProfile(r, counts.get(r.slug) ?? 0));
}

export async function getProfile(idOrSlug: string): Promise<SandboxProfile | null> {
	const database = requireDb();
	// Accept both internal id and human slug so the admin-UI edit route and
	// `environment.sandboxTemplate` lookups can share one endpoint.
	const [row] = await database
		.select()
		.from(sandboxProfiles)
		.where(
			sandboxProfiles.id === undefined
				? eq(sandboxProfiles.slug, idOrSlug)
				: eq(sandboxProfiles.id, idOrSlug),
		)
		.limit(1);
	let result = row;
	if (!result) {
		const [bySlug] = await database
			.select()
			.from(sandboxProfiles)
			.where(eq(sandboxProfiles.slug, idOrSlug))
			.limit(1);
		result = bySlug;
	}
	if (!result) return null;
	return rowToProfile(result);
}

export type CreateProfileInput = {
	slug: string;
	name: string;
	description?: string | null;
	baseProfileSlug?: string | null;
	packages?: SandboxProfilePackages;
	capabilities?: string[];
	isBuiltin?: boolean;
	createdBy?: string | null;
	projectId?: string | null;
};

export async function createProfile(
	input: CreateProfileInput,
): Promise<SandboxProfile> {
	const slug = input.slug.trim().toLowerCase();
	if (!PROFILE_SLUG_REGEX.test(slug)) {
		throw new SandboxProfileValidationError(
			`slug "${slug}" must match [a-z0-9-]+ (lowercase alnum + dashes)`,
		);
	}
	if (
		(BUILTIN_PROFILE_SLUGS as readonly string[]).includes(slug) &&
		!input.isBuiltin
	) {
		// Users can't steal builtin slugs — only the seeder (which sets
		// isBuiltin: true) is allowed to create them.
		throw new SandboxProfileValidationError(
			`slug "${slug}" is reserved for a built-in profile`,
		);
	}
	const packages = validatePackages(input.packages);
	const capabilities = validateCapabilities(input.capabilities);

	const database = requireDb();
	const [existing] = await database
		.select({ id: sandboxProfiles.id })
		.from(sandboxProfiles)
		.where(eq(sandboxProfiles.slug, slug))
		.limit(1);
	if (existing) {
		throw new SandboxProfileValidationError(
			`slug "${slug}" is already in use`,
		);
	}
	if (input.baseProfileSlug) {
		const [base] = await database
			.select({ id: sandboxProfiles.id, baseSlug: sandboxProfiles.baseProfileSlug })
			.from(sandboxProfiles)
			.where(eq(sandboxProfiles.slug, input.baseProfileSlug))
			.limit(1);
		if (!base) {
			throw new SandboxProfileValidationError(
				`base profile "${input.baseProfileSlug}" does not exist`,
			);
		}
		// Enforce 1-level inheritance — no chained bases. Keeps the Dockerfile
		// FROM resolution deterministic and avoids cycle detection.
		if (base.baseSlug) {
			throw new SandboxProfileValidationError(
				`base profile "${input.baseProfileSlug}" already inherits from another profile (1-level inheritance only)`,
			);
		}
	}

	const [row] = await database
		.insert(sandboxProfiles)
		.values({
			slug,
			name: input.name.trim(),
			description: input.description ?? null,
			baseProfileSlug: input.baseProfileSlug ?? null,
			packages,
			capabilities,
			isBuiltin: input.isBuiltin ?? false,
			createdBy: input.createdBy ?? null,
			projectId: input.projectId ?? null,
		})
		.returning();
	return rowToProfile(row);
}

export type UpdateProfileInput = {
	name?: string;
	description?: string | null;
	baseProfileSlug?: string | null;
	packages?: SandboxProfilePackages;
	capabilities?: string[];
};

export async function updateProfile(
	id: string,
	input: UpdateProfileInput,
): Promise<SandboxProfile | null> {
	const database = requireDb();
	const [existing] = await database
		.select()
		.from(sandboxProfiles)
		.where(eq(sandboxProfiles.id, id))
		.limit(1);
	if (!existing) return null;

	const patch: Partial<SandboxProfileRow> = { updatedAt: new Date() };
	if (input.name !== undefined) patch.name = input.name.trim();
	if (input.description !== undefined) patch.description = input.description;
	if (input.baseProfileSlug !== undefined) {
		patch.baseProfileSlug = input.baseProfileSlug;
	}
	let packagesChanged = false;
	if (input.packages !== undefined) {
		patch.packages = validatePackages(input.packages);
		packagesChanged =
			JSON.stringify(existing.packages) !== JSON.stringify(patch.packages);
	}
	if (input.capabilities !== undefined) {
		patch.capabilities = validateCapabilities(input.capabilities);
	}
	// If the package manifest changed the current image is stale. Flag the
	// lastBuildStatus so the admin UI shows an "outdated" pill and the
	// builder knows a rebuild is warranted.
	if (packagesChanged) {
		patch.lastBuildStatus = null;
		patch.lastBuildError = null;
	}

	const [row] = await database
		.update(sandboxProfiles)
		.set(patch)
		.where(eq(sandboxProfiles.id, id))
		.returning();
	return rowToProfile(row);
}

export async function archiveProfile(id: string): Promise<{
	archived: boolean;
	reason?: string;
}> {
	const database = requireDb();
	const [existing] = await database
		.select()
		.from(sandboxProfiles)
		.where(eq(sandboxProfiles.id, id))
		.limit(1);
	if (!existing) return { archived: false, reason: "not_found" };
	if (existing.isBuiltin) {
		return { archived: false, reason: "builtin_profile_cannot_be_archived" };
	}

	// Block archive when any active environment still references this profile.
	// Cascade would silently break those envs next sandbox-create; forcing
	// the admin to migrate first is the safe default.
	const usages = await findProfileUsages(existing.slug);
	if (usages.length > 0) {
		return {
			archived: false,
			reason: `profile is still referenced by ${usages.length} environment(s)`,
		};
	}

	await database
		.update(sandboxProfiles)
		.set({ isArchived: true, updatedAt: new Date() })
		.where(eq(sandboxProfiles.id, id));
	return { archived: true };
}

export type ProfileUsage = {
	environmentId: string;
	environmentVersion: number;
};

export async function findProfileUsages(slug: string): Promise<ProfileUsage[]> {
	const database = requireDb();
	// Sweeps environment_versions in one pass — config is JSONB so we drive
	// the filter via the `sandboxTemplate` top-level key.
	const rows = await database
		.select({
			envId: environmentVersions.environmentId,
			version: environmentVersions.version,
			config: environmentVersions.config,
		})
		.from(environmentVersions);
	const hits: ProfileUsage[] = [];
	for (const r of rows) {
		const tpl = (r.config as { sandboxTemplate?: string })?.sandboxTemplate;
		if (tpl === slug) {
			hits.push({
				environmentId: r.envId,
				environmentVersion: r.version,
			});
		}
	}
	return hits;
}

/**
 * Lifecycle helpers the Tekton-poll side of the admin console uses to stamp
 * build transitions. Kept narrow so callers can't accidentally change other
 * fields from a webhook handler.
 */
export async function markBuildStarted(id: string): Promise<void> {
	const database = requireDb();
	await database
		.update(sandboxProfiles)
		.set({
			lastBuildStatus: "building",
			lastBuildError: null,
			updatedAt: new Date(),
		})
		.where(eq(sandboxProfiles.id, id));
}

export async function markBuildSucceeded(
	id: string,
	params: { sha: string; imageTag: string; dockerfilePath: string },
): Promise<void> {
	const database = requireDb();
	await database
		.update(sandboxProfiles)
		.set({
			lastBuildStatus: "built",
			lastBuildSha: params.sha,
			imageTag: params.imageTag,
			dockerfilePath: params.dockerfilePath,
			lastBuildAt: new Date(),
			lastBuildError: null,
			updatedAt: new Date(),
		})
		.where(eq(sandboxProfiles.id, id));
}

export async function markBuildFailed(
	id: string,
	error: string,
): Promise<void> {
	const database = requireDb();
	await database
		.update(sandboxProfiles)
		.set({
			lastBuildStatus: "failed",
			lastBuildError: error,
			lastBuildAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(sandboxProfiles.id, id));
}
