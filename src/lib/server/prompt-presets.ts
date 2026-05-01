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

	return rowToSummary(result.prompt, result.version);
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
