import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, ne } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	codeFunctionRevisions,
	codeFunctions,
	type CodeFunctionCompositionGraph,
	type CodeFunctionRole,
} from '$lib/server/db/schema';
import { parseCodePreview, type CodeParserLanguage, type CodeParserModel } from '$lib/server/code-parser';

export interface SaveCodeFunctionInput {
	name: string;
	description?: string | null;
	language: CodeParserLanguage;
	entrypoint?: string | null;
	path?: string | null;
	source: string;
	supportingFiles?: Record<string, string> | null;
	role?: CodeFunctionRole;
	compositionGraph?: CodeFunctionCompositionGraph | null;
}

export interface CodeFunctionRevisionSummary {
	id: string;
	version: string;
	publishedAt: string;
}

export interface CodeFunctionSummary {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	version: string;
	language: CodeParserLanguage;
	entrypoint: string;
	path: string | null;
	updatedAt: string;
	createdAt: string;
	isEnabled: boolean;
	hasDiagnostics: boolean;
	latestPublishedVersion: string | null;
	lastPublishedAt: string | null;
	role: CodeFunctionRole;
	compositionGraph: CodeFunctionCompositionGraph | null;
}

export interface CodeFunctionDetail extends CodeFunctionSummary {
	source: string;
	supportingFiles: Record<string, string>;
	sourceHash: string;
	model: CodeParserModel;
	revisions: CodeFunctionRevisionSummary[];
}

function requireDb() {
	if (!db) {
		throw new Error('Database not configured');
	}
	return db;
}

function requireUserId(userId?: string | null): string {
	if (!userId) {
		throw new Error('Unauthorized');
	}
	return userId;
}

function normalizeInput(input: SaveCodeFunctionInput): SaveCodeFunctionInput {
	const supportingFiles =
		input.supportingFiles && typeof input.supportingFiles === 'object'
			? Object.fromEntries(
					Object.entries(input.supportingFiles)
						.filter(
							([path, value]) =>
								typeof path === 'string' &&
								path.trim().length > 0 &&
								typeof value === 'string',
						)
						.map(([path, value]) => [path.trim(), value]),
				)
			: null;

	return {
		name: input.name.trim(),
		description: input.description?.trim() || null,
		language: input.language,
		entrypoint: input.entrypoint?.trim() || 'main',
		path: input.path?.trim() || null,
		source: input.source,
		supportingFiles: supportingFiles && Object.keys(supportingFiles).length > 0 ? supportingFiles : null,
		role: input.role ?? 'function',
		compositionGraph: input.compositionGraph ?? null,
	};
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64) || 'code-function';
}

async function ensureUniqueSlug(base: string, excludeId?: string): Promise<string> {
	const database = requireDb();
	const normalized = slugify(base);
	let slug = normalized;
	let suffix = 1;

	for (;;) {
		const conditions = [eq(codeFunctions.slug, slug)];
		if (excludeId) {
			conditions.push(ne(codeFunctions.id, excludeId));
		}

		const [existing] = await database
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

function buildSourceHash(source: string, supportingFiles?: Record<string, string> | null): string {
	const hash = createHash('sha256').update(source);
	if (supportingFiles && Object.keys(supportingFiles).length > 0) {
		for (const [path, contents] of Object.entries(supportingFiles).sort(([left], [right]) =>
			left.localeCompare(right),
		)) {
			hash.update('\n@@file:').update(path).update('\n').update(contents);
		}
	}
	return hash.digest('hex');
}

function toSummary(row: typeof codeFunctions.$inferSelect): CodeFunctionSummary {
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
		hasDiagnostics: Array.isArray(row.diagnostics) && row.diagnostics.length > 0,
		latestPublishedVersion: row.latestPublishedVersion ?? null,
		lastPublishedAt: row.lastPublishedAt ? row.lastPublishedAt.toISOString() : null,
		role: (row.role ?? 'function') as CodeFunctionRole,
		compositionGraph: (row.compositionGraph as CodeFunctionCompositionGraph | null) ?? null,
	};
}

function toDetail(
	row: typeof codeFunctions.$inferSelect,
	revisions: CodeFunctionRevisionSummary[] = [],
): CodeFunctionDetail {
	const semanticModel =
		row.semanticModel && typeof row.semanticModel === 'object'
			? (row.semanticModel as Record<string, unknown>)
			: null;

	return {
		...toSummary(row),
		source: row.source,
		supportingFiles:
			row.supportingFiles && typeof row.supportingFiles === 'object'
				? (row.supportingFiles as Record<string, string>)
				: {},
		sourceHash: row.sourceHash,
		model: {
			language: row.language,
			entrypoint: row.entrypoint,
			is_async: semanticModel?.is_async === true,
			imports: Array.isArray(row.imports) ? row.imports : [],
			params: Array.isArray(semanticModel?.params)
				? (semanticModel.params as CodeParserModel['params'])
				: [],
			dynamic_inputs: Array.isArray(semanticModel?.dynamic_inputs)
				? (semanticModel.dynamic_inputs as NonNullable<CodeParserModel['dynamic_inputs']>)
				: [],
			return_type:
				row.returnType && typeof row.returnType === 'object'
					? (row.returnType as CodeParserModel['return_type'])
					: { kind: 'unknown' },
			schema:
				row.inputSchema && typeof row.inputSchema === 'object'
					? (row.inputSchema as Record<string, unknown>)
					: {},
			diagnostics: Array.isArray(row.diagnostics)
				? (row.diagnostics as CodeParserModel['diagnostics'])
				: [],
			capabilities:
				row.capabilities && typeof row.capabilities === 'object'
					? (row.capabilities as CodeParserModel['capabilities'])
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
		row.semanticModel && typeof row.semanticModel === 'object'
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
		hasDiagnostics: Array.isArray(row.diagnostics) && row.diagnostics.length > 0,
		latestPublishedVersion: row.version,
		lastPublishedAt: row.publishedAt.toISOString(),
		role: (row.role ?? 'function') as CodeFunctionRole,
		compositionGraph: (row.compositionGraph as CodeFunctionCompositionGraph | null) ?? null,
		source: row.source,
		supportingFiles:
			row.supportingFiles && typeof row.supportingFiles === 'object'
				? (row.supportingFiles as Record<string, string>)
				: {},
		sourceHash: row.sourceHash,
		model: {
			language: row.language,
			entrypoint: row.entrypoint,
			is_async: semanticModel?.is_async === true,
			imports: Array.isArray(row.imports) ? row.imports : [],
			params: Array.isArray(semanticModel?.params)
				? (semanticModel.params as CodeParserModel['params'])
				: [],
			dynamic_inputs: Array.isArray(semanticModel?.dynamic_inputs)
				? (semanticModel.dynamic_inputs as NonNullable<CodeParserModel['dynamic_inputs']>)
				: [],
			return_type:
				row.returnType && typeof row.returnType === 'object'
					? (row.returnType as CodeParserModel['return_type'])
					: { kind: 'unknown' },
			schema:
				row.inputSchema && typeof row.inputSchema === 'object'
					? (row.inputSchema as Record<string, unknown>)
					: {},
			diagnostics: Array.isArray(row.diagnostics)
				? (row.diagnostics as CodeParserModel['diagnostics'])
				: [],
			capabilities:
				row.capabilities && typeof row.capabilities === 'object'
					? (row.capabilities as CodeParserModel['capabilities'])
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

async function parseModel(input: SaveCodeFunctionInput): Promise<CodeParserModel> {
	return parseCodePreview({
		language: input.language,
		source: input.source,
		entrypoint: input.entrypoint || undefined,
		path: input.path || undefined,
		supportingFiles: input.supportingFiles || undefined,
	});
}

export function normalizeExternalCodeDependency(
	language: CodeParserLanguage,
	specifier: string,
): string | null {
	if (language === 'typescript') {
		if (
			specifier.startsWith('node:') ||
			specifier.startsWith('jsr:') ||
			specifier.startsWith('bun:') ||
			specifier.startsWith('http://') ||
			specifier.startsWith('https://')
		) {
			return null;
		}
		const normalized = specifier.startsWith('npm:') ? specifier.slice(4) : specifier;
		if (!normalized || normalized.startsWith('.') || normalized.startsWith('/')) {
			return null;
		}
		if (normalized.startsWith('@')) {
			const [scope, name] = normalized.split('/');
			return scope && name ? `${scope}/${name}` : normalized;
		}
		return normalized.split('/')[0] || null;
	}

	const base = specifier.trim().split('.')[0];
	if (!base || base.startsWith('.')) return null;
	const stdlib = new Set([
		'abc',
		'argparse',
		'asyncio',
		'base64',
		'collections',
		'dataclasses',
		'datetime',
		'enum',
		'functools',
		'hashlib',
		'inspect',
		'itertools',
		'json',
		'logging',
		'math',
		'os',
		'pathlib',
		'random',
		're',
		'statistics',
		'string',
		'sys',
		'time',
		'typing',
		'uuid',
	]);
	return stdlib.has(base) ? null : base;
}

export function deriveCodeFunctionDependencies(model: CodeParserModel): string[] {
	return [
		...new Set(
			(model.imports || [])
				.filter((item) => item.kind === 'external' && typeof item.specifier === 'string')
				.map((item) => normalizeExternalCodeDependency(model.language, item.specifier))
				.filter((item): item is string => Boolean(item)),
		),
	];
}

export async function listCodeFunctions(userId?: string | null): Promise<CodeFunctionSummary[]> {
	const database = requireDb();
	const ownerId = requireUserId(userId);
	const rows = await database
		.select()
		.from(codeFunctions)
		.where(eq(codeFunctions.createdBy, ownerId))
		.orderBy(desc(codeFunctions.updatedAt));

	return rows.map(toSummary);
}

export async function getCodeFunction(
	id: string,
	userId?: string | null,
): Promise<CodeFunctionDetail | null> {
	const database = requireDb();
	const ownerId = requireUserId(userId);
	const [row] = await database
		.select()
		.from(codeFunctions)
		.where(and(eq(codeFunctions.id, id), eq(codeFunctions.createdBy, ownerId)))
		.limit(1);

	if (!row) return null;

	const revisions = await database
		.select()
		.from(codeFunctionRevisions)
		.where(and(eq(codeFunctionRevisions.codeFunctionId, row.id), eq(codeFunctionRevisions.createdBy, ownerId)))
		.orderBy(desc(codeFunctionRevisions.publishedAt));

	return toDetail(row, revisions.map(toRevisionSummary));
}

export async function getCodeFunctionBySlugForUser(
	slug: string,
	userId?: string | null,
): Promise<CodeFunctionDetail | null> {
	const database = requireDb();
	const ownerId = requireUserId(userId);
	const [row] = await database
		.select()
		.from(codeFunctions)
		.where(and(eq(codeFunctions.slug, slug), eq(codeFunctions.createdBy, ownerId)))
		.limit(1);
	return row ? toDetail(row) : null;
}

export async function getCodeFunctionBySlug(
	slug: string,
	version: string,
	userId?: string | null,
): Promise<CodeFunctionDetail | null> {
	const database = requireDb();
	const ownerId = requireUserId(userId);
	const [row] = await database
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

	const [revision] = await database
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

export async function listCodeFunctionRevisions(
	codeFunctionId: string,
	userId?: string | null,
): Promise<CodeFunctionRevisionSummary[]> {
	const database = requireDb();
	const ownerId = requireUserId(userId);
	const rows = await database
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

export async function publishCodeFunction(
	id: string,
	userId?: string | null,
): Promise<CodeFunctionDetail | null> {
	const database = requireDb();
	const ownerId = requireUserId(userId);
	const [row] = await database
		.select()
		.from(codeFunctions)
		.where(and(eq(codeFunctions.id, id), eq(codeFunctions.createdBy, ownerId)))
		.limit(1);

	if (!row) return null;

	const version = `pub_${Date.now()}_${randomBytes(3).toString('hex')}`;
	await database.insert(codeFunctionRevisions).values({
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
			row.supportingFiles && typeof row.supportingFiles === 'object'
				? (row.supportingFiles as Record<string, string>)
				: null,
		sourceHash: row.sourceHash,
		semanticModel: row.semanticModel,
		inputSchema: row.inputSchema,
		returnType: row.returnType,
		imports: row.imports,
		diagnostics: row.diagnostics,
		capabilities: row.capabilities,
		role: (row.role ?? 'function') as CodeFunctionRole,
		compositionGraph: (row.compositionGraph as CodeFunctionCompositionGraph | null) ?? null,
		createdBy: ownerId,
	});

	const [updated] = await database
		.update(codeFunctions)
		.set({
			latestPublishedVersion: version,
			lastPublishedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(and(eq(codeFunctions.id, id), eq(codeFunctions.createdBy, ownerId)))
		.returning();

	if (!updated) return null;
	const revisions = await listCodeFunctionRevisions(id, ownerId);
	return toDetail(updated, revisions);
}

export async function createCodeFunction(
	input: SaveCodeFunctionInput,
	userId?: string | null,
): Promise<CodeFunctionDetail> {
	const database = requireDb();
	const ownerId = requireUserId(userId);
	const normalized = normalizeInput(input);
	const model = await parseModel(normalized);
	const slug = await ensureUniqueSlug(normalized.name);

	const [created] = await database
		.insert(codeFunctions)
		.values({
			name: normalized.name,
			slug,
			description: normalized.description,
			version: '0.1.0',
			language: normalized.language,
			entrypoint: normalized.entrypoint || 'main',
			path: normalized.path,
			source: normalized.source,
			supportingFiles: normalized.supportingFiles ?? null,
			sourceHash: buildSourceHash(normalized.source, normalized.supportingFiles),
			semanticModel: model,
			inputSchema: model.schema,
			returnType: model.return_type,
			imports: model.imports,
			diagnostics: model.diagnostics,
			capabilities: model.capabilities,
			role: normalized.role ?? 'function',
			compositionGraph: normalized.compositionGraph ?? null,
			createdBy: ownerId,
		})
		.returning();

	return toDetail(created);
}

export async function updateCodeFunction(
	id: string,
	input: SaveCodeFunctionInput,
	userId?: string | null,
): Promise<CodeFunctionDetail | null> {
	const database = requireDb();
	const ownerId = requireUserId(userId);
	const normalized = normalizeInput(input);
	const model = await parseModel(normalized);
	const slug = await ensureUniqueSlug(normalized.name, id);

	const [updated] = await database
		.update(codeFunctions)
		.set({
			name: normalized.name,
			slug,
			description: normalized.description,
			language: normalized.language,
			entrypoint: normalized.entrypoint || 'main',
			path: normalized.path,
			source: normalized.source,
			supportingFiles: normalized.supportingFiles ?? null,
			sourceHash: buildSourceHash(normalized.source, normalized.supportingFiles),
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

export async function deleteCodeFunction(
	id: string,
	userId?: string | null,
): Promise<boolean> {
	const database = requireDb();
	const ownerId = requireUserId(userId);
	const deleted = await database
		.delete(codeFunctions)
		.where(and(eq(codeFunctions.id, id), eq(codeFunctions.createdBy, ownerId)))
		.returning({ id: codeFunctions.id });

	return deleted.length > 0;
}

export async function listCodeFunctionsForCatalog(
	userId?: string | null,
): Promise<
	Array<{
		name: string;
		version: string;
		displayName: string;
		description: string;
		pieceName: string;
		actionName: string;
		sourceKind: 'code';
		codeFunctionId: string;
		language: CodeParserLanguage;
	}>
> {
	const functions = await listCodeFunctions(userId);
	return functions.map((item) => ({
		name: item.slug,
		version: item.latestPublishedVersion || item.version,
		displayName: item.name,
		description: item.description || '',
		pieceName: 'code-functions',
		actionName: item.entrypoint,
		sourceKind: 'code' as const,
		codeFunctionId: item.id,
		language: item.language,
	}));
}

export function toCodeCatalogFunction(row: typeof codeFunctions.$inferSelect) {
	return {
		name: row.slug,
		version: row.latestPublishedVersion || row.version,
		displayName: row.name,
		description: row.description || '',
		pieceName: 'code-functions',
		actionName: row.entrypoint,
		sourceKind: 'code' as const,
		codeFunctionId: row.id,
		language: row.language,
	};
}

export function toCodeFunctionDefinition(row: typeof codeFunctions.$inferSelect) {
	const detail = toDetail(row);
	return toCodeFunctionDefinitionFromDetail(detail);
}

export function toCodeFunctionDefinitionFromDetail(detail: CodeFunctionDetail) {
	const taskConfig = {
		call: `code/${detail.slug}`,
		with: {
			body: {
				input: {},
				metadata: {
					sourceKind: 'code' as const,
					codeFunctionId: detail.id,
					slug: detail.slug,
					version: detail.latestPublishedVersion || detail.version,
					language: detail.language,
					entrypoint: detail.entrypoint,
					path: detail.path,
				},
			},
			functionRef: {
				id: detail.id,
				slug: detail.slug,
				version: detail.latestPublishedVersion || detail.version,
			},
		},
	};

	return {
		sourceKind: 'code' as const,
		codeFunction: {
			id: detail.id,
			name: detail.name,
			slug: detail.slug,
			language: detail.language,
			entrypoint: detail.entrypoint,
			version: detail.latestPublishedVersion || detail.version,
			path: detail.path,
		},
		semanticModel: detail.model,
		inputSchema: detail.model.schema,
		outputSchema: detail.model.return_type,
		diagnostics: detail.model.diagnostics,
		taskConfig,
		call: taskConfig.call,
		with: taskConfig.with,
		input: {
			schema: {
				document: detail.model.schema,
			},
		},
		output: {
			schema: {
				document: detail.model.return_type,
			},
		},
	};
}
