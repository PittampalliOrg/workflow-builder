export class ApplicationCodeFunctionOptionsError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApplicationCodeFunctionOptionsError";
	}
}

export type CodeFunctionOptionsFunctionRef = {
	id?: string;
	slug?: string;
	version?: string;
};

export type CodeFunctionOptionsImport = {
	kind?: string;
	specifier?: string;
};

export type CodeFunctionOptionsDynamicInput = {
	name?: string;
	handler?: string;
};

export type CodeFunctionOptionsModel = {
	language: string;
	imports?: CodeFunctionOptionsImport[];
	dynamic_inputs?: CodeFunctionOptionsDynamicInput[];
};

export type CodeFunctionOptionsDetail = {
	id: string;
	slug: string;
	version: string;
	latestPublishedVersion: string | null;
	language: string;
	source: string;
	path: string | null;
	supportingFiles: Record<string, string>;
	model: CodeFunctionOptionsModel;
};

export type CodeFunctionOptionsRepository = {
	getById(id: string, userId: string): Promise<CodeFunctionOptionsDetail | null>;
	getBySlug(
		slug: string,
		version: string,
		userId: string,
	): Promise<CodeFunctionOptionsDetail | null>;
};

export type CodeFunctionOptionsRuntimeClient = {
	fetchOptions(input: {
		language: string;
		source: string;
		handler: string;
		path?: string;
		supportingFiles: Record<string, string>;
		input: Record<string, unknown>;
		dependencies: string[];
		searchValue?: string;
	}): Promise<{
		ok: boolean;
		status: number;
		payload: unknown;
	}>;
};

export type CodeFunctionOptionsRuntimePayload = {
	options?: unknown;
	disabled?: boolean;
	placeholder?: string;
	error?: string;
};

export type CodeFunctionOption = {
	label: string;
	value: unknown;
};

export type CodeFunctionOptionsResult = {
	options: CodeFunctionOption[];
	disabled?: boolean;
	placeholder?: string;
};

export class ApplicationCodeFunctionOptionsService {
	constructor(
		private readonly deps: {
			codeFunctions: CodeFunctionOptionsRepository;
			runtime: CodeFunctionOptionsRuntimeClient;
		},
	) {}

	async getOptions(input: {
		userId: string;
		body: unknown;
	}): Promise<CodeFunctionOptionsResult> {
		const body = isRecord(input.body) ? input.body : null;
		if (!body) {
			throw new ApplicationCodeFunctionOptionsError(400, "Invalid JSON body");
		}

		const functionRef = parseFunctionRef(body.functionRef);
		if (!functionRef) {
			throw new ApplicationCodeFunctionOptionsError(400, "functionRef is required");
		}

		const field = typeof body.param === "string" ? body.param.trim() : "";
		if (!field) {
			throw new ApplicationCodeFunctionOptionsError(400, "param is required");
		}

		const detail = await this.resolveDetail(functionRef, input.userId);
		if (!detail) {
			throw new ApplicationCodeFunctionOptionsError(
				404,
				"Code function not found",
			);
		}

		const dynamicInput =
			(detail.model.dynamic_inputs || []).find((item) => item.name === field) ||
			null;
		if (!dynamicInput?.handler) {
			throw new ApplicationCodeFunctionOptionsError(
				404,
				`No dynamic options handler configured for "${field}"`,
			);
		}

		const response = await this.deps.runtime.fetchOptions({
			language: detail.language,
			source: detail.source,
			handler: dynamicInput.handler,
			path: detail.path || undefined,
			supportingFiles: detail.supportingFiles || {},
			input: isRecord(body.input) ? body.input : {},
			dependencies: deriveCodeFunctionDependencies(detail.model),
			searchValue: parseSearchValue(body),
		});

		if (!response.ok || !response.payload) {
			const payload = isRecord(response.payload) ? response.payload : {};
			throw new ApplicationCodeFunctionOptionsError(
				response.status || 502,
				(typeof payload.error === "string" ? payload.error : null) ||
					`Code runtime returned HTTP ${response.status}`,
			);
		}

		return normalizeDynamicResult(response.payload);
	}

	private async resolveDetail(
		functionRef: CodeFunctionOptionsFunctionRef,
		userId: string,
	): Promise<CodeFunctionOptionsDetail | null> {
		let detail: CodeFunctionOptionsDetail | null = null;

		if (functionRef.slug && functionRef.version) {
			detail = await this.deps.codeFunctions.getBySlug(
				functionRef.slug,
				functionRef.version,
				userId,
			);
		}

		if (!detail && functionRef.id) {
			detail = await this.deps.codeFunctions.getById(functionRef.id, userId);
			if (
				detail &&
				functionRef.version &&
				functionRef.version !== detail.version &&
				functionRef.version !== detail.latestPublishedVersion
			) {
				detail =
					(await this.deps.codeFunctions.getBySlug(
						detail.slug,
						functionRef.version,
						userId,
					)) || detail;
			}
		}

		if (!detail && functionRef.slug && functionRef.version) {
			detail = await this.deps.codeFunctions.getBySlug(
				functionRef.slug,
				functionRef.version,
				userId,
			);
		}

		return detail;
	}
}

function parseFunctionRef(value: unknown): CodeFunctionOptionsFunctionRef | null {
	if (!isRecord(value)) return null;

	const ref: CodeFunctionOptionsFunctionRef = {};
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

function parseSearchValue(body: Record<string, unknown>): string | undefined {
	return typeof body.searchValue === "string"
		? body.searchValue
		: typeof body.search_value === "string"
			? body.search_value
			: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeDynamicOptions(value: unknown): CodeFunctionOption[] {
	if (!Array.isArray(value)) return [];

	const normalized: CodeFunctionOption[] = [];
	for (const item of value) {
		if (isRecord(item)) {
			const label =
				(typeof item.label === "string" && item.label) ||
				(typeof item.name === "string" && item.name) ||
				(typeof item.displayName === "string" && item.displayName) ||
				(typeof item.title === "string" && item.title) ||
				(typeof item.value === "string" && item.value) ||
				(typeof item.id === "string" && item.id) ||
				null;
			const optionValue =
				item.value ?? item.id ?? item.externalId ?? item.key ?? item.name ?? item.label;
			if (label && optionValue !== undefined) {
				normalized.push({ label, value: optionValue });
				continue;
			}
		}

		if (
			typeof item === "string" ||
			typeof item === "number" ||
			typeof item === "boolean"
		) {
			normalized.push({ label: String(item), value: item });
		}
	}
	return normalized;
}

function normalizeDynamicResult(value: unknown): CodeFunctionOptionsResult {
	if (!isRecord(value)) {
		return {
			options: normalizeDynamicOptions(value),
		};
	}

	return {
		options: normalizeDynamicOptions(value.options),
		disabled: value.disabled === true,
		placeholder:
			typeof value.placeholder === "string" ? value.placeholder : undefined,
	};
}

function deriveCodeFunctionDependencies(model: CodeFunctionOptionsModel): string[] {
	return [
		...new Set(
			(model.imports || [])
				.filter(
					(item) =>
						item.kind === "external" && typeof item.specifier === "string",
				)
				.map((item) =>
					normalizeExternalCodeDependency(model.language, item.specifier || ""),
				)
				.filter((item): item is string => Boolean(item)),
		),
	];
}

function normalizeExternalCodeDependency(
	language: string,
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
