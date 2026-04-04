import AjvModule from "ajv";
import { getSql } from "./db.js";

type FunctionRef = {
	id?: string;
	slug?: string;
	version?: string;
};

type SemanticParam = {
	name?: string;
	required?: boolean;
	type?: {
		kind?: string;
	};
};

type ImportRef = {
	specifier?: string;
	kind?: "local" | "external";
	resolved_path?: string | null;
};

type CodeFunctionRow = {
	id: string;
	name: string;
	slug: string;
	version: string;
	language: string;
	entrypoint: string;
	path: string | null;
	source: string;
	supporting_files: unknown;
	semantic_model: unknown;
	input_schema: unknown;
	imports: unknown;
	is_enabled: boolean;
};

type ResolvedCodeFunctionExecution = {
	runtimeRequest: {
		language: "typescript" | "python";
		source: string;
		entrypoint: string;
		path: string | null;
		supporting_files: Record<string, string>;
		args: unknown[];
		dependencies: string[];
	};
	functionRef: {
		id: string;
		slug: string;
		version: string;
	};
};

const Ajv = AjvModule as unknown as new (options?: Record<string, unknown>) => {
	compile: (
		schema: Record<string, unknown>,
	) => ((data: unknown) => boolean) & { errors?: unknown[] };
};

const ajv = new Ajv({
	allErrors: true,
	allowUnionTypes: true,
	strict: false,
});

const validatorCache = new Map<string, ReturnType<typeof ajv.compile>>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function asFunctionRef(value: unknown): FunctionRef | null {
	if (!isRecord(value)) return null;
	const ref: FunctionRef = {};
	if (typeof value.id === "string" && value.id.trim()) {
		ref.id = value.id.trim();
	}
	if (typeof value.slug === "string" && value.slug.trim()) {
		ref.slug = value.slug.trim();
	}
	if (typeof value.version === "string" && value.version.trim()) {
		ref.version = value.version.trim();
	}
	return ref.id || ref.slug ? ref : null;
}

function parseSchema(value: unknown): Record<string, unknown> | null {
	if (isRecord(value)) return value;
	if (typeof value !== "string" || !value.trim()) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function compileValidator(schema: Record<string, unknown>) {
	const key = JSON.stringify(schema);
	const cached = validatorCache.get(key);
	if (cached) return cached;
	const validator = ajv.compile(schema);
	validatorCache.set(key, validator);
	return validator;
}

function semanticParams(value: unknown): SemanticParam[] {
	if (!isRecord(value) || !Array.isArray(value.params)) {
		return [];
	}
	return value.params.filter((item): item is SemanticParam => isRecord(item));
}

function importRefs(value: unknown): ImportRef[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is ImportRef => isRecord(item));
}

function supportingFilesMap(value: unknown): Record<string, string> {
	if (!isRecord(value)) {
		return {};
	}
	const entries = Object.entries(value).filter(
		(entry): entry is [string, string] =>
			typeof entry[0] === "string" && typeof entry[1] === "string",
	);
	return Object.fromEntries(entries) as Record<string, string>;
}

function extractCodeInput(rawInput: Record<string, unknown>): {
	functionRef: FunctionRef | null;
	input: Record<string, unknown>;
} {
	const directRef = asFunctionRef(rawInput.functionRef);
	const body = isRecord(rawInput.body) ? rawInput.body : null;
	const bodyInput = body && isRecord(body.input) ? body.input : null;
	const bodyMetadata = body && isRecord(body.metadata) ? body.metadata : null;
	const metadataRef =
		asFunctionRef(bodyMetadata) || asFunctionRef(rawInput.metadata);
	const functionRef = directRef || metadataRef;

	if (bodyInput) {
		return { functionRef, input: bodyInput };
	}

	if (isRecord(rawInput.input)) {
		return {
			functionRef,
			input: rawInput.input,
		};
	}

	const input = Object.fromEntries(
		Object.entries(rawInput).filter(
			([key]) =>
				key !== "actionType" &&
				key !== "functionRef" &&
				key !== "metadata" &&
				key !== "body" &&
				key !== "input",
		),
	);

	return {
		functionRef,
		input,
	};
}

function buildInvocationArgs(
	input: Record<string, unknown>,
	params: SemanticParam[],
): unknown[] {
	if (params.length === 0) {
		return [];
	}

	if (params.length === 1) {
		const [param] = params;
		const name = typeof param.name === "string" ? param.name : "input";
		const kind = param.type?.kind;
		const hasNamedValue = Object.prototype.hasOwnProperty.call(input, name);

		if (kind === "object") {
			if (hasNamedValue && Object.keys(input).length === 1) {
				return [input[name]];
			}
			return [input];
		}

		return [hasNamedValue ? input[name] : input];
	}

	return params.map((param) => {
		const name = typeof param.name === "string" ? param.name : "";
		if (name && Object.prototype.hasOwnProperty.call(input, name)) {
			return input[name];
		}
		if (param.required) {
			throw new Error(`Missing required input "${name || "unknown"}"`);
		}
		return undefined;
	});
}

function normalizeExternalDependency(
	language: "typescript" | "python",
	specifier: string,
): string | null {
	if (language === "typescript") {
		if (
			specifier.startsWith("node:") ||
			specifier.startsWith("jsr:") ||
			specifier.startsWith("bun:") ||
			specifier.startsWith("http://") ||
			specifier.startsWith("https://")
		) {
			return null;
		}
		const normalized = specifier.startsWith("npm:")
			? specifier.slice(4)
			: specifier;
		if (!normalized || normalized.startsWith(".") || normalized.startsWith("/")) {
			return null;
		}
		if (normalized.startsWith("@")) {
			const [scope, name] = normalized.split("/");
			return scope && name ? `${scope}/${name}` : normalized;
		}
		return normalized.split("/")[0] || null;
	}

	const base = specifier.trim().split(".")[0];
	if (!base || base.startsWith(".")) return null;
	const stdlib = new Set([
		"abc",
		"argparse",
		"asyncio",
		"base64",
		"collections",
		"dataclasses",
		"datetime",
		"enum",
		"functools",
		"hashlib",
		"inspect",
		"itertools",
		"json",
		"logging",
		"math",
		"os",
		"pathlib",
		"random",
		"re",
		"statistics",
		"string",
		"sys",
		"time",
		"typing",
		"uuid",
	]);
	return stdlib.has(base) ? null : base;
}

function localImportCandidates(
	language: "typescript" | "python",
	resolvedPath: string,
): string[] {
	if (language === "typescript") {
		return [
			`${resolvedPath}.ts`,
			`${resolvedPath}.tsx`,
			`${resolvedPath}.js`,
			`${resolvedPath}.mjs`,
			`${resolvedPath}.cjs`,
			`${resolvedPath}/index.ts`,
			`${resolvedPath}/index.tsx`,
			`${resolvedPath}/index.js`,
			`${resolvedPath}/index.mjs`,
			`${resolvedPath}/index.cjs`,
		];
	}

	return [`${resolvedPath}.py`, `${resolvedPath}/__init__.py`];
}

function assertLocalImportsCovered(
	language: "typescript" | "python",
	imports: ImportRef[],
	supportingFiles: Record<string, string>,
) {
	const available = new Set(Object.keys(supportingFiles));
	const missing = imports
		.filter(
			(item): item is ImportRef & { resolved_path: string } =>
				item.kind === "local" && typeof item.resolved_path === "string",
		)
		.filter((item) =>
			!localImportCandidates(language, item.resolved_path).some((candidate) =>
				available.has(candidate),
			),
		)
		.map((item) => item.specifier || item.resolved_path);

	if (missing.length > 0) {
		throw new Error(
			`Saved code function is missing supporting files for local imports: ${missing.join(", ")}`,
		);
	}
}

function deriveDependencies(
	language: "typescript" | "python",
	imports: ImportRef[],
): string[] {
	return [
		...new Set(
			imports
				.filter(
					(item) =>
						item.kind === "external" && typeof item.specifier === "string",
				)
				.map((item) =>
					normalizeExternalDependency(language, item.specifier || ""),
				)
				.filter((item): item is string => Boolean(item)),
		),
	];
}

async function fetchById(id: string): Promise<CodeFunctionRow | null> {
	const sql = getSql();
	const rows = await sql<CodeFunctionRow[]>`
		SELECT
			id,
			name,
			slug,
			version,
			language,
			entrypoint,
			path,
			source,
			supporting_files,
			semantic_model,
			input_schema,
			imports,
			is_enabled
		FROM code_functions
		WHERE id = ${id}
		LIMIT 1
	`;
	return rows[0] ?? null;
}

async function fetchBySlugVersion(
	slug: string,
	version?: string,
): Promise<CodeFunctionRow | null> {
	const sql = getSql();
	if (version) {
		const rows = await sql<CodeFunctionRow[]>`
			SELECT
				id,
				name,
				slug,
				version,
				language,
				entrypoint,
				path,
				source,
				supporting_files,
				semantic_model,
				input_schema,
				imports,
				is_enabled
			FROM code_functions
			WHERE slug = ${slug} AND version = ${version}
			LIMIT 1
		`;
		return rows[0] ?? null;
	}

	const rows = await sql<CodeFunctionRow[]>`
		SELECT
			id,
			name,
			slug,
			version,
			language,
			entrypoint,
			path,
			source,
			supporting_files,
			semantic_model,
			input_schema,
			imports,
			is_enabled
		FROM code_functions
		WHERE slug = ${slug}
		ORDER BY updated_at DESC
		LIMIT 1
	`;
	return rows[0] ?? null;
}

async function fetchPublishedRevision(
	slug: string,
	version: string,
): Promise<CodeFunctionRow | null> {
	const sql = getSql();
	const rows = await sql<CodeFunctionRow[]>`
		SELECT
			code_function_id AS id,
			name,
			slug,
			version,
			language,
			entrypoint,
			path,
			source,
			supporting_files,
			semantic_model,
			input_schema,
			imports,
			true AS is_enabled
		FROM code_function_revisions
		WHERE slug = ${slug} AND version = ${version}
		LIMIT 1
	`;
	return rows[0] ?? null;
}

export async function resolveCodeFunctionExecution(
	rawInput: Record<string, unknown>,
): Promise<ResolvedCodeFunctionExecution> {
	const extracted = extractCodeInput(rawInput);
	if (!extracted.functionRef) {
		throw new Error(
			"Code function execution requires taskConfig.with.functionRef or metadata.codeFunctionId",
		);
	}

	const row =
		(extracted.functionRef.slug && extracted.functionRef.version
			? await fetchPublishedRevision(
					extracted.functionRef.slug,
					extracted.functionRef.version,
				)
			: null) ??
		(extracted.functionRef.id
			? await fetchById(extracted.functionRef.id)
			: null) ??
		(extracted.functionRef.slug
			? await fetchBySlugVersion(
					extracted.functionRef.slug,
					extracted.functionRef.version,
				)
			: null);

	if (!row || row.is_enabled !== true) {
		throw new Error("Saved code function was not found or is disabled");
	}

	if (row.language !== "typescript" && row.language !== "python") {
		throw new Error(`Unsupported code function language: ${row.language}`);
	}

	const imports = importRefs(row.imports);
	const supportingFiles = supportingFilesMap(row.supporting_files);
	if (imports.some((item) => item.kind === "local")) {
		if (Object.keys(supportingFiles).length === 0) {
			throw new Error(
				"Saved code function uses local imports. Add supporting files before executing it.",
			);
		}
		assertLocalImportsCovered(row.language, imports, supportingFiles);
	}

	const inputSchema = parseSchema(row.input_schema);
	if (inputSchema) {
		const validator = compileValidator(inputSchema);
		const valid = validator(extracted.input);
		if (!valid) {
			const detail = ((validator.errors || []) as Array<{
				instancePath?: string;
				schemaPath?: string;
				message?: string;
			}>)
				.map((issue) => {
					const location = issue.instancePath || issue.schemaPath || "/";
					return `${location}: ${issue.message || "invalid input"}`;
				})
				.join("; ");
			throw new Error(`Code function input validation failed: ${detail}`);
		}
	}

	return {
		runtimeRequest: {
			language: row.language,
			source: row.source,
			entrypoint: row.entrypoint || "main",
			path: row.path,
			supporting_files: supportingFiles,
			args: buildInvocationArgs(
				extracted.input,
				semanticParams(row.semantic_model),
			),
			dependencies: deriveDependencies(row.language, imports),
		},
		functionRef: {
			id: row.id,
			slug: row.slug,
			version: row.version,
		},
	};
}
