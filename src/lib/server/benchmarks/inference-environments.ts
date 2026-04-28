import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_SANDBOX_TEMPLATE = "dapr-agent";

type MappingSource = {
	source: string;
	entry: Record<string, unknown>;
	key?: string;
};

export type SwebenchInferenceEnvironmentMapping = {
	suite?: string | null;
	repo?: string | null;
	version?: string | null;
	environmentSetupCommit?: string | null;
	baseCommit?: string | null;
	environmentKey?: string | null;
	sandboxTemplate?: string | null;
	sandboxImage?: string | null;
	digest?: string | null;
	validationStatus?: string | null;
	validationLogRef?: string | null;
	validationCommand?: string | null;
	environmentNotes?: string[];
	builtAt?: string | null;
	source?: string | null;
};

export type ResolvedSwebenchInferenceEnvironment = {
	environmentStatus: "validated" | "fallback" | "building" | "failed";
	suite: string;
	repo: string;
	environmentKey?: string;
	version?: string;
	environmentSetupCommit?: string;
	baseCommit?: string;
	sandboxTemplate: string;
	sandboxImage?: string;
	digest?: string;
	validationStatus?: string;
	validationLogRef?: string;
	validationCommand?: string;
	environmentNotes?: string[];
	builtAt?: string;
	source?: string;
	reason?: string;
	buildStrategy?: string;
	envSpecHash?: string;
	buildLogRef?: string;
	pipelineRunName?: string;
};

export type ResolveSwebenchInferenceEnvironmentInput = {
	suiteSlug: string;
	repo: string | null | undefined;
	baseCommit: string | null | undefined;
	testMetadata?: Record<string, unknown> | null;
};

export type LoadSwebenchInferenceEnvironmentOptions = {
	env?: Record<string, string | undefined>;
};

export function resolveSwebenchInferenceEnvironment(
	input: ResolveSwebenchInferenceEnvironmentInput,
	options: LoadSwebenchInferenceEnvironmentOptions = {},
): ResolvedSwebenchInferenceEnvironment {
	const suite = input.suiteSlug.trim();
	const repo = normalizeRepo(input.repo);
	const baseCommit = readString(input.baseCommit);
	const version = readMetadataString(input.testMetadata, ["version"]);
	const environmentSetupCommit = readMetadataString(input.testMetadata, [
		"environmentSetupCommit",
		"environment_setup_commit",
	]);
	const fallback = (reason: string): ResolvedSwebenchInferenceEnvironment => ({
		environmentStatus: "fallback",
		suite,
		repo: repo ?? "",
		version: version ?? undefined,
		environmentSetupCommit: environmentSetupCommit ?? undefined,
		baseCommit: baseCommit ?? undefined,
		sandboxTemplate: DEFAULT_SANDBOX_TEMPLATE,
		reason,
	});

	if (!repo) return fallback("missing_repo");

	const mappings = loadSwebenchInferenceEnvironmentMappings(options);
	const match = selectBestMapping(mappings, {
		suite,
		repo,
		baseCommit,
		version,
		environmentSetupCommit,
	});
	if (!match) return fallback("no_validated_mapping");

	const normalized = normalizeMapping(match);
	if (!isValidatedStatus(normalized.validationStatus)) {
		return {
			...fallback("mapping_not_validated"),
			environmentKey: normalized.environmentKey ?? undefined,
			validationStatus: normalized.validationStatus ?? undefined,
			validationLogRef: normalized.validationLogRef ?? undefined,
			source: normalized.source ?? undefined,
		};
	}

	const sandboxImage = imageWithDigest(normalized.sandboxImage, normalized.digest);
	if (!sandboxImage) {
		return {
			...fallback("mapping_missing_digest_or_image"),
			environmentKey: normalized.environmentKey ?? undefined,
			validationStatus: normalized.validationStatus ?? undefined,
			validationLogRef: normalized.validationLogRef ?? undefined,
			source: normalized.source ?? undefined,
		};
	}

	return {
		environmentStatus: "validated",
		suite: normalized.suite ?? suite,
		repo: normalized.repo ?? repo,
		environmentKey: normalized.environmentKey ?? undefined,
		version: normalized.version ?? version ?? undefined,
		environmentSetupCommit:
			normalized.environmentSetupCommit ?? environmentSetupCommit ?? undefined,
		baseCommit: normalized.baseCommit ?? baseCommit ?? undefined,
		sandboxTemplate: normalized.sandboxTemplate ?? DEFAULT_SANDBOX_TEMPLATE,
		sandboxImage,
		digest: normalized.digest ?? digestFromImage(sandboxImage) ?? undefined,
		validationStatus: normalized.validationStatus ?? undefined,
		validationLogRef: normalized.validationLogRef ?? undefined,
		validationCommand: normalized.validationCommand ?? undefined,
		environmentNotes: normalized.environmentNotes,
		builtAt: normalized.builtAt ?? undefined,
		source: normalized.source ?? undefined,
	};
}

export function loadSwebenchInferenceEnvironmentMappings(
	options: LoadSwebenchInferenceEnvironmentOptions = {},
): SwebenchInferenceEnvironmentMapping[] {
	const env = options.env ?? process.env;
	const mappings: MappingSource[] = [];
	const rawJson = readString(env.SWEBENCH_INFERENCE_ENVIRONMENTS_JSON);
	if (rawJson) mappings.push(...parseMappingJson(rawJson, "env:SWEBENCH_INFERENCE_ENVIRONMENTS_JSON"));

	const configPath = readString(env.SWEBENCH_INFERENCE_ENVIRONMENTS_FILE);
	if (configPath && existsSync(configPath)) {
		mappings.push(...parseMappingJson(readFileSync(configPath, "utf8"), configPath));
	}

	const configDir = readString(env.SWEBENCH_INFERENCE_ENVIRONMENTS_DIR);
	if (configDir && existsSync(configDir)) {
		for (const file of readdirSync(configDir).sort()) {
			if (!file.endsWith(".json")) continue;
			const path = join(configDir, file);
			mappings.push(...parseMappingJson(readFileSync(path, "utf8"), path));
		}
	}

	return mappings.map((mapping) => normalizeMapping(mapping.entry));
}

function selectBestMapping(
	mappings: SwebenchInferenceEnvironmentMapping[],
	input: {
		suite: string;
		repo: string;
		baseCommit: string | null;
		version: string | null;
		environmentSetupCommit: string | null;
	},
): SwebenchInferenceEnvironmentMapping | null {
	let best: { mapping: SwebenchInferenceEnvironmentMapping; score: number } | null = null;
	for (const mapping of mappings) {
		const normalized = normalizeMapping(mapping);
		if (!matchesOptional(normalized.suite, input.suite)) continue;
		if (normalizeRepo(normalized.repo) !== input.repo) continue;
		const score = matchScore(normalized, input);
		if (score <= 0) continue;
		if (!best || score > best.score) best = { mapping: normalized, score };
	}
	return best?.mapping ?? null;
}

function matchScore(
	mapping: SwebenchInferenceEnvironmentMapping,
	input: {
		baseCommit: string | null;
		version: string | null;
		environmentSetupCommit: string | null;
	},
): number {
	if (
		input.environmentSetupCommit &&
		mapping.environmentSetupCommit === input.environmentSetupCommit
	) {
		return 300;
	}
	if (input.version && mapping.version === input.version) return 200;
	if (input.baseCommit && mapping.baseCommit === input.baseCommit) return 100;
	return 0;
}

function normalizeMapping(input: Record<string, unknown>): SwebenchInferenceEnvironmentMapping {
	const suite = readString(input.suite);
	const repo = normalizeRepo(input.repo);
	const environmentSetupCommit =
		readString(input.environmentSetupCommit) ??
		readString((input as Record<string, unknown>).environment_setup_commit);
	const baseCommit =
		readString(input.baseCommit) ?? readString((input as Record<string, unknown>).base_commit);
	const environmentKey =
		readString(input.environmentKey) ?? readString((input as Record<string, unknown>).environment_key);
	const sandboxTemplate =
		readString(input.sandboxTemplate) ??
		readString((input as Record<string, unknown>).sandbox_template);
	const sandboxImage =
		readString(input.sandboxImage) ?? readString((input as Record<string, unknown>).sandbox_image);
	const validationStatus =
		readString(input.validationStatus) ??
		readString((input as Record<string, unknown>).validation_status);
	const validationLogRef =
		readString(input.validationLogRef) ??
		readString((input as Record<string, unknown>).validation_log_ref);
	const validationCommand =
		readString(input.validationCommand) ??
		readString((input as Record<string, unknown>).validation_command);
	const environmentNotes = readStringList(
		input.environmentNotes ??
			(input as Record<string, unknown>).environment_notes ??
			input.agentNotes ??
			(input as Record<string, unknown>).agent_notes,
	);
	const builtAt = readString(input.builtAt) ?? readString((input as Record<string, unknown>).built_at);
	return {
		...input,
		suite,
		repo,
		version: readString(input.version),
		environmentSetupCommit,
		baseCommit,
		environmentKey,
		sandboxTemplate,
		sandboxImage,
		digest: readString(input.digest),
		validationStatus,
		validationLogRef,
		validationCommand,
		environmentNotes,
		builtAt,
		source: readString(input.source),
	};
}

export function swebenchInferenceEnvironmentPromptNotes(
	environment: ResolvedSwebenchInferenceEnvironment | null | undefined,
): string[] {
	if (environment?.environmentStatus !== "validated") return [];
	const notes = [
		"- This run is using a repo-specific inference image that passed its validation smoke before being pinned.",
		environment.validationCommand
			? `- Environment validation command: ${environment.validationCommand}`
			: "",
		environment.validationLogRef
			? `- Environment validation log: ${environment.validationLogRef}`
			: "",
		...(environment.environmentNotes ?? []).map((note) => `- ${note}`),
	];
	return notes.filter(Boolean);
}

function parseMappingJson(raw: string, source: string): MappingSource[] {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (Array.isArray(parsed)) {
			return parsed
				.filter(isRecord)
				.map((entry) => ({ source, entry: { ...entry, source } }));
		}
		if (isRecord(parsed) && Array.isArray(parsed.environments)) {
			return parsed.environments
				.filter(isRecord)
				.map((entry) => ({ source, entry: { ...entry, source } }));
		}
		if (isRecord(parsed)) {
			if (isMappingRecord(parsed)) {
				return [{ source, entry: { ...parsed, source } }];
			}
			return Object.entries(parsed).flatMap(([key, value]) => {
				if (!isRecord(value)) return [];
				return [{
					source,
					key,
					entry: { ...parseKeyHints(key), ...value, source },
				}];
			});
		}
	} catch {
		return [];
	}
	return [];
}

function parseKeyHints(key: string): Record<string, string> {
	const parts = key.split("|").map((part) => part.trim()).filter(Boolean);
	if (parts.length < 3) return {};
	const [suite, repo, selector] = parts;
	const hints: Record<string, string> = { suite, repo };
	if (/^[0-9a-f]{40}$/i.test(selector)) hints.baseCommit = selector;
	else hints.version = selector;
	return hints;
}

function imageWithDigest(image: string | null | undefined, digest: string | null | undefined): string | null {
	const normalizedImage = readString(image);
	if (!normalizedImage) return null;
	if (normalizedImage.includes("@sha256:")) return normalizedImage;
	const normalizedDigest = readString(digest);
	if (!normalizedDigest?.startsWith("sha256:")) return null;
	return `${normalizedImage}@${normalizedDigest}`;
}

function digestFromImage(image: string): string | null {
	const marker = "@sha256:";
	const index = image.indexOf(marker);
	if (index < 0) return null;
	return image.slice(index + 1);
}

function isValidatedStatus(status: string | null | undefined): boolean {
	const normalized = readString(status)?.toLowerCase();
	return normalized === "validated" || normalized === "passed" || normalized === "success";
}

function matchesOptional(candidate: string | null | undefined, expected: string): boolean {
	return !candidate || candidate === expected;
}

function readMetadataString(
	metadata: Record<string, unknown> | null | undefined,
	keys: string[],
): string | null {
	if (!metadata) return null;
	for (const key of keys) {
		const value = readString(metadata[key]);
		if (value) return value;
	}
	return null;
}

function normalizeRepo(value: unknown): string | null {
	const raw = readString(value);
	if (!raw) return null;
	return raw.replace("__", "/").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value)
		? value
		: typeof value === "string" && value.trim().startsWith("[")
			? parseStringListJson(value)
			: typeof value === "string"
				? value.split(/\r?\n/g)
				: [];
	const out = raw
		.map((item) => (typeof item === "string" ? item.trim() : ""))
		.filter(Boolean);
	return out.length ? out : undefined;
}

function parseStringListJson(value: string): unknown[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMappingRecord(value: Record<string, unknown>): boolean {
	return Boolean(readString(value.repo) && (readString(value.suite) || readString(value.sandboxImage)));
}
