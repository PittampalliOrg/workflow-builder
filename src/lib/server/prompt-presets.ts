import type {
	PromptArgumentDefinition,
	PromptPresetMetadata,
	PromptPresetSummary,
	PromptPresetVersion,
	PromptTemplateFormat,
	PromptTemplateMessage,
	PromptTemplateRole,
} from "$lib/types/prompt-presets";
import type { PromptPresetRef } from "$lib/types/agents";
import { templateHash } from "$lib/agents/prompt-workbench-renderer";

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

export type PromptPresetRecord = {
	id: string;
	name: string;
	description: string | null;
	systemPrompt: string;
	userPrompt: string | null;
	version: number;
	isEnabled: boolean;
	metadata: unknown;
	userId: string;
	projectId: string | null;
	createdAt: Date;
	updatedAt: Date;
};

export type PromptPresetVersionRecord = {
	id: string;
	promptId: string;
	version: number;
	messages: PromptTemplateMessage[];
	templateArguments: PromptArgumentDefinition[];
	templateFormat: PromptTemplateFormat;
	templateHash: string;
	metadata: unknown;
	createdByUserId: string | null;
	createdAt: Date;
	mlflowUri?: string | null;
};

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
	return {
		name,
		description,
		messages,
		arguments: args,
		templateFormat,
		metadata,
	};
}

export function promptParentFieldsFromMessages(
	messages: PromptTemplateMessage[],
): {
	systemPrompt: string;
	userPrompt: string | null;
	promptMode: "system" | "system+user";
} {
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
			throw new PromptPresetValidationError(
				`messages[${index}] must be an object`,
			);
		}
		const record = item as Record<string, unknown>;
		const role = normalizeRole(record.role);
		const content = typeof record.content === "string" ? record.content : "";
		if (!content.trim()) {
			throw new PromptPresetValidationError(
				`messages[${index}].content is required`,
			);
		}
		return { role, content };
	});
}

function normalizeRole(value: unknown): PromptTemplateRole {
	if (value === "system" || value === "user" || value === "assistant")
		return value;
	throw new PromptPresetValidationError(
		"message role must be system, user, or assistant",
	);
}

function normalizeArguments(value: unknown): PromptArgumentDefinition[] {
	if (!Array.isArray(value)) {
		throw new PromptPresetValidationError("arguments must be an array");
	}
	return value.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new PromptPresetValidationError(
				`arguments[${index}] must be an object`,
			);
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
			...(typeof record.required === "boolean"
				? { required: record.required }
				: {}),
		};
	});
}

function normalizeTemplateFormat(value: unknown): PromptTemplateFormat {
	if (value === undefined || value === null || value === "mustache")
		return "mustache";
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

export function legacyPromptPresetMessages(
	prompt: Pick<PromptPresetRecord, "systemPrompt" | "userPrompt">,
): PromptTemplateMessage[] {
	const messages: PromptTemplateMessage[] = [
		{ role: "system", content: prompt.systemPrompt },
	];
	if (prompt.userPrompt)
		messages.push({ role: "user", content: prompt.userPrompt });
	return messages;
}

export function promptPresetRowToSummary(
	prompt: PromptPresetRecord,
	version: PromptPresetVersionRecord | null,
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
		latestVersion: version
			? promptPresetVersionToSummary(version)
			: legacyVersion(prompt),
	};
}

export function promptPresetVersionToSummary(
	version: PromptPresetVersionRecord,
): PromptPresetVersion {
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

function legacyVersion(prompt: PromptPresetRecord): PromptPresetVersion {
	const messages = legacyPromptPresetMessages(prompt);
	return {
		id: `${prompt.id}:legacy`,
		promptId: prompt.id,
		version: prompt.version,
		messages,
		arguments: [],
		templateFormat: "mustache",
		templateHash: templateHash({
			messages,
			arguments: [],
			templateFormat: "mustache",
		}),
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

	function resolveManifest(
		refs: PromptPresetRef[],
	): CompiledPromptStackEntry[] {
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
