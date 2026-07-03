import { createHash } from "node:crypto";
import type {
	CodeParserLanguage,
	CodeParserModel,
} from "$lib/server/code-parser";

export type CodeFunctionRole = "function" | "workflow";

export interface CodeFunctionCompositionGraph {
	activitySlugs: string[];
	hasFork: boolean;
	hasSwitch: boolean;
	hasDurableAgent: boolean;
}

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

export function normalizeCodeFunctionInput(
	input: SaveCodeFunctionInput,
): SaveCodeFunctionInput {
	const supportingFiles =
		input.supportingFiles && typeof input.supportingFiles === "object"
			? Object.fromEntries(
					Object.entries(input.supportingFiles)
						.filter(
							([path, value]) =>
								typeof path === "string" &&
								path.trim().length > 0 &&
								typeof value === "string",
						)
						.map(([path, value]) => [path.trim(), value]),
				)
			: null;

	return {
		name: input.name.trim(),
		description: input.description?.trim() || null,
		language: input.language,
		entrypoint: input.entrypoint?.trim() || "main",
		path: input.path?.trim() || null,
		source: input.source,
		supportingFiles:
			supportingFiles && Object.keys(supportingFiles).length > 0
				? supportingFiles
				: null,
		role: input.role ?? "function",
		compositionGraph: input.compositionGraph ?? null,
	};
}

export function slugifyCodeFunctionName(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64) || "code-function"
	);
}

export function buildCodeFunctionSourceHash(
	source: string,
	supportingFiles?: Record<string, string> | null,
): string {
	const hash = createHash("sha256").update(source);
	if (supportingFiles && Object.keys(supportingFiles).length > 0) {
		for (const [path, contents] of Object.entries(supportingFiles).sort(
			([left], [right]) => left.localeCompare(right),
		)) {
			hash.update("\n@@file:").update(path).update("\n").update(contents);
		}
	}
	return hash.digest("hex");
}

export function normalizeExternalCodeDependency(
	language: CodeParserLanguage | string,
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

export function deriveCodeFunctionDependencies(model: {
	language: string;
	imports?: Array<{ kind?: string; specifier?: string }>;
}): string[] {
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

export function toCodeFunctionDefinitionFromDetail(detail: CodeFunctionDetail) {
	const taskConfig = {
		call: `code/${detail.slug}`,
		with: {
			body: {
				input: {},
				metadata: {
					sourceKind: "code" as const,
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
		sourceKind: "code" as const,
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
