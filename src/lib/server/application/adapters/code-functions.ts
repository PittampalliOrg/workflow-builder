import { randomBytes } from "node:crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import { db as defaultDb } from "$lib/server/db";
import {
	codeFunctionRevisions,
	codeFunctions,
	type CodeFunctionCompositionGraph,
	type CodeFunctionRole,
} from "$lib/server/db/schema";
import {
	parseCodePreview,
	type CodeParserModel,
} from "$lib/server/code-parser";
import {
	buildCodeFunctionSourceHash,
	normalizeCodeFunctionInput,
	slugifyCodeFunctionName,
	type CodeFunctionDetail,
	type CodeFunctionRevisionSummary,
	type CodeFunctionSummary,
	type SaveCodeFunctionInput,
} from "$lib/server/code-functions/model";
import { requirePostgresDb } from "$lib/server/application/adapters/postgres";
import type {
	CodeFunctionManagementRepository,
	SaveCodeFunctionCommand,
} from "$lib/server/application/code-function-management";
import type { CodeFunctionParsePreviewPort } from "$lib/server/application/code-function-parse-preview";

type Database = typeof defaultDb;

function requireUserId(userId?: string | null): string {
	if (!userId) {
		throw new Error("Unauthorized");
	}
	return userId;
}

function toSummary(
	row: typeof codeFunctions.$inferSelect,
): CodeFunctionSummary {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		description: row.description,
		version: row.version,
		language: row.language,
		entrypoint: row.entrypoint,
		path: row.path,
		updatedAt: row.updatedAt.toISOString(),
		createdAt: row.createdAt.toISOString(),
		isEnabled: row.isEnabled ?? true,
		hasDiagnostics:
			Array.isArray(row.diagnostics) && row.diagnostics.length > 0,
		latestPublishedVersion: row.latestPublishedVersion ?? null,
		lastPublishedAt: row.lastPublishedAt
			? row.lastPublishedAt.toISOString()
			: null,
		role: (row.role ?? "function") as CodeFunctionRole,
		compositionGraph:
			(row.compositionGraph as CodeFunctionCompositionGraph | null) ?? null,
	};
}

function toDetail(
	row: typeof codeFunctions.$inferSelect,
	revisions: CodeFunctionRevisionSummary[] = [],
): CodeFunctionDetail {
	const semanticModel =
		row.semanticModel && typeof row.semanticModel === "object"
			? (row.semanticModel as Record<string, unknown>)
			: null;

	return {
		...toSummary(row),
		source: row.source,
		supportingFiles:
			row.supportingFiles && typeof row.supportingFiles === "object"
				? (row.supportingFiles as Record<string, string>)
				: {},
		sourceHash: row.sourceHash,
		model: {
			language: row.language,
			entrypoint: row.entrypoint,
			is_async: semanticModel?.is_async === true,
			imports: Array.isArray(row.imports) ? row.imports : [],
			params: Array.isArray(semanticModel?.params)
				? (semanticModel.params as CodeParserModel["params"])
				: [],
			dynamic_inputs: Array.isArray(semanticModel?.dynamic_inputs)
				? (semanticModel.dynamic_inputs as NonNullable<
						CodeParserModel["dynamic_inputs"]
					>)
				: [],
			return_type:
				row.returnType && typeof row.returnType === "object"
					? (row.returnType as CodeParserModel["return_type"])
					: { kind: "unknown" },
			schema:
				row.inputSchema && typeof row.inputSchema === "object"
					? (row.inputSchema as Record<string, unknown>)
					: {},
			diagnostics: Array.isArray(row.diagnostics)
				? (row.diagnostics as CodeParserModel["diagnostics"])
				: [],
			capabilities:
				row.capabilities && typeof row.capabilities === "object"
					? (row.capabilities as CodeParserModel["capabilities"])
					: {
							has_enums: false,
							has_nested_objects: false,
							has_nullable_types: false,
							has_relative_imports: false,
							has_resource_types: false,
							has_dynamic_inputs: false,
						},
		},
		revisions,
	};
}

function toRevisionSummary(
	row: typeof codeFunctionRevisions.$inferSelect,
): CodeFunctionRevisionSummary {
	return {
		id: row.id,
		version: row.version,
		publishedAt: row.publishedAt.toISOString(),
	};
}

function detailFromRevision(
	row: typeof codeFunctionRevisions.$inferSelect,
): CodeFunctionDetail {
	const semanticModel =
		row.semanticModel && typeof row.semanticModel === "object"
			? (row.semanticModel as Record<string, unknown>)
			: null;

	return {
		id: row.codeFunctionId,
		name: row.name,
		slug: row.slug,
		description: row.description,
		version: row.version,
		language: row.language,
		entrypoint: row.entrypoint,
		path: row.path,
		updatedAt: row.publishedAt.toISOString(),
		createdAt: row.publishedAt.toISOString(),
		isEnabled: true,
		hasDiagnostics:
			Array.isArray(row.diagnostics) && row.diagnostics.length > 0,
		latestPublishedVersion: row.version,
		lastPublishedAt: row.publishedAt.toISOString(),
		role: (row.role ?? "function") as CodeFunctionRole,
		compositionGraph:
			(row.compositionGraph as CodeFunctionCompositionGraph | null) ?? null,
		source: row.source,
		supportingFiles:
			row.supportingFiles && typeof row.supportingFiles === "object"
				? (row.supportingFiles as Record<string, string>)
				: {},
		sourceHash: row.sourceHash,
		model: {
			language: row.language,
			entrypoint: row.entrypoint,
			is_async: semanticModel?.is_async === true,
			imports: Array.isArray(row.imports) ? row.imports : [],
			params: Array.isArray(semanticModel?.params)
				? (semanticModel.params as CodeParserModel["params"])
				: [],
			dynamic_inputs: Array.isArray(semanticModel?.dynamic_inputs)
				? (semanticModel.dynamic_inputs as NonNullable<
						CodeParserModel["dynamic_inputs"]
					>)
				: [],
			return_type:
				row.returnType && typeof row.returnType === "object"
					? (row.returnType as CodeParserModel["return_type"])
					: { kind: "unknown" },
			schema:
				row.inputSchema && typeof row.inputSchema === "object"
					? (row.inputSchema as Record<string, unknown>)
					: {},
			diagnostics: Array.isArray(row.diagnostics)
				? (row.diagnostics as CodeParserModel["diagnostics"])
				: [],
			capabilities:
				row.capabilities && typeof row.capabilities === "object"
					? (row.capabilities as CodeParserModel["capabilities"])
					: {
							has_enums: false,
							has_nested_objects: false,
							has_nullable_types: false,
							has_relative_imports: false,
							has_resource_types: false,
							has_dynamic_inputs: false,
						},
		},
		revisions: [toRevisionSummary(row)],
	};
}

export class PostgresCodeFunctionStore {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async listCodeFunctions(
		userId?: string | null,
	): Promise<CodeFunctionSummary[]> {
		const ownerId = requireUserId(userId);
		const rows = await this.database
			.select()
			.from(codeFunctions)
			.where(eq(codeFunctions.createdBy, ownerId))
			.orderBy(desc(codeFunctions.updatedAt));

		return rows.map(toSummary);
	}

	async getCodeFunction(
		id: string,
		userId?: string | null,
	): Promise<CodeFunctionDetail | null> {
		const ownerId = requireUserId(userId);
		const [row] = await this.database
			.select()
			.from(codeFunctions)
			.where(and(eq(codeFunctions.id, id), eq(codeFunctions.createdBy, ownerId)))
			.limit(1);

		if (!row) return null;

		const revisions = await this.database
			.select()
			.from(codeFunctionRevisions)
			.where(
				and(
					eq(codeFunctionRevisions.codeFunctionId, row.id),
					eq(codeFunctionRevisions.createdBy, ownerId),
				),
			)
			.orderBy(desc(codeFunctionRevisions.publishedAt));

		return toDetail(row, revisions.map(toRevisionSummary));
	}

	async getCodeFunctionBySlugForUser(
		slug: string,
		userId?: string | null,
	): Promise<CodeFunctionDetail | null> {
		const ownerId = requireUserId(userId);
		const [row] = await this.database
			.select()
			.from(codeFunctions)
			.where(and(eq(codeFunctions.slug, slug), eq(codeFunctions.createdBy, ownerId)))
			.limit(1);
		return row ? toDetail(row) : null;
	}

	async getCodeFunctionBySlug(
		slug: string,
		version: string,
		userId?: string | null,
	): Promise<CodeFunctionDetail | null> {
		const ownerId = requireUserId(userId);
		const [row] = await this.database
			.select()
			.from(codeFunctions)
			.where(
				and(
					eq(codeFunctions.slug, slug),
					eq(codeFunctions.version, version),
					eq(codeFunctions.createdBy, ownerId),
				),
			)
			.limit(1);

		if (row) {
			return toDetail(row);
		}

		const [revision] = await this.database
			.select()
			.from(codeFunctionRevisions)
			.where(
				and(
					eq(codeFunctionRevisions.slug, slug),
					eq(codeFunctionRevisions.version, version),
					eq(codeFunctionRevisions.createdBy, ownerId),
				),
			)
			.limit(1);

		return revision ? detailFromRevision(revision) : null;
	}

	async listCodeFunctionRevisions(
		codeFunctionId: string,
		userId?: string | null,
	): Promise<CodeFunctionRevisionSummary[]> {
		const ownerId = requireUserId(userId);
		const rows = await this.database
			.select()
			.from(codeFunctionRevisions)
			.where(
				and(
					eq(codeFunctionRevisions.codeFunctionId, codeFunctionId),
					eq(codeFunctionRevisions.createdBy, ownerId),
				),
			)
			.orderBy(desc(codeFunctionRevisions.publishedAt));
		return rows.map(toRevisionSummary);
	}

	async publishCodeFunction(
		id: string,
		userId?: string | null,
	): Promise<CodeFunctionDetail | null> {
		const ownerId = requireUserId(userId);
		const [row] = await this.database
			.select()
			.from(codeFunctions)
			.where(and(eq(codeFunctions.id, id), eq(codeFunctions.createdBy, ownerId)))
			.limit(1);

		if (!row) return null;

		const version = `pub_${Date.now()}_${randomBytes(3).toString("hex")}`;
		await this.database.insert(codeFunctionRevisions).values({
			codeFunctionId: row.id,
			version,
			name: row.name,
			slug: row.slug,
			description: row.description,
			language: row.language,
			entrypoint: row.entrypoint,
			path: row.path,
			source: row.source,
			supportingFiles:
				row.supportingFiles && typeof row.supportingFiles === "object"
					? (row.supportingFiles as Record<string, string>)
					: null,
			sourceHash: row.sourceHash,
			semanticModel: row.semanticModel,
			inputSchema: row.inputSchema,
			returnType: row.returnType,
			imports: row.imports,
			diagnostics: row.diagnostics,
			capabilities: row.capabilities,
			role: (row.role ?? "function") as CodeFunctionRole,
			compositionGraph:
				(row.compositionGraph as CodeFunctionCompositionGraph | null) ?? null,
			createdBy: ownerId,
		});

		const [updated] = await this.database
			.update(codeFunctions)
			.set({
				latestPublishedVersion: version,
				lastPublishedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(and(eq(codeFunctions.id, id), eq(codeFunctions.createdBy, ownerId)))
			.returning();

		if (!updated) return null;
		const revisions = await this.listCodeFunctionRevisions(id, ownerId);
		return toDetail(updated, revisions);
	}

	async createCodeFunction(
		input: SaveCodeFunctionInput,
		userId?: string | null,
	): Promise<CodeFunctionDetail> {
		const ownerId = requireUserId(userId);
		const normalized = normalizeCodeFunctionInput(input);
		const model = await this.parseModel(normalized);
		const slug = await this.ensureUniqueSlug(normalized.name);

		const [created] = await this.database
			.insert(codeFunctions)
			.values({
				name: normalized.name,
				slug,
				description: normalized.description,
				version: "0.1.0",
				language: normalized.language,
				entrypoint: normalized.entrypoint || "main",
				path: normalized.path,
				source: normalized.source,
				supportingFiles: normalized.supportingFiles ?? null,
				sourceHash: buildCodeFunctionSourceHash(
					normalized.source,
					normalized.supportingFiles,
				),
				semanticModel: model,
				inputSchema: model.schema,
				returnType: model.return_type,
				imports: model.imports,
				diagnostics: model.diagnostics,
				capabilities: model.capabilities,
				role: normalized.role ?? "function",
				compositionGraph: normalized.compositionGraph ?? null,
				createdBy: ownerId,
			})
			.returning();

		return toDetail(created);
	}

	async updateCodeFunction(
		id: string,
		input: SaveCodeFunctionInput,
		userId?: string | null,
	): Promise<CodeFunctionDetail | null> {
		const ownerId = requireUserId(userId);
		const normalized = normalizeCodeFunctionInput(input);
		const model = await this.parseModel(normalized);
		const slug = await this.ensureUniqueSlug(normalized.name, id);

		const [updated] = await this.database
			.update(codeFunctions)
			.set({
				name: normalized.name,
				slug,
				description: normalized.description,
				language: normalized.language,
				entrypoint: normalized.entrypoint || "main",
				path: normalized.path,
				source: normalized.source,
				supportingFiles: normalized.supportingFiles ?? null,
				sourceHash: buildCodeFunctionSourceHash(
					normalized.source,
					normalized.supportingFiles,
				),
				semanticModel: model,
				inputSchema: model.schema,
				returnType: model.return_type,
				imports: model.imports,
				diagnostics: model.diagnostics,
				capabilities: model.capabilities,
				...(normalized.role !== undefined ? { role: normalized.role } : {}),
				...(normalized.compositionGraph !== undefined
					? { compositionGraph: normalized.compositionGraph }
					: {}),
				updatedAt: new Date(),
			})
			.where(and(eq(codeFunctions.id, id), eq(codeFunctions.createdBy, ownerId)))
			.returning();

		return updated ? toDetail(updated) : null;
	}

	async deleteCodeFunction(id: string, userId?: string | null): Promise<boolean> {
		const ownerId = requireUserId(userId);
		const deleted = await this.database
			.delete(codeFunctions)
			.where(and(eq(codeFunctions.id, id), eq(codeFunctions.createdBy, ownerId)))
			.returning({ id: codeFunctions.id });

		return deleted.length > 0;
	}

	private async ensureUniqueSlug(base: string, excludeId?: string): Promise<string> {
		const normalized = slugifyCodeFunctionName(base);
		let slug = normalized;
		let suffix = 1;

		for (;;) {
			const conditions = [eq(codeFunctions.slug, slug)];
			if (excludeId) {
				conditions.push(ne(codeFunctions.id, excludeId));
			}

			const [existing] = await this.database
				.select({ id: codeFunctions.id })
				.from(codeFunctions)
				.where(and(...conditions))
				.limit(1);

			if (!existing) {
				return slug;
			}

			slug = `${normalized}-${suffix++}`;
		}
	}

	private parseModel(input: SaveCodeFunctionInput): Promise<CodeParserModel> {
		return parseCodePreview({
			language: input.language,
			source: input.source,
			entrypoint: input.entrypoint || undefined,
			path: input.path || undefined,
			supportingFiles: input.supportingFiles || undefined,
		});
	}
}

export class PostgresCodeFunctionManagementRepository
	implements CodeFunctionManagementRepository
{
	constructor(private readonly store = new PostgresCodeFunctionStore()) {}

	list(userId: string): Promise<CodeFunctionSummary[]> {
		return this.store.listCodeFunctions(userId);
	}

	get(id: string, userId: string): Promise<CodeFunctionDetail | null> {
		return this.store.getCodeFunction(id, userId);
	}

	create(
		input: SaveCodeFunctionCommand,
		userId: string,
	): Promise<CodeFunctionDetail> {
		return this.store.createCodeFunction(input, userId);
	}

	update(
		id: string,
		input: SaveCodeFunctionCommand,
		userId: string,
	): Promise<CodeFunctionDetail | null> {
		return this.store.updateCodeFunction(id, input, userId);
	}

	delete(id: string, userId: string): Promise<boolean> {
		return this.store.deleteCodeFunction(id, userId);
	}

	publish(id: string, userId: string): Promise<CodeFunctionDetail | null> {
		return this.store.publishCodeFunction(id, userId);
	}
}

export class LocalCodeFunctionParsePreviewPort
	implements CodeFunctionParsePreviewPort
{
	parse(input: {
		language: "typescript" | "python";
		source: string;
		entrypoint?: string;
		path?: string;
		supportingFiles?: Record<string, string>;
	}): Promise<unknown> {
		return parseCodePreview(input);
	}
}
