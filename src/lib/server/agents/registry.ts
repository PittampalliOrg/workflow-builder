import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	agents,
	agentVersions,
	workflows,
	type Agent,
	type AgentVersion,
} from "$lib/server/db/schema";
import type {
	AgentConfig,
	AgentDetail,
	AgentRef,
	AgentRuntime,
	AgentSummary,
	AgentVersionSummary,
} from "$lib/types/agents";
import { createDefaultAgentConfig } from "$lib/types/agents";
import { safeRegisterAgentVersionInMlflow } from "$lib/server/observability/mlflow-lifecycle";
import { hashAgentConfig } from "./config-hash";
import { safeSyncOnArchive, safeSyncOnPublish } from "./registry-sync";

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

/**
 * Raised when a write-path caller submits an AgentConfig whose array-typed
 * fields were stored as the wrong shape (string, object, etc). The dapr-agents
 * runtime silently drops mis-shaped values (see main.py:1594 `isinstance(...,
 * list)` guard), so without validation we accumulate DB rows the agent never
 * actually reads. Route handlers should translate this into a 400.
 */
export class AgentConfigValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentConfigValidationError";
	}
}

const ARRAY_OF_STRING_FIELDS = [
	"builtinTools",
	"plugins",
	"compiledStaticPresetSections",
	"compiledDynamicPresetSections",
] as const;

const ARRAY_FIELDS = [
	"skills",
	"mcpServers",
	"callableAgents",
	"tools",
	"staticPromptPresetRefs",
	"dynamicPromptPresetRefs",
] as const;

function cleanString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanStringArray(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		return value
			.map((item) => (typeof item === "string" ? item.trim() : String(item).trim()))
			.filter(Boolean);
	}
	if (typeof value === "string") {
		return value
			.split(/\r?\n/)
			.map((item) => item.trim())
			.filter(Boolean);
	}
	return undefined;
}

/**
 * Normalize legacy import/export aliases into the canonical flat AgentConfig
 * fields before validation and hashing. We keep unknown fields intact for
 * forward compatibility, but persona/instruction fields have one canonical
 * spelling in storage.
 */
export function normalizeAgentConfig(config: AgentConfig): AgentConfig {
	const raw = { ...(config as unknown as Record<string, unknown>) };
	const aliases: Array<[string, keyof AgentConfig]> = [
		["system_prompt", "systemPrompt"],
		["max_iterations", "maxTurns"],
		["mcp_servers", "mcpServers"],
		["builtin_tools", "builtinTools"],
		["allowedTools", "tools"],
		["allowed_tools", "tools"],
		["model", "modelSpec"],
	];
	for (const [legacy, canonical] of aliases) {
		if (raw[canonical] === undefined && raw[legacy] !== undefined) {
			raw[canonical] = raw[legacy];
		}
		if (legacy in raw) delete raw[legacy];
	}

	// Strip retired persona fields (role/goal/instructions/styleGuidelines/
	// customSystemPrompt/appendSystemPrompt) — drizzle migration 0061
	// coalesced them into `systemPrompt` for existing rows; this guard keeps
	// them out of any future config writes that smuggle them in.
	for (const legacyKey of [
		"role",
		"goal",
		"instructions",
		"styleGuidelines",
		"customSystemPrompt",
		"appendSystemPrompt",
	]) {
		if (legacyKey in raw) delete raw[legacyKey];
	}

	for (const key of [
		"systemPrompt",
		"modelSpec",
		"cwd",
	] as const) {
		const normalized = cleanString(raw[key]);
		if (normalized !== undefined) raw[key] = normalized;
		else if (raw[key] !== undefined) delete raw[key];
	}
	for (const key of ARRAY_OF_STRING_FIELDS) {
		const normalized = cleanStringArray(raw[key]);
		if (normalized !== undefined) raw[key] = normalized;
		else if (raw[key] !== undefined) delete raw[key];
	}
	if (raw.tools !== undefined) {
		const normalized = cleanStringArray(raw.tools);
		if (normalized !== undefined) raw.tools = normalized;
		else delete raw.tools;
	}
	// cacheTtl: accept the two Anthropic-supported values; drop anything else.
	if (raw.cacheTtl !== undefined && raw.cacheTtl !== "5m" && raw.cacheTtl !== "1h") {
		delete raw.cacheTtl;
	}
	return raw as unknown as AgentConfig;
}

/**
 * Validate array-typed fields on AgentConfig match the runtime's expectations.
 * Throws AgentConfigValidationError on mismatch. Does NOT mutate; callers are
 * responsible for normalization if they want to coerce.
 */
export function validateAgentConfig(config: unknown): void {
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		throw new AgentConfigValidationError("config must be an object");
	}
	const c = config as Record<string, unknown>;
	for (const key of ARRAY_OF_STRING_FIELDS) {
		const v = c[key];
		if (v === undefined || v === null) continue;
		if (!Array.isArray(v)) {
			throw new AgentConfigValidationError(
				`config.${key} must be an array of strings (got ${typeof v})`,
			);
		}
		for (const item of v) {
			if (typeof item !== "string") {
				throw new AgentConfigValidationError(
					`config.${key} must contain only strings`,
				);
			}
		}
	}
	for (const key of ARRAY_FIELDS) {
		const v = c[key];
		if (v === undefined || v === null) continue;
		if (!Array.isArray(v)) {
			throw new AgentConfigValidationError(
				`config.${key} must be an array (got ${typeof v})`,
			);
		}
	}
}

function rowToSummary(
	row: Agent,
	currentVersion: number | null,
	config: AgentConfig | null,
	configHash: string | null = null,
	usedByCount?: number,
): AgentSummary {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description ?? null,
		avatar: row.avatar ?? null,
		tags: Array.isArray(row.tags) ? row.tags : [],
		runtime: row.runtime as AgentRuntime,
		currentVersion,
		currentConfigHash: configHash,
		modelSpec: config?.modelSpec ?? null,
		environmentId: row.environmentId ?? null,
		environmentVersion: row.environmentVersion ?? null,
		defaultVaultIds: Array.isArray(row.defaultVaultIds) ? row.defaultVaultIds : [],
		isArchived: row.isArchived,
		usedByCount,
		registryStatus: (row.registryStatus ?? "unregistered") as AgentSummary["registryStatus"],
		registrySyncedAt: row.registrySyncedAt ? row.registrySyncedAt.toISOString() : null,
		registryError: row.registryError ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function rowToDetail(
	row: Agent,
	version: AgentVersion,
): AgentDetail {
	const config = version.config as unknown as AgentConfig;
	return {
		...rowToSummary(row, version.version, config, version.configHash),
		config,
		sourceTemplateSlug: row.sourceTemplateSlug ?? null,
		sourceTemplateVersion: row.sourceTemplateVersion ?? null,
	};
}

function versionToSummary(row: AgentVersion): AgentVersionSummary {
	return {
		id: row.id,
		agentId: row.agentId,
		version: row.version,
		configHash: row.configHash,
		changelog: row.changelog ?? null,
		publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
		publishedBy: row.publishedBy ?? null,
		createdAt: row.createdAt.toISOString(),
	};
}

export type ListAgentsFilter = {
	q?: string;
	tag?: string;
	includeArchived?: boolean;
	/** Scope to a specific workspace/project. When set, only agents
	 * stamped with this projectId are returned. Rows created before the
	 * project_scope migration got backfilled to the oldest project, so
	 * legacy data isn't hidden from single-workspace users. */
	projectId?: string;
	/** Include workflow-spawned ephemeral agents (tagged
	 * "workflow-ephemeral" by `findOrCreateEphemeralAgent`). Default false
	 * — per CMA alignment these shells represent sessions, not user-owned
	 * agents, and shouldn't pollute the workspace Agents list. */
	includeEphemeral?: boolean;
};

export async function listAgents(
	filter: ListAgentsFilter = {},
): Promise<AgentSummary[]> {
	const database = requireDb();
	const conditions: unknown[] = [];
	if (!filter.includeArchived) conditions.push(eq(agents.isArchived, false));
	if (filter.projectId) conditions.push(eq(agents.projectId, filter.projectId));
	if (!filter.includeEphemeral) {
		// agents.tags is JSONB; use the @> containment operator.
		conditions.push(
			sql`NOT (${agents.tags} @> '["workflow-ephemeral"]'::jsonb)`,
		);
	}

	const rows = await database
		.select()
		.from(agents)
		// biome-ignore lint/suspicious/noExplicitAny: mixed drizzle SQL expression types in conditions array
		.where(conditions.length > 0 ? and(...(conditions as any[])) : undefined)
		.orderBy(asc(agents.name));

	if (rows.length === 0) return [];

	const versionIds = rows
		.map((r) => r.currentVersionId)
		.filter((id): id is string => Boolean(id));
	const versionRows = versionIds.length
		? await database
				.select()
				.from(agentVersions)
				.where(inArray(agentVersions.id, versionIds))
		: [];
	const versionsById = new Map(versionRows.map((v) => [v.id, v]));

	const q = filter.q?.trim().toLowerCase();
	const tag = filter.tag?.trim().toLowerCase();

	const summaries = rows
		.map((row) => {
			const version = row.currentVersionId
				? versionsById.get(row.currentVersionId)
				: undefined;
			const config = version ? (version.config as unknown as AgentConfig) : null;
			return rowToSummary(
				row,
				version?.version ?? null,
				config,
				version?.configHash ?? null,
			);
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

	return summaries;
}

export async function getAgent(id: string): Promise<AgentDetail | null> {
	const database = requireDb();
	const [row] = await database
		.select()
		.from(agents)
		.where(eq(agents.id, id))
		.limit(1);
	if (!row) return null;
	if (!row.currentVersionId) {
		const fallback = createDefaultAgentConfig();
		return {
			...rowToSummary(row, null, fallback),
			config: fallback,
			sourceTemplateSlug: row.sourceTemplateSlug ?? null,
			sourceTemplateVersion: row.sourceTemplateVersion ?? null,
		};
	}
	const [version] = await database
		.select()
		.from(agentVersions)
		.where(eq(agentVersions.id, row.currentVersionId))
		.limit(1);
	if (!version) return null;
	return rowToDetail(row, version);
}

export async function getAgentBySlug(
	slug: string,
): Promise<AgentDetail | null> {
	const database = requireDb();
	const [row] = await database
		.select()
		.from(agents)
		.where(eq(agents.slug, slug))
		.limit(1);
	if (!row) return null;
	return getAgent(row.id);
}

export type CreateAgentInput = {
	slug?: string;
	name: string;
	description?: string | null;
	avatar?: string | null;
	tags?: string[];
	runtime?: AgentRuntime;
	environmentId?: string | null;
	environmentVersion?: number | null;
	defaultVaultIds?: string[];
	sourceTemplateSlug?: string | null;
	sourceTemplateVersion?: number | null;
	createdBy?: string | null;
	projectId?: string | null;
	config: AgentConfig;
};

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

export async function createAgent(
	input: CreateAgentInput,
): Promise<AgentDetail> {
	const normalizedConfig = normalizeAgentConfig(input.config);
	validateAgentConfig(normalizedConfig);
	const database = requireDb();
	const desiredSlug = input.slug?.trim() || slugify(input.name) || "agent";
	const slug = await ensureUniqueSlug(desiredSlug);
	const configHash = hashAgentConfig(normalizedConfig);
	const runtime = input.runtime ?? "dapr-agent-py";

	const result = await database.transaction(async (tx) => {
		const [agent] = await tx
			.insert(agents)
			.values({
				slug,
				name: input.name,
				description: input.description ?? null,
				avatar: input.avatar ?? null,
				tags: input.tags ?? [],
				runtime,
				environmentId: input.environmentId ?? null,
				environmentVersion: input.environmentVersion ?? null,
				defaultVaultIds: input.defaultVaultIds ?? [],
				sourceTemplateSlug: input.sourceTemplateSlug ?? null,
				sourceTemplateVersion: input.sourceTemplateVersion ?? null,
				createdBy: input.createdBy ?? null,
				projectId: input.projectId ?? null,
			})
			.returning();

		const [version] = await tx
			.insert(agentVersions)
			.values({
				agentId: agent.id,
				version: 1,
				config: normalizedConfig as unknown as Record<string, unknown>,
				configHash,
				publishedAt: new Date(),
				publishedBy: input.createdBy ?? null,
			})
			.returning();

		const [updated] = await tx
			.update(agents)
			.set({ currentVersionId: version.id, updatedAt: new Date() })
			.where(eq(agents.id, agent.id))
			.returning();

		return { agent: updated, version };
	});

	void safeRegisterAgentVersionInMlflow(result);
	void safeSyncOnPublish(result.agent.id);
	return rowToDetail(result.agent, result.version);
}

async function ensureUniqueSlug(base: string): Promise<string> {
	const database = requireDb();
	let candidate = base;
	let suffix = 1;
	while (true) {
		const [existing] = await database
			.select({ id: agents.id })
			.from(agents)
			.where(eq(agents.slug, candidate))
			.limit(1);
		if (!existing) return candidate;
		suffix += 1;
		candidate = `${base}-${suffix}`;
	}
}

export type UpdateAgentInput = {
	name?: string;
	description?: string | null;
	avatar?: string | null;
	tags?: string[];
	runtime?: AgentRuntime;
	environmentId?: string | null;
	environmentVersion?: number | null;
	defaultVaultIds?: string[];
	config?: AgentConfig;
	changelog?: string | null;
	publishedBy?: string | null;
};

export async function updateAgent(
	id: string,
	input: UpdateAgentInput,
): Promise<AgentDetail | null> {
	const normalizedInputConfig =
		input.config !== undefined ? normalizeAgentConfig(input.config) : undefined;
	if (normalizedInputConfig !== undefined) validateAgentConfig(normalizedInputConfig);
	const database = requireDb();
	const [existing] = await database
		.select()
		.from(agents)
		.where(eq(agents.id, id))
		.limit(1);
	if (!existing) return null;

	const shouldBumpVersion = input.config !== undefined;
	const result = await database.transaction(async (tx) => {
		let newVersion: AgentVersion | null = null;
		if (shouldBumpVersion && normalizedInputConfig) {
			const [{ maxVersion }] = await tx
				.select({
					maxVersion: sql<number>`coalesce(max(${agentVersions.version}), 0)`,
				})
				.from(agentVersions)
				.where(eq(agentVersions.agentId, id));
			const nextVersionNumber = (Number(maxVersion) || 0) + 1;
			const configHash = hashAgentConfig(normalizedInputConfig);
			const [inserted] = await tx
				.insert(agentVersions)
				.values({
					agentId: id,
					version: nextVersionNumber,
					config: normalizedInputConfig as unknown as Record<string, unknown>,
					configHash,
					changelog: input.changelog ?? null,
					publishedAt: new Date(),
					publishedBy: input.publishedBy ?? null,
				})
				.returning();
			newVersion = inserted;
		}

		const patch: Partial<Agent> & { updatedAt: Date } = { updatedAt: new Date() };
		if (input.name !== undefined) patch.name = input.name;
		if (input.description !== undefined) patch.description = input.description;
		if (input.avatar !== undefined) patch.avatar = input.avatar;
		if (input.tags !== undefined) patch.tags = input.tags;
		if (input.runtime !== undefined) patch.runtime = input.runtime;
		if (input.environmentId !== undefined) patch.environmentId = input.environmentId;
		if (input.environmentVersion !== undefined)
			patch.environmentVersion = input.environmentVersion;
		if (input.defaultVaultIds !== undefined)
			patch.defaultVaultIds = input.defaultVaultIds;
		if (newVersion) patch.currentVersionId = newVersion.id;

		const [updated] = await tx
			.update(agents)
			.set(patch)
			.where(eq(agents.id, id))
			.returning();

		const versionToReturn =
			newVersion ??
			(updated.currentVersionId
				? (
						await tx
							.select()
							.from(agentVersions)
							.where(eq(agentVersions.id, updated.currentVersionId))
							.limit(1)
					)[0]
				: null);
		return { agent: updated, version: versionToReturn };
	});

	// Only re-sync if the config changed (new version published) or identity
	// fields that the registry mirrors (name, runtime) were touched. Tag /
	// avatar / description updates don't need a registry write.
	const shouldSync =
		shouldBumpVersion ||
		input.name !== undefined ||
		input.runtime !== undefined;
	if (shouldSync) void safeSyncOnPublish(id);
	if (result.version && shouldBumpVersion) {
		void safeRegisterAgentVersionInMlflow({
			agent: result.agent,
			version: result.version,
		});
	}

	if (!result.version) {
		const fallback = createDefaultAgentConfig();
		return {
			...rowToSummary(result.agent, null, fallback),
			config: fallback,
			sourceTemplateSlug: result.agent.sourceTemplateSlug ?? null,
			sourceTemplateVersion: result.agent.sourceTemplateVersion ?? null,
		};
	}
	return rowToDetail(result.agent, result.version);
}

export async function archiveAgent(id: string): Promise<boolean> {
	const database = requireDb();
	const [row] = await database
		.update(agents)
		.set({ isArchived: true, updatedAt: new Date() })
		.where(eq(agents.id, id))
		.returning({ id: agents.id });
	if (!row) return false;
	void safeSyncOnArchive(id);
	return true;
}

export async function duplicateAgent(
	id: string,
	opts: {
		name?: string;
		description?: string | null;
		createdBy?: string | null;
		projectId?: string | null;
	} = {},
): Promise<AgentDetail | null> {
	const existing = await getAgent(id);
	if (!existing) return null;
	const name = opts.name?.trim() || `${existing.name} (copy)`;
	const description =
		opts.description !== undefined ? opts.description : existing.description;
	return createAgent({
		name,
		description,
		avatar: existing.avatar,
		tags: existing.tags,
		runtime: existing.runtime,
		sourceTemplateSlug: existing.sourceTemplateSlug ?? undefined,
		sourceTemplateVersion: existing.sourceTemplateVersion ?? undefined,
		createdBy: opts.createdBy ?? null,
		projectId: opts.projectId ?? null,
		config: existing.config,
	});
}

export async function listVersions(
	agentId: string,
): Promise<AgentVersionSummary[]> {
	const database = requireDb();
	const rows = await database
		.select()
		.from(agentVersions)
		.where(eq(agentVersions.agentId, agentId))
		.orderBy(desc(agentVersions.version));
	return rows.map(versionToSummary);
}

export async function getVersion(
	agentId: string,
	version: number,
): Promise<{ summary: AgentVersionSummary; config: AgentConfig } | null> {
	const database = requireDb();
	const [row] = await database
		.select()
		.from(agentVersions)
		.where(
			and(eq(agentVersions.agentId, agentId), eq(agentVersions.version, version)),
		)
		.limit(1);
	if (!row) return null;
	return {
		summary: versionToSummary(row),
		config: row.config as unknown as AgentConfig,
	};
}

export async function restoreVersion(
	agentId: string,
	version: number,
	userId?: string | null,
): Promise<AgentDetail | null> {
	const source = await getVersion(agentId, version);
	if (!source) return null;
	return updateAgent(agentId, {
		config: source.config,
		changelog: `Restored from v${version}`,
		publishedBy: userId ?? null,
	});
}

export type ResolvedAgent = {
	id: string;
	slug: string;
	version: number;
	configHash: string;
	config: AgentConfig;
	environmentId: string | null;
	environmentVersion: number | null;
	defaultVaultIds: string[];
	projectId: string | null;
	runtime: AgentRuntime;
	/** Per-agent sandbox runtime app-id, e.g. agent-runtime-<slug>. Null
	 *  for unpublished agents; resolver stamps this into the durable/run
	 *  body for orchestrator routing. */
	runtimeAppId: string | null;
	registryStatus: string;
};

export async function resolveAgentRef(
	ref: AgentRef & { slug?: string },
): Promise<ResolvedAgent | null> {
	const database = requireDb();
	// Lookup by id when present, else by slug. Workflow specs authored by
	// scripts / templates often stamp only slug; the DB-side id is
	// resolved here so the rest of the resolver works uniformly.
	const refSlug = typeof ref.slug === "string" ? ref.slug.trim() : "";
	const refId = typeof ref.id === "string" ? ref.id.trim() : "";
	const [agent] = refId
		? await database.select().from(agents).where(eq(agents.id, refId)).limit(1)
		: refSlug
			? await database.select().from(agents).where(eq(agents.slug, refSlug)).limit(1)
			: [];
	if (!agent) return null;

	let version: AgentVersion | undefined;
	if (typeof ref.version === "number") {
		const [row] = await database
			.select()
			.from(agentVersions)
			.where(
				and(
					eq(agentVersions.agentId, agent.id),
					eq(agentVersions.version, ref.version),
				),
			)
			.limit(1);
		version = row;
	} else if (agent.currentVersionId) {
		const [row] = await database
			.select()
			.from(agentVersions)
			.where(eq(agentVersions.id, agent.currentVersionId))
			.limit(1);
		version = row;
	}
	if (!version) return null;

	return {
		id: agent.id,
		slug: agent.slug,
		version: version.version,
		configHash: version.configHash,
		config: version.config as unknown as AgentConfig,
		environmentId: agent.environmentId ?? null,
		environmentVersion: agent.environmentVersion ?? null,
		defaultVaultIds: Array.isArray(agent.defaultVaultIds)
			? agent.defaultVaultIds
			: [],
		projectId: agent.projectId ?? null,
		runtime: agent.runtime as AgentRuntime,
		runtimeAppId: agent.runtimeAppId ?? null,
		registryStatus: agent.registryStatus ?? "unregistered",
	};
}

/**
 * Resolve a list of peer-agent slugs against the Dapr registry scope
 * (`projectId` == team). Only returns peers that are currently
 * `registry_status = 'registered'` — stale-state peers are silently
 * dropped so a misconfigured workspace doesn't hang a running workflow.
 * Returns rows in the order of `slugs`; missing slugs are simply absent
 * from the output array.
 */
export async function resolveCallableAgents(
	projectId: string,
	slugs: string[],
): Promise<
	Array<{
		slug: string;
		agentId: string;
		version: number;
		runtime: AgentRuntime;
		runtimeAppId: string | null;
	}>
> {
	if (slugs.length === 0) return [];
	const database = requireDb();
	const rows = await database
		.select({
			id: agents.id,
			slug: agents.slug,
			runtime: agents.runtime,
			runtimeAppId: agents.runtimeAppId,
			currentVersionId: agents.currentVersionId,
			registryStatus: agents.registryStatus,
			isArchived: agents.isArchived,
		})
		.from(agents)
		.where(
			and(
				eq(agents.projectId, projectId),
				eq(agents.isArchived, false),
				inArray(agents.slug, slugs),
			),
		);
	const versionIds = rows
		.filter((r) => r.registryStatus === "registered" && r.currentVersionId)
		.map((r) => r.currentVersionId as string);
	if (versionIds.length === 0) return [];
	const versionRows = await database
		.select({ id: agentVersions.id, version: agentVersions.version })
		.from(agentVersions)
		.where(inArray(agentVersions.id, versionIds));
	const versionsById = new Map(versionRows.map((v) => [v.id, v.version]));
	const bySlug = new Map(
		rows
			.filter((r) => r.registryStatus === "registered" && r.currentVersionId)
			.map((r) => [
				r.slug,
				{
					slug: r.slug,
					agentId: r.id,
					version: versionsById.get(r.currentVersionId as string) ?? 1,
					runtime: r.runtime as AgentRuntime,
					runtimeAppId: r.runtimeAppId ?? null,
				},
			]),
	);
	return slugs
		.map((s) => bySlug.get(s))
		.filter((x): x is NonNullable<typeof x> => Boolean(x));
}

export type AgentUsage = {
	workflowId: string;
	workflowName: string;
	nodeIds: string[];
};

/**
 * Scan workflow nodes for references to an agent. O(workflows) — not hot path.
 * Reads both the canvas-side `nodes` JSONB (legacy Svelte-Flow editor shape)
 * AND the compiled `spec.do` JSONB (modern SW 1.0 task list). Either can be
 * the source of truth depending on the workflow's history; walking both
 * guarantees we don't miss references. De-duplicates per (workflow, node).
 */
export async function findAgentUsages(agentId: string): Promise<AgentUsage[]> {
	const database = requireDb();
	const rows = await database
		.select({
			id: workflows.id,
			name: workflows.name,
			nodes: workflows.nodes,
			spec: workflows.spec,
		})
		.from(workflows);
	const usages: AgentUsage[] = [];
	for (const row of rows) {
		const nodeIdsFromNodes = collectNodeIdsReferencingAgent(row.nodes, agentId);
		const nodeIdsFromSpec = collectTaskNamesReferencingAgent(row.spec, agentId);
		const merged = Array.from(new Set([...nodeIdsFromNodes, ...nodeIdsFromSpec]));
		if (merged.length > 0) {
			usages.push({
				workflowId: row.id,
				workflowName: row.name ?? row.id,
				nodeIds: merged,
			});
		}
	}
	return usages;
}

function collectNodeIdsReferencingAgent(
	nodes: unknown,
	agentId: string,
): string[] {
	if (!Array.isArray(nodes)) return [];
	const out: string[] = [];
	for (const node of nodes) {
		if (!node || typeof node !== "object") continue;
		const data = (node as Record<string, unknown>).data as
			| Record<string, unknown>
			| undefined;
		const taskConfig = data?.taskConfig as Record<string, unknown> | undefined;
		const withBlock = taskConfig?.with as Record<string, unknown> | undefined;
		const body = withBlock?.body as Record<string, unknown> | undefined;
		const ref = (body?.agentRef ?? withBlock?.agentRef) as
			| Record<string, unknown>
			| undefined;
		if (ref && ref.id === agentId) {
			const id = (node as Record<string, unknown>).id;
			if (typeof id === "string") out.push(id);
		}
	}
	return out;
}

function collectTaskNamesReferencingAgent(
	spec: unknown,
	agentId: string,
): string[] {
	if (!spec || typeof spec !== "object") return [];
	const doArr = (spec as { do?: unknown }).do;
	if (!Array.isArray(doArr)) return [];
	const out: string[] = [];
	for (const entry of doArr) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const taskName = Object.keys(entry as Record<string, unknown>)[0];
		const task = taskName ? (entry as Record<string, unknown>)[taskName] : null;
		if (!task || typeof task !== "object") continue;
		if ((task as { call?: string }).call !== "durable/run") continue;
		const withBlock = ((task as Record<string, unknown>).with ?? {}) as Record<
			string,
			unknown
		>;
		const body = (withBlock.body ?? withBlock) as Record<string, unknown>;
		const ref = (body.agentRef ?? withBlock.agentRef) as
			| Record<string, unknown>
			| undefined;
		if (ref && ref.id === agentId && typeof taskName === "string") {
			out.push(taskName);
		}
	}
	return out;
}

/**
 * Bulk usage counts across every managed agent in a single pass. Walks both
 * `nodes` and `spec.do` JSONB per workflow, aggregates into a Map keyed by
 * agentId. Used by the agents list page to render a "Used by" column
 * without N round-trips.
 */
export async function findAllAgentUsageCounts(): Promise<
	Record<string, { workflowCount: number; nodeCount: number }>
> {
	const database = requireDb();
	const rows = await database
		.select({
			id: workflows.id,
			nodes: workflows.nodes,
			spec: workflows.spec,
		})
		.from(workflows);
	const byAgent = new Map<
		string,
		{ workflows: Set<string>; nodes: number }
	>();

	function bump(agentId: string, workflowId: string) {
		const existing = byAgent.get(agentId) ?? {
			workflows: new Set<string>(),
			nodes: 0,
		};
		existing.workflows.add(workflowId);
		existing.nodes += 1;
		byAgent.set(agentId, existing);
	}

	for (const row of rows) {
		// Walk nodes[].data.taskConfig
		if (Array.isArray(row.nodes)) {
			for (const node of row.nodes) {
				if (!node || typeof node !== "object") continue;
				const data = (node as Record<string, unknown>).data as
					| Record<string, unknown>
					| undefined;
				const taskConfig = data?.taskConfig as
					| Record<string, unknown>
					| undefined;
				if (!taskConfig || taskConfig.call !== "durable/run") continue;
				const withBlock = taskConfig.with as Record<string, unknown> | undefined;
				const body = (withBlock?.body ?? withBlock) as
					| Record<string, unknown>
					| undefined;
				const ref = (body?.agentRef ?? withBlock?.agentRef) as
					| Record<string, unknown>
					| undefined;
				if (ref && typeof ref.id === "string") {
					bump(ref.id, row.id);
				}
			}
		}
		// Walk spec.do
		const spec = row.spec as { do?: unknown } | null;
		const doArr = spec && Array.isArray(spec.do) ? spec.do : null;
		if (doArr) {
			for (const entry of doArr) {
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
				const taskName = Object.keys(entry as Record<string, unknown>)[0];
				const task = taskName
					? (entry as Record<string, unknown>)[taskName]
					: null;
				if (!task || typeof task !== "object") continue;
				if ((task as { call?: string }).call !== "durable/run") continue;
				const withBlock = ((task as Record<string, unknown>).with ?? {}) as Record<
					string,
					unknown
				>;
				const body = (withBlock.body ?? withBlock) as Record<string, unknown>;
				const ref = (body.agentRef ?? withBlock.agentRef) as
					| Record<string, unknown>
					| undefined;
				if (ref && typeof ref.id === "string") {
					bump(ref.id, row.id);
				}
			}
		}
	}

	const out: Record<string, { workflowCount: number; nodeCount: number }> = {};
	for (const [agentId, v] of byAgent.entries()) {
		out[agentId] = { workflowCount: v.workflows.size, nodeCount: v.nodes };
	}
	return out;
}
