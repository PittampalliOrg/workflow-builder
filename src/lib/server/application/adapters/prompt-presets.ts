import { and, desc, eq, inArray } from "drizzle-orm";

import { templateHash } from "$lib/agents/prompt-workbench-renderer";
import {
	ApplicationPromptPresetValidationError,
	type PromptPresetRepository,
	type PromptStackPresetReadPort,
} from "$lib/server/application/prompt-presets";
import { db as defaultDb } from "$lib/server/db";
import {
	resourcePrompts,
	resourcePromptVersions,
	type ResourcePrompt,
	type ResourcePromptVersion,
} from "$lib/server/db/schema";
import {
	legacyPromptPresetMessages,
	normalizePromptPresetInput,
	promptParentFieldsFromMessages,
	promptPresetRowToSummary,
	type PromptPresetRecord,
	PromptPresetValidationError,
	type PromptPresetVersionRecord,
} from "$lib/server/prompt-presets";

type Database = typeof defaultDb;

function requireDb(database: Database): Database {
	if (!database) throw new Error("Database not configured");
	return database;
}

export class PostgresPromptPresetRepository implements PromptPresetRepository {
	constructor(private readonly database: Database = defaultDb) {}

	async list(input: Parameters<PromptPresetRepository["list"]>[0]) {
		return mapValidationError(async () => {
			const database = requireDb(this.database);
			const conditions = [eq(resourcePrompts.projectId, input.projectId)];
			if (!input.includeDisabled)
				conditions.push(eq(resourcePrompts.isEnabled, true));

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
			const latestByPrompt = new Map<string, PromptPresetVersionRecord>();
			for (const version of versions) {
				if (!latestByPrompt.has(version.promptId)) {
					latestByPrompt.set(version.promptId, versionRecord(version));
				}
			}

			return prompts.map((prompt) =>
				promptPresetRowToSummary(
					promptRecord(prompt),
					latestByPrompt.get(prompt.id) ?? null,
				),
			);
		});
	}

	async create(input: Parameters<PromptPresetRepository["create"]>[0]) {
		return mapValidationError(async () => {
			const database = requireDb(this.database);
			const normalized = normalizePromptPresetInput(input.body, {
				requireName: true,
			});
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
			return promptPresetRowToSummary(
				promptRecord(created.prompt),
				versionRecord(created.version),
			);
		});
	}

	async update(input: Parameters<PromptPresetRepository["update"]>[0]) {
		return mapValidationError(async () => {
			const database = requireDb(this.database);
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

			const existingRecord = promptRecord(existing);
			const [currentVersionRow] = await database
				.select()
				.from(resourcePromptVersions)
				.where(eq(resourcePromptVersions.promptId, existing.id))
				.orderBy(desc(resourcePromptVersions.version))
				.limit(1);
			const currentVersion = currentVersionRow
				? versionRecord(currentVersionRow)
				: null;
			const normalized = normalizePromptPresetInput(input.body, {
				requireName: false,
				fallback: currentVersion
					? {
							name: existing.name,
							description: existing.description,
							messages: currentVersion.messages,
							arguments: currentVersion.templateArguments,
							templateFormat: currentVersion.templateFormat,
							metadata: currentVersion.metadata as Record<
								string,
								unknown
							> | null,
						}
					: {
							name: existing.name,
							description: existing.description,
							messages: legacyPromptPresetMessages(existingRecord),
							arguments: [],
							templateFormat: "mustache",
							metadata: existingRecord.metadata as Record<
								string,
								unknown
							> | null,
						},
			});
			const hash = templateHash(normalized);
			const parentFields = promptParentFieldsFromMessages(normalized.messages);
			const templateChanged =
				!currentVersion ||
				currentVersion.templateHash !== hash ||
				JSON.stringify(currentVersion.messages) !==
					JSON.stringify(normalized.messages) ||
				JSON.stringify(currentVersion.templateArguments) !==
					JSON.stringify(normalized.arguments) ||
				currentVersion.templateFormat !== normalized.templateFormat;

			const result = await database.transaction(async (tx) => {
				let version = currentVersionRow ?? null;
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

			return promptPresetRowToSummary(
				promptRecord(result.prompt),
				result.version ? versionRecord(result.version) : null,
			);
		});
	}

	async archive(input: Parameters<PromptPresetRepository["archive"]>[0]) {
		return mapValidationError(async () => {
			const database = requireDb(this.database);
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
		});
	}
}

export class PostgresPromptStackPresetReadRepository implements PromptStackPresetReadPort {
	constructor(private readonly database: Database = defaultDb) {}

	async listPromptStackPresetRows(input: {
		projectId: string;
		promptIds: string[];
	}) {
		if (input.promptIds.length === 0) return [];
		const database = requireDb(this.database);
		return database
			.select({
				promptId: resourcePromptVersions.promptId,
				version: resourcePromptVersions.version,
				messages: resourcePromptVersions.messages,
				promptVersionId: resourcePromptVersions.id,
				mlflowUri: resourcePromptVersions.mlflowUri,
			})
			.from(resourcePromptVersions)
			.innerJoin(
				resourcePrompts,
				eq(resourcePrompts.id, resourcePromptVersions.promptId),
			)
			.where(
				and(
					inArray(resourcePromptVersions.promptId, input.promptIds),
					eq(resourcePrompts.projectId, input.projectId),
				),
			);
	}
}

async function mapValidationError<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (err) {
		if (err instanceof PromptPresetValidationError) {
			throw new ApplicationPromptPresetValidationError(err.message);
		}
		throw err;
	}
}

function promptRecord(row: ResourcePrompt): PromptPresetRecord {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		systemPrompt: row.systemPrompt,
		userPrompt: row.userPrompt,
		version: row.version,
		isEnabled: row.isEnabled,
		metadata: row.metadata,
		userId: row.userId,
		projectId: row.projectId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function versionRecord(row: ResourcePromptVersion): PromptPresetVersionRecord {
	return {
		id: row.id,
		promptId: row.promptId,
		version: row.version,
		messages: row.messages,
		templateArguments: row.templateArguments,
		templateFormat: row.templateFormat,
		templateHash: row.templateHash,
		metadata: row.metadata,
		createdByUserId: row.createdByUserId,
		createdAt: row.createdAt,
		mlflowUri: row.mlflowUri,
	};
}
