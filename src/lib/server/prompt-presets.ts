import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	resourcePrompts,
	resourcePromptVersions,
	type ResourcePrompt,
	type ResourcePromptVersion,
} from "$lib/server/db/schema";
import type {
	PromptArgumentDefinition,
	PromptPresetMetadata,
	PromptPresetSummary,
	PromptPresetVersion,
	PromptTemplateFormat,
	PromptTemplateMessage,
	PromptTemplateRole,
} from "$lib/types/prompt-presets";
import type { AgentConfig, PromptPresetRef } from "$lib/types/agents";
import { templateHash } from "$lib/agents/prompt-workbench-renderer";

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

export class PromptPresetValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PromptPresetValidationError";
	}
}

export type UpsertPromptPresetInput = {
	name?: string;
	description?: string | null;
	messages?: unknown;
	arguments?: unknown;
	templateFormat?: unknown;
	metadata?: unknown;
};

export async function listPromptPresets(input: {
	projectId: string;
	includeDisabled?: boolean;
}): Promise<PromptPresetSummary[]> {
	const database = requireDb();
	const conditions = [eq(resourcePrompts.projectId, input.projectId)];
	if (!input.includeDisabled) conditions.push(eq(resourcePrompts.isEnabled, true));

	const prompts = await database
		.select()
		.from(resourcePrompts)
		.where(and(...conditions))
		.orderBy(resourcePrompts.name);
	if (prompts.length === 0) return [];

	const versions = await database
		.select()
		.from(resourcePromptVersions)
		.where(
			inArray(
				resourcePromptVersions.promptId,
				prompts.map((prompt) => prompt.id),
			),
		)
		.orderBy(desc(resourcePromptVersions.version));
	const latestByPrompt = new Map<string, ResourcePromptVersion>();
	for (const version of versions) {
		if (!latestByPrompt.has(version.promptId)) latestByPrompt.set(version.promptId, version);
	}

	return prompts.map((prompt) => rowToSummary(prompt, latestByPrompt.get(prompt.id) ?? null));
}

export async function createPromptPreset(input: {
	projectId: string;
	userId: string;
	body: UpsertPromptPresetInput;
}): Promise<PromptPresetSummary> {
	const database = requireDb();
	const normalized = normalizePromptPresetInput(input.body, { requireName: true });
	const hash = templateHash(normalized);
	const parentFields = promptParentFieldsFromMessages(normalized.messages);
	const [created] = await database.transaction(async (tx) => {
		const [prompt] = await tx
			.insert(resourcePrompts)
			.values({
				name: normalized.name,
				description: normalized.description,
				...parentFields,
				metadata: normalized.metadata,
				version: 1,
				isEnabled: true,
				userId: input.userId,
				projectId: input.projectId,
			})
			.returning();
		const [version] = await tx
			.insert(resourcePromptVersions)
			.values({
				promptId: prompt.id,
				version: 1,
				messages: normalized.messages,
				templateArguments: normalized.arguments,
				templateFormat: normalized.templateFormat,
				templateHash: hash,
				metadata: normalized.metadata,
				createdByUserId: input.userId,
			})
			.returning();
		return [{ prompt, version }];
	});
	// Phase 3a: fire-and-forget sync to MLflow's Prompt Registry. The
	// helper swallows errors and returns null on failure — we don't
	// want a registry blip to fail prompt-preset creation.
	void syncPromptToMlflow({
		promptId: created.prompt.id,
		projectId: input.projectId,
		name: normalized.name,
		messages: normalized.messages,
		version: 1,
	});
	return rowToSummary(created.prompt, created.version);
}

export async function updatePromptPreset(input: {
	id: string;
	projectId: string;
	userId: string;
	body: UpsertPromptPresetInput;
}): Promise<PromptPresetSummary | null> {
	const database = requireDb();
	const [existing] = await database
		.select()
		.from(resourcePrompts)
		.where(
			and(
				eq(resourcePrompts.id, input.id),
				eq(resourcePrompts.projectId, input.projectId),
			),
		)
		.limit(1);
	if (!existing) return null;

	const [currentVersion] = await database
		.select()
		.from(resourcePromptVersions)
		.where(eq(resourcePromptVersions.promptId, existing.id))
		.orderBy(desc(resourcePromptVersions.version))
		.limit(1);
	const normalized = normalizePromptPresetInput(input.body, {
		requireName: false,
		fallback: currentVersion
			? {
					name: existing.name,
					description: existing.description,
					messages: currentVersion.messages,
					arguments: currentVersion.templateArguments,
					templateFormat: currentVersion.templateFormat,
					metadata: currentVersion.metadata,
				}
			: {
					name: existing.name,
					description: existing.description,
					messages: legacyMessages(existing),
					arguments: [],
					templateFormat: "mustache",
					metadata: existing.metadata,
				},
	});
	const hash = templateHash(normalized);
	const parentFields = promptParentFieldsFromMessages(normalized.messages);
	const templateChanged =
		!currentVersion ||
		currentVersion.templateHash !== hash ||
		JSON.stringify(currentVersion.messages) !== JSON.stringify(normalized.messages) ||
		JSON.stringify(currentVersion.templateArguments) !==
			JSON.stringify(normalized.arguments) ||
		currentVersion.templateFormat !== normalized.templateFormat;

	const result = await database.transaction(async (tx) => {
		let version = currentVersion ?? null;
		const nextVersionNumber = templateChanged
			? Math.max(existing.version, currentVersion?.version ?? 0) + 1
			: (currentVersion?.version ?? existing.version);
		if (templateChanged) {
			const [inserted] = await tx
				.insert(resourcePromptVersions)
				.values({
					promptId: existing.id,
					version: nextVersionNumber,
					messages: normalized.messages,
					templateArguments: normalized.arguments,
					templateFormat: normalized.templateFormat,
					templateHash: hash,
					metadata: normalized.metadata,
					createdByUserId: input.userId,
				})
				.returning();
			version = inserted;
		}

		const [prompt] = await tx
			.update(resourcePrompts)
			.set({
				name: normalized.name,
				description: normalized.description,
				...parentFields,
				metadata: normalized.metadata,
				version: nextVersionNumber,
				updatedAt: new Date(),
			})
			.where(eq(resourcePrompts.id, existing.id))
			.returning();
		return { prompt, version };
	});

	// Phase 3a: fire-and-forget sync to MLflow's Prompt Registry when
	// the template changed (skipping no-op updates).
	if (templateChanged) {
		void syncPromptToMlflow({
			promptId: result.prompt.id,
			projectId: input.projectId,
			name: result.prompt.name,
			messages: normalized.messages,
			version: result.prompt.version,
		});
	}

	return rowToSummary(result.prompt, result.version);
}

/**
 * Phase 3a fire-and-forget MLflow Prompt Registry sync. Resolved
 * separately from the DB transaction so a registry blip never tears
 * down user-facing prompt-preset creation.
 *
 * Composes a single-string template from the (typically system+user)
 * messages array because MLflow's register_prompt accepts a `template`
 * string OR a list-of-dicts; the orchestrator endpoint expects the
 * string form.
 */
async function syncPromptToMlflow(args: {
	promptId: string;
	projectId: string;
	name: string;
	messages: { role: string; content: string }[];
	version: number;
}): Promise<void> {
	try {
		const { registerPromptInMlflow } = await import('$lib/server/observability/mlflow');
		const template = args.messages
			.map((m) => `### ${m.role.toUpperCase()}\n${m.content}`)
			.join('\n\n');
		const mlflowName = `workflow-builder/prompt-presets/${args.promptId}`;
		const registered = await registerPromptInMlflow({
			name: mlflowName,
			template,
			commitMessage: `prompt-preset v${args.version} from project ${args.projectId}`,
			tags: {
				'workflow-builder.preset_id': args.promptId,
				'workflow-builder.project_id': args.projectId,
				'workflow-builder.preset_name': args.name,
				'workflow-builder.version': String(args.version),
			},
		});
		// Phase 3a v2: persist the MLflow URI back onto the version row so
		// traces can later carry `tag.prompt_version = <uri>` and the UI
		// can deep-link to MLflow's prompt browser. Best-effort: a missed
		// write just leaves the column null until next preset save.
		if (registered?.uri) {
			try {
				const database = requireDb();
				await database
					.update(resourcePromptVersions)
					.set({ mlflowUri: registered.uri })
					.where(
						and(
							eq(resourcePromptVersions.promptId, args.promptId),
							eq(resourcePromptVersions.version, args.version),
						),
					);
			} catch (writeErr) {
				console.warn(
					'[prompt-presets] mlflow uri persistence failed:',
					writeErr instanceof Error ? writeErr.message : writeErr,
				);
			}
		}
	} catch (err) {
		console.warn(
			'[prompt-presets] mlflow sync failed:',
			err instanceof Error ? err.message : err
		);
	}
}

export async function archivePromptPreset(input: {
	id: string;
	projectId: string;
}): Promise<boolean> {
	const database = requireDb();
	const [row] = await database
		.update(resourcePrompts)
		.set({ isEnabled: false, updatedAt: new Date() })
		.where(
			and(
				eq(resourcePrompts.id, input.id),
				eq(resourcePrompts.projectId, input.projectId),
			),
		)
		.returning({ id: resourcePrompts.id });
	return Boolean(row);
}

export function normalizePromptPresetInput(
	input: UpsertPromptPresetInput,
	options: {
		requireName: boolean;
		fallback?: {
			name: string;
			description: string | null;
			messages: PromptTemplateMessage[];
			arguments: PromptArgumentDefinition[];
			templateFormat: PromptTemplateFormat;
			metadata: Record<string, unknown> | null;
		};
	},
): {
	name: string;
	description: string | null;
	messages: PromptTemplateMessage[];
	arguments: PromptArgumentDefinition[];
	templateFormat: PromptTemplateFormat;
	metadata: Record<string, unknown> | null;
} {
	const name =
		typeof input.name === "string" && input.name.trim()
			? input.name.trim()
			: (options.fallback?.name ?? "");
	if (options.requireName && !name) {
		throw new PromptPresetValidationError("name is required");
	}
	const description =
		typeof input.description === "string"
			? input.description.trim() || null
			: input.description === null
				? null
				: (options.fallback?.description ?? null);
	const messages =
		input.messages === undefined
			? (options.fallback?.messages ?? [])
			: normalizeMessages(input.messages);
	if (messages.length === 0) {
		throw new PromptPresetValidationError("at least one message is required");
	}
	const args =
		input.arguments === undefined
			? (options.fallback?.arguments ?? [])
			: normalizeArguments(input.arguments);
	const templateFormat =
		input.templateFormat === undefined
			? (options.fallback?.templateFormat ?? "mustache")
			: normalizeTemplateFormat(input.templateFormat);
	const metadata =
		input.metadata === undefined
			? (options.fallback?.metadata ?? null)
			: normalizeMetadata(input.metadata);
	return { name, description, messages, arguments: args, templateFormat, metadata };
}

export function promptParentFieldsFromMessages(
	messages: PromptTemplateMessage[],
): { systemPrompt: string; userPrompt: string | null; promptMode: "system" | "system+user" } {
	const systemPrompt =
		messageContentForRole(messages, "system") || messages[0]?.content || "";
	const userPrompt = messageContentForRole(messages, "user") || null;
	return {
		systemPrompt,
		userPrompt,
		promptMode: userPrompt ? "system+user" : "system",
	};
}

function normalizeMessages(value: unknown): PromptTemplateMessage[] {
	if (!Array.isArray(value)) {
		throw new PromptPresetValidationError("messages must be an array");
	}
	return value.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new PromptPresetValidationError(`messages[${index}] must be an object`);
		}
		const record = item as Record<string, unknown>;
		const role = normalizeRole(record.role);
		const content = typeof record.content === "string" ? record.content : "";
		if (!content.trim()) {
			throw new PromptPresetValidationError(`messages[${index}].content is required`);
		}
		return { role, content };
	});
}

function normalizeRole(value: unknown): PromptTemplateRole {
	if (value === "system" || value === "user" || value === "assistant") return value;
	throw new PromptPresetValidationError("message role must be system, user, or assistant");
}

function normalizeArguments(value: unknown): PromptArgumentDefinition[] {
	if (!Array.isArray(value)) {
		throw new PromptPresetValidationError("arguments must be an array");
	}
	return value.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new PromptPresetValidationError(`arguments[${index}] must be an object`);
		}
		const record = item as Record<string, unknown>;
		const name = typeof record.name === "string" ? record.name.trim() : "";
		if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) {
			throw new PromptPresetValidationError(
				`arguments[${index}].name must be a valid Mustache variable name`,
			);
		}
		return {
			name,
			...(typeof record.description === "string" && record.description.trim()
				? { description: record.description.trim() }
				: {}),
			...(typeof record.required === "boolean" ? { required: record.required } : {}),
		};
	});
}

function normalizeTemplateFormat(value: unknown): PromptTemplateFormat {
	if (value === undefined || value === null || value === "mustache") return "mustache";
	throw new PromptPresetValidationError("templateFormat must be mustache");
}

function normalizeMetadata(value: unknown): PromptPresetMetadata | null {
	if (value === null || value === undefined) return null;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new PromptPresetValidationError("metadata must be an object");
	}
	return value as PromptPresetMetadata;
}

function messageContentForRole(
	messages: PromptTemplateMessage[],
	role: PromptTemplateRole,
): string {
	return messages.find((message) => message.role === role)?.content ?? "";
}

function legacyMessages(prompt: ResourcePrompt): PromptTemplateMessage[] {
	const messages: PromptTemplateMessage[] = [
		{ role: "system", content: prompt.systemPrompt },
	];
	if (prompt.userPrompt) messages.push({ role: "user", content: prompt.userPrompt });
	return messages;
}

function rowToSummary(
	prompt: ResourcePrompt,
	version: ResourcePromptVersion | null,
): PromptPresetSummary {
	return {
		id: prompt.id,
		name: prompt.name,
		title: prompt.name,
		description: prompt.description ?? null,
		version: version?.version ?? prompt.version,
		isEnabled: prompt.isEnabled,
		metadata: (prompt.metadata as PromptPresetMetadata | null) ?? null,
		userId: prompt.userId,
		projectId: prompt.projectId ?? null,
		createdAt: prompt.createdAt.toISOString(),
		updatedAt: prompt.updatedAt.toISOString(),
		latestVersion: version ? versionToSummary(version) : legacyVersion(prompt),
	};
}

function versionToSummary(version: ResourcePromptVersion): PromptPresetVersion {
	return {
		id: version.id,
		promptId: version.promptId,
		version: version.version,
		messages: version.messages,
		arguments: version.templateArguments,
		templateFormat: version.templateFormat,
		templateHash: version.templateHash,
		metadata: (version.metadata as PromptPresetMetadata | null) ?? null,
		createdByUserId: version.createdByUserId ?? null,
		createdAt: version.createdAt.toISOString(),
	};
}

function legacyVersion(prompt: ResourcePrompt): PromptPresetVersion {
	const messages = legacyMessages(prompt);
	return {
		id: `${prompt.id}:legacy`,
		promptId: prompt.id,
		version: prompt.version,
		messages,
		arguments: [],
		templateFormat: "mustache",
		templateHash: templateHash({ messages, arguments: [], templateFormat: "mustache" }),
		metadata: (prompt.metadata as PromptPresetMetadata | null) ?? null,
		createdByUserId: prompt.userId,
		createdAt: prompt.createdAt.toISOString(),
	};
}

export function isValidPresetRef(value: unknown): value is PromptPresetRef {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "string" &&
		record.id.trim().length > 0 &&
		typeof record.version === "number" &&
		Number.isInteger(record.version) &&
		record.version > 0
	);
}

/**
 * Per-ref manifest entry: enough metadata for `dapr-agent-py` to stamp
 * MLflow trace tags (`tag.prompt_version_id`, `tag.prompt_version`) on
 * agent traces, so prompt-iteration → run-quality is queryable.
 */
export interface CompiledPromptStackEntry {
	readonly promptId: string;
	readonly version: number;
	readonly promptVersionId: string;
	readonly mlflowUri: string | null;
}

export interface CompiledPromptStack {
	readonly static: string[];
	readonly dynamic: string[];
	readonly staticManifest: CompiledPromptStackEntry[];
	readonly dynamicManifest: CompiledPromptStackEntry[];
}

/**
 * Pure resolution: given the in-memory refs and the DB-fetched
 * (promptId, version, messages, promptVersionId, mlflowUri) rows,
 * produce the static + dynamic content arrays AND a per-ref manifest
 * carrying enough metadata for trace-tag propagation downstream.
 * Exposed for unit testing without needing a live DB.
 */
export function resolveCompiledPromptStack(
	staticRefs: PromptPresetRef[],
	dynamicRefs: PromptPresetRef[],
	rows: Array<{
		promptId: string;
		version: number;
		messages: unknown;
		promptVersionId?: string | null;
		mlflowUri?: string | null;
	}>,
	warnContext?: string,
): CompiledPromptStack {
	const contentByKey = new Map<string, string>();
	const manifestByKey = new Map<string, CompiledPromptStackEntry>();
	for (const row of rows) {
		const messages = Array.isArray(row.messages)
			? (row.messages as PromptTemplateMessage[])
			: [];
		const systemContent = messageContentForRole(messages, "system").trim();
		const key = `${row.promptId}@${row.version}`;
		if (row.promptVersionId) {
			manifestByKey.set(key, {
				promptId: row.promptId,
				version: row.version,
				promptVersionId: row.promptVersionId,
				mlflowUri: row.mlflowUri ?? null,
			});
		}
		if (!systemContent) continue;
		contentByKey.set(key, systemContent);
	}

	function resolveContent(refs: PromptPresetRef[]): string[] {
		const out: string[] = [];
		for (const ref of refs) {
			const content = contentByKey.get(`${ref.id}@${ref.version}`);
			if (!content) {
				console.warn(
					`[compile-prompt-stack] preset not found or empty: ${ref.id}@${ref.version}${
						warnContext ? ` (${warnContext})` : ""
					}`,
				);
				continue;
			}
			out.push(content);
		}
		return out;
	}

	function resolveManifest(refs: PromptPresetRef[]): CompiledPromptStackEntry[] {
		const out: CompiledPromptStackEntry[] = [];
		for (const ref of refs) {
			const entry = manifestByKey.get(`${ref.id}@${ref.version}`);
			if (entry) out.push(entry);
		}
		return out;
	}

	return {
		static: resolveContent(staticRefs),
		dynamic: resolveContent(dynamicRefs),
		staticManifest: resolveManifest(staticRefs),
		dynamicManifest: resolveManifest(dynamicRefs),
	};
}

/**
 * Resolve `agentConfig.staticPromptPresetRefs` and `dynamicPromptPresetRefs`
 * against the Prompt Workbench preset table, returning the system-text content
 * for each pinned version. Bindings are project-scoped: a preset that lives in
 * a different workspace than the agent silently resolves to nothing (with a
 * warn log), so a stale or cross-tenant ref never blocks a session spawn.
 *
 * Called once per session-spawn from `src/lib/server/sessions/spawn.ts` and
 * `src/routes/api/internal/sessions/ensure-for-workflow/+server.ts`. Single
 * SELECT joins versions to prompts so we get the projectId scope check in one
 * round-trip; client-side filtering matches `(promptId, version)` tuples.
 */
export async function compilePromptStack(
	agentConfig: AgentConfig | Record<string, unknown> | null | undefined,
	opts: { projectId: string },
): Promise<CompiledPromptStack> {
	const empty: CompiledPromptStack = {
		static: [],
		dynamic: [],
		staticManifest: [],
		dynamicManifest: [],
	};
	if (!agentConfig) return empty;
	const cfg = agentConfig as Record<string, unknown>;
	const staticRefs = Array.isArray(cfg.staticPromptPresetRefs)
		? (cfg.staticPromptPresetRefs as unknown[]).filter(isValidPresetRef)
		: [];
	const dynamicRefs = Array.isArray(cfg.dynamicPromptPresetRefs)
		? (cfg.dynamicPromptPresetRefs as unknown[]).filter(isValidPresetRef)
		: [];
	if (staticRefs.length === 0 && dynamicRefs.length === 0) {
		return empty;
	}

	const promptIds = [
		...new Set([...staticRefs, ...dynamicRefs].map((r) => r.id)),
	];

	const database = requireDb();
	const rows = await database
		.select({
			promptId: resourcePromptVersions.promptId,
			version: resourcePromptVersions.version,
			messages: resourcePromptVersions.messages,
			promptVersionId: resourcePromptVersions.id,
			mlflowUri: resourcePromptVersions.mlflowUri,
		})
		.from(resourcePromptVersions)
		.innerJoin(resourcePrompts, eq(resourcePrompts.id, resourcePromptVersions.promptId))
		.where(
			and(
				inArray(resourcePromptVersions.promptId, promptIds),
				eq(resourcePrompts.projectId, opts.projectId),
			),
		);

	return resolveCompiledPromptStack(
		staticRefs,
		dynamicRefs,
		rows,
		`projectId=${opts.projectId}`,
	);
}
