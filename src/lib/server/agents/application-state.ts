import { createHash } from "node:crypto";
import { env } from "$env/dynamic/private";
import type { AgentConfig, AgentDetail } from "$lib/types/agents";
import { resolveAgentRuntimeRoute } from "./runtime-routing";
import { buildAgentMetadata, type AgentMetadataBlob } from "./registry-sync";
import { listRuntimes } from "./runtime-registry";

export type AgentApplicationStateAgentRow = {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	avatar: string | null;
	tags: unknown;
	runtime: string;
	runtimeAppId: string | null;
	environmentId: string | null;
	environmentVersion: number | null;
	defaultVaultIds: unknown;
	projectId: string | null;
	isArchived: boolean;
	registryStatus: string;
	registrySyncedAt: Date | string | null;
	registryError: string | null;
	createdAt: Date | string | null;
	updatedAt: Date | string | null;
	sourceTemplateSlug: string | null;
	sourceTemplateVersion: number | null;
};

export type AgentApplicationStateVersionRow = {
	id: string;
	version: number;
	config: unknown;
	configHash: string;
};

export type AgentApplicationStateManifest = {
	schemaVersion: "workflow-builder.agent-application-state.v1";
	agent: {
		id: string;
		slug: string;
		name: string;
		projectId: string | null;
		versionId: string;
		version: number;
		configHash: string;
		runtime: string;
		runtimeAppId: string | null;
		environmentId: string | null;
		environmentVersion: number | null;
	};
	dapr: {
		metadata: AgentMetadataBlob;
		components: {
			registryStore: string | null;
			statestore: string | null;
			pubsub: string | null;
		};
	};
	prompts: {
		presetManifest: AgentConfig["promptPresetManifest"];
		staticPresetRefs: AgentConfig["staticPromptPresetRefs"];
		dynamicPresetRefs: AgentConfig["dynamicPromptPresetRefs"];
		systemPromptSha256: string | null;
	};
	tools: {
		builtinTools: string[];
		toolNames: string[];
		mcpServers: unknown[];
		skills: unknown[];
		plugins: string[];
		callableAgents: string[];
	};
	model: {
		modelSpec: string | null;
		provider: string | null;
		temperature: number | null;
		toolChoice: string | null;
		cacheTtl: string | null;
	};
	runtime: {
		route: ReturnType<typeof resolveAgentRuntimeRoute>;
		image: string | null;
		daprAgentsPackageVersion: string | null;
		agentRuntimeNamespace: string | null;
	};
	source: {
		repositories: Record<string, SourceReference>;
		build: Record<string, string | null>;
	};
};

export type SourceReference = {
	repo?: string | null;
	branch?: string | null;
	commit?: string | null;
	dirty?: boolean | null;
	diffSha256?: string | null;
};

export type CompiledAgentApplicationState = {
	manifest: AgentApplicationStateManifest;
	daprMetadata: AgentMetadataBlob;
	promptManifest: AgentApplicationStateManifest["prompts"];
	toolManifest: AgentApplicationStateManifest["tools"];
	sourceManifest: AgentApplicationStateManifest["source"];
	canonicalJson: string;
	stateDigest: string;
};

export function compileAgentApplicationState(params: {
	agent: AgentApplicationStateAgentRow;
	version: AgentApplicationStateVersionRow;
}): CompiledAgentApplicationState {
	const config = params.version.config as unknown as AgentConfig;
	const detail = agentDetailFromRows(params.agent, params.version, config);
	const daprMetadata = {
		...buildAgentMetadata(detail, params.agent.projectId ?? "default"),
		// The registry writer uses wall-clock time, but the application-state
		// digest must represent executable state only.
		registered_at: "1970-01-01T00:00:00.000Z",
	};
	validateAgentMetadata(daprMetadata);

	const route = resolveAgentRuntimeRoute({
		agentSlug: params.agent.slug,
		runtimeAppId: params.agent.runtimeAppId ?? undefined,
		config,
	});
	const systemPromptSha256 = config.systemPrompt
		? sha256(config.systemPrompt)
		: null;
	const manifest: AgentApplicationStateManifest = {
		schemaVersion: "workflow-builder.agent-application-state.v1",
		agent: {
			id: params.agent.id,
			slug: params.agent.slug,
			name: params.agent.name,
			projectId: params.agent.projectId ?? null,
			versionId: params.version.id,
			version: params.version.version,
			configHash: params.version.configHash,
			runtime: params.agent.runtime,
			runtimeAppId: route.appId,
			environmentId: params.agent.environmentId ?? null,
			environmentVersion: params.agent.environmentVersion ?? null,
		},
		dapr: {
			metadata: daprMetadata,
			components: {
				registryStore: cleanString(env.DAPR_AGENT_REGISTRY_STORE) ?? "agent-registry",
				statestore: cleanString(env.DAPR_AGENT_STATESTORE) ?? "dapr-agent-py-statestore",
				pubsub: cleanString(env.DAPR_AGENT_PUBSUB) ?? null,
			},
		},
		prompts: {
			presetManifest: Array.isArray(config.promptPresetManifest)
				? config.promptPresetManifest
				: [],
			staticPresetRefs: Array.isArray(config.staticPromptPresetRefs)
				? config.staticPromptPresetRefs
				: [],
			dynamicPresetRefs: Array.isArray(config.dynamicPromptPresetRefs)
				? config.dynamicPromptPresetRefs
				: [],
			systemPromptSha256,
		},
		tools: {
			builtinTools: Array.isArray(config.builtinTools) ? config.builtinTools : [],
			toolNames: Array.isArray(config.tools) ? config.tools : [],
			mcpServers: Array.isArray(config.mcpServers) ? config.mcpServers : [],
			skills: Array.isArray(config.skills) ? config.skills : [],
			plugins: Array.isArray(config.plugins) ? config.plugins : [],
			callableAgents: Array.isArray(config.callableAgents)
				? config.callableAgents
				: [],
		},
		model: {
			modelSpec: cleanString(config.modelSpec) ?? null,
			provider: modelProvider(config.modelSpec),
			temperature:
				typeof config.temperature === "number" && Number.isFinite(config.temperature)
					? config.temperature
					: null,
			toolChoice: cleanString(config.toolChoice) ?? null,
			cacheTtl: cleanString(config.cacheTtl) ?? null,
		},
		runtime: {
			route,
			image: imageForRuntime(params.agent.runtime),
			daprAgentsPackageVersion:
				cleanString(env.DAPR_AGENTS_VERSION) ??
				cleanString(env.DAPR_AGENT_PY_DAPR_AGENTS_VERSION) ??
				null,
			agentRuntimeNamespace: cleanString(env.AGENT_RUNTIME_NAMESPACE) ?? "workflow-builder",
		},
		source: {
			repositories: sourceReferencesFromEnv(),
			build: {
				workflowBuilderGitSha:
					cleanString(env.GIT_SHA) ??
					cleanString(env.SOURCE_VERSION) ??
					cleanString(env.VERCEL_GIT_COMMIT_SHA) ??
					null,
				workflowBuilderBranch:
					cleanString(env.GIT_BRANCH) ??
					cleanString(env.VERCEL_GIT_COMMIT_REF) ??
					null,
				imageTag: cleanString(env.IMAGE_TAG) ?? cleanString(env.BUILD_IMAGE_TAG) ?? null,
			},
		},
	};
	const canonicalJson = stableJsonStringify(manifest);
	return {
		manifest,
		daprMetadata,
		promptManifest: manifest.prompts,
		toolManifest: manifest.tools,
		sourceManifest: manifest.source,
		canonicalJson,
		stateDigest: sha256(canonicalJson),
	};
}

export function stableJsonStringify(value: unknown): string {
	return JSON.stringify(toStableJson(value));
}

export function validateAgentMetadata(value: AgentMetadataBlob): void {
	if (!value.name?.trim()) throw new Error("Dapr agent metadata is missing name");
	if (!value.agent?.appid?.trim()) {
		throw new Error("Dapr agent metadata is missing agent.appid");
	}
	if (!value.agent?.type?.trim()) {
		throw new Error("Dapr agent metadata is missing agent.type");
	}
	// Framework must be a known runtime framework from the registry (e.g.
	// "Dapr Agents", "Claude Agent SDK", "Google ADK") — not hard-pinned to
	// "Dapr Agents", which mislabeled non-dapr runtimes.
	const knownFrameworks = new Set(listRuntimes().map((d) => d.agentMetadataFramework));
	if (!value.agent.framework?.trim() || !knownFrameworks.has(value.agent.framework)) {
		throw new Error(
			`Dapr agent metadata framework must be a known runtime framework (got "${value.agent.framework}")`,
		);
	}
	if (!Array.isArray(value.tools)) {
		throw new Error("Dapr agent metadata tools must be an array");
	}
}

function agentDetailFromRows(
	agent: AgentApplicationStateAgentRow,
	version: AgentApplicationStateVersionRow,
	config: AgentConfig,
): AgentDetail {
	return {
		id: agent.id,
		slug: agent.slug,
		name: agent.name,
		description: agent.description ?? null,
		avatar: agent.avatar ?? null,
		tags: Array.isArray(agent.tags) ? agent.tags : [],
		runtime: agent.runtime as AgentDetail["runtime"],
		currentVersion: version.version,
		currentConfigHash: version.configHash,
		modelSpec: config.modelSpec ?? null,
		environmentId: agent.environmentId ?? null,
		environmentVersion: agent.environmentVersion ?? null,
		defaultVaultIds: Array.isArray(agent.defaultVaultIds)
			? agent.defaultVaultIds
			: [],
		isArchived: agent.isArchived,
		registryStatus: agent.registryStatus as AgentDetail["registryStatus"],
		registrySyncedAt: agent.registrySyncedAt
			? dateToIso(agent.registrySyncedAt)
			: null,
		registryError: agent.registryError ?? null,
		createdAt: dateToIso(agent.createdAt),
		updatedAt: dateToIso(agent.updatedAt),
		config,
		sourceTemplateSlug: agent.sourceTemplateSlug ?? null,
		sourceTemplateVersion: agent.sourceTemplateVersion ?? null,
	};
}

function toStableJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => toStableJson(item));
	if (!value || typeof value !== "object") return value ?? null;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		const child = (value as Record<string, unknown>)[key];
		if (child !== undefined) out[key] = toStableJson(child);
	}
	return out;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function cleanString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function modelProvider(modelSpec: string | undefined): string | null {
	const value = cleanString(modelSpec);
	if (!value) return null;
	const slash = value.indexOf("/");
	return slash > 0 ? value.slice(0, slash) : null;
}

function imageForRuntime(runtime: string): string | null {
	if (runtime === "browser-use-agent") {
		return cleanString(env.AGENT_RUNTIME_BROWSER_USE_DEFAULT_IMAGE) ?? null;
	}
	if (runtime === "adk-agent-py") {
		return cleanString(env.AGENT_RUNTIME_ADK_DEFAULT_IMAGE) ?? null;
	}
	if (runtime === "claude-agent-py") {
		return cleanString(env.AGENT_RUNTIME_CLAUDE_DEFAULT_IMAGE) ?? null;
	}
	return (
		cleanString(env.AGENT_RUNTIME_DEFAULT_IMAGE) ??
		cleanString(env.CURRENT_DAPR_AGENT_PY_IMAGE) ??
		cleanString(env.DAPR_AGENT_PY_IMAGE) ??
		null
	);
}

function sourceReferencesFromEnv(): Record<string, SourceReference> {
	const parsed = parseSourceRefsJson(env.MLFLOW_SOURCE_REFS_JSON);
	const workflowBuilder: SourceReference = {
		repo: cleanString(env.WORKFLOW_BUILDER_REPO_URL) ?? null,
		branch:
			cleanString(env.GIT_BRANCH) ??
			cleanString(env.VERCEL_GIT_COMMIT_REF) ??
			null,
		commit:
			cleanString(env.GIT_SHA) ??
			cleanString(env.SOURCE_VERSION) ??
			cleanString(env.VERCEL_GIT_COMMIT_SHA) ??
			null,
		dirty: parseBoolean(env.GIT_DIRTY),
		diffSha256: cleanString(env.GIT_DIFF_SHA256) ?? null,
	};
	return {
		workflowBuilder,
		...parsed,
	};
}

function parseSourceRefsJson(value: unknown): Record<string, SourceReference> {
	if (typeof value !== "string" || !value.trim()) return {};
	try {
		const parsed = JSON.parse(value) as Record<string, SourceReference>;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed;
	} catch {
		return {};
	}
}

function parseBoolean(value: unknown): boolean | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes"].includes(normalized)) return true;
	if (["0", "false", "no"].includes(normalized)) return false;
	return null;
}

function dateToIso(value: unknown): string {
	return value instanceof Date
		? value.toISOString()
		: typeof value === "string" && value.trim()
			? value
			: "1970-01-01T00:00:00.000Z";
}
