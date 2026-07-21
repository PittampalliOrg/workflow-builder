import {
	AGENT_MODEL_OPTIONS,
	canonicalAgentModelSpec,
} from "$lib/agents/model-options";
import { resolveAgentConfigMcpForProject } from "$lib/server/agents/mcp-resolution-application";
import { getRuntimeDescriptor } from "$lib/server/agents/runtime-registry";
import {
	runtimeSupportsStructuredOutput,
	validateDraft202012ObjectSchema,
} from "$lib/server/application/structured-output";
import type { AgentSkillConfig } from "$lib/agent-skill-presets";
import type { McpServerProfileConfig } from "$lib/server/agent-profiles";
import type {
	RuntimeStructuredOutputCapability,
	SessionAgentConfigPatch,
	SessionCommandAgent,
} from "$lib/server/application/ports";
import type { AgentConfig } from "$lib/types/agents";
import type { SessionDetail } from "$lib/types/sessions";
import { raiseSessionEvent } from "./control";

export const SESSION_AGENT_CONFIG_PATCH_EVENT = "session.control.update_agent_config";

type PatchResult =
	| { ok: true; patch: SessionAgentConfigPatch }
	| { ok: false; status: number; error: string };

type SessionLookup = (sessionId: string) => Promise<SessionDetail | null>;
type SessionAgentLookup = (input: {
	agentId: string;
	agentVersion?: number | null;
}) => Promise<SessionCommandAgent | null>;
type RuntimeStructuredOutputCapabilityLookup = (
	runtimeId: string,
) => Promise<RuntimeStructuredOutputCapability | null>;

export type RaiseSessionAgentConfigPatchDependencies = Partial<{
	getSession: SessionLookup;
	resolveSessionAgent: SessionAgentLookup;
	getStructuredOutputCapability: RuntimeStructuredOutputCapabilityLookup;
}>;

async function getSessionViaWorkflowData(
	sessionId: string,
): Promise<SessionDetail | null> {
	const { getApplicationAdapters } = await import("$lib/server/application");
	return getApplicationAdapters().workflowData.getSessionDetail({ sessionId });
}

async function resolveSessionAgentViaWorkflowData(input: {
	agentId: string;
	agentVersion?: number | null;
}): Promise<SessionCommandAgent | null> {
	const { getApplicationAdapters } = await import("$lib/server/application");
	return getApplicationAdapters().workflowData.resolveSessionAgent(input);
}

async function getStructuredOutputCapabilityViaRegistry(runtimeId: string) {
	const { getApplicationAdapters } = await import("$lib/server/application");
	return getApplicationAdapters().runtimeRegistry.getStructuredOutputCapability(
		runtimeId,
	);
}

const defaultRaiseSessionAgentConfigPatchDependencies = {
	getSession: getSessionViaWorkflowData,
	resolveSessionAgent: resolveSessionAgentViaWorkflowData,
	getStructuredOutputCapability: getStructuredOutputCapabilityViaRegistry,
} satisfies Required<RaiseSessionAgentConfigPatchDependencies>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function stringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out = value.map((item) => String(item || "").trim()).filter(Boolean);
	return out;
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

const MCP_SERVER_KEYS = [
	"server_name",
	"serverName",
	"name",
	"displayName",
	"sourceType",
	"pieceName",
	"serverKey",
	"registryRef",
	"connectionExternalId",
	"transport",
	"url",
	"serverUrl",
	"command",
	"args",
	"cwd",
	"allowedTools",
	"timeout",
	"sse_read_timeout",
	"terminate_on_close",
] as const;

function mcpServers(value: unknown): McpServerProfileConfig[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const servers: McpServerProfileConfig[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const server: Record<string, unknown> = {};
		for (const key of MCP_SERVER_KEYS) {
			if (item[key] !== undefined) server[key] = item[key];
		}
		if (Object.keys(server).length > 0) {
			servers.push(server as McpServerProfileConfig);
		}
	}
	return servers;
}

function recordList<T>(value: unknown): T[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter(isRecord).map((item) => ({ ...item }) as T);
}

function rawPatch(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) return {};
	const nested = value.patch;
	if (isRecord(nested)) return nested;
	return value;
}

export function normalizeSessionAgentConfigPatch(value: unknown): PatchResult {
	const raw = rawPatch(value);
	const patch: SessionAgentConfigPatch = {};
	const hasStructuredOutputMode = "structuredOutputMode" in raw;
	const hasResponseJsonSchema = "responseJsonSchema" in raw;

	if (hasStructuredOutputMode || hasResponseJsonSchema) {
		if (
			hasStructuredOutputMode &&
			hasResponseJsonSchema &&
			raw.structuredOutputMode === null &&
			raw.responseJsonSchema === null
		) {
			patch.structuredOutputMode = null;
			patch.responseJsonSchema = null;
		} else if (
			raw.structuredOutputMode === null ||
			raw.responseJsonSchema === null
		) {
			return {
				ok: false,
				status: 400,
				error:
					"structuredOutputMode and responseJsonSchema must be cleared together",
			};
		} else if (!hasStructuredOutputMode || !hasResponseJsonSchema) {
			return {
				ok: false,
				status: 400,
				error:
					"structuredOutputMode and responseJsonSchema must be provided together",
			};
		} else if (raw.structuredOutputMode !== "tool") {
			return {
				ok: false,
				status: 400,
				error: "structuredOutputMode must be tool",
			};
		} else {
			const validation = validateDraft202012ObjectSchema(
				raw.responseJsonSchema,
			);
			if (!validation.ok) {
				return { ok: false, status: 400, error: validation.error };
			}
			patch.structuredOutputMode = "tool";
			patch.responseJsonSchema = validation.schema;
		}
	}

	if ("modelSpec" in raw) {
		const modelSpec = canonicalAgentModelSpec(stringValue(raw.modelSpec));
		if (!modelSpec) {
			return {
				ok: false,
				status: 400,
				error: `Unsupported modelSpec. Allowed: ${AGENT_MODEL_OPTIONS.map((m) => m.value).join(", ")}`,
			};
		}
		patch.modelSpec = modelSpec;
	}

	for (const key of ["role", "goal", "systemPrompt"] as const) {
		const value = stringValue(raw[key]);
		if (value) patch[key] = value;
	}

	for (const key of [
		"instructions",
		"styleGuidelines",
		"builtinTools",
		"tools",
		"allowedTools",
		"plugins",
	] as const) {
		if (key in raw) patch[key] = stringList(raw[key]) ?? [];
	}

	if ("toolChoice" in raw) {
		if (
			raw.toolChoice !== "auto" &&
			raw.toolChoice !== "required" &&
			raw.toolChoice !== "none"
		) {
			return {
				ok: false,
				status: 400,
				error: "toolChoice must be auto, required, or none",
			};
		}
		patch.toolChoice = raw.toolChoice;
	}

	if ("permissionMode" in raw) {
		if (raw.permissionMode !== "bypass" && raw.permissionMode !== "default") {
			return { ok: false, status: 400, error: "permissionMode must be bypass or default" };
		}
		patch.permissionMode = raw.permissionMode;
	}

	if ("mcpConnectionMode" in raw) {
		if (
			raw.mcpConnectionMode !== "project" &&
			raw.mcpConnectionMode !== "explicit" &&
			raw.mcpConnectionMode !== "auto"
		) {
			return {
				ok: false,
				status: 400,
				error: "mcpConnectionMode must be project, explicit, or auto",
			};
		}
		patch.mcpConnectionMode = raw.mcpConnectionMode;
	}

	if ("mcpServers" in raw) patch.mcpServers = mcpServers(raw.mcpServers) ?? [];
	if ("skills" in raw) patch.skills = recordList<AgentSkillConfig>(raw.skills) ?? [];

	for (const key of [
		"maxTurns",
		"maxIterations",
		"timeoutMinutes",
		"temperature",
	] as const) {
		const value = numberValue(raw[key]);
		if (value !== undefined) patch[key] = value;
	}

	if ("tools" in patch && !("allowedTools" in patch)) {
		patch.allowedTools = [...(patch.tools ?? [])];
	} else if (
		Array.isArray(patch.builtinTools) &&
		!("tools" in patch) &&
		!("allowedTools" in patch)
	) {
		patch.tools = [...patch.builtinTools];
		patch.allowedTools = [...patch.builtinTools];
	}

	if (Object.keys(patch).length === 0) {
		return { ok: false, status: 400, error: "No supported config patch fields provided" };
	}
	return { ok: true, patch };
}

async function resolveRuntimePatch(
	sessionId: string,
	patch: SessionAgentConfigPatch,
	dependencyOverrides: RaiseSessionAgentConfigPatchDependencies = {},
): Promise<PatchResult> {
	const needsMcpResolution =
		"mcpServers" in patch || "mcpConnectionMode" in patch;
	const needsStructuredOutputCapability =
		patch.structuredOutputMode === "tool";
	if (!needsMcpResolution && !needsStructuredOutputCapability) {
		return { ok: true, patch };
	}
	const deps: Required<RaiseSessionAgentConfigPatchDependencies> = {
		getSession:
			dependencyOverrides.getSession ??
			defaultRaiseSessionAgentConfigPatchDependencies.getSession,
		resolveSessionAgent:
			dependencyOverrides.resolveSessionAgent ??
			defaultRaiseSessionAgentConfigPatchDependencies.resolveSessionAgent,
		getStructuredOutputCapability:
			dependencyOverrides.getStructuredOutputCapability ??
			defaultRaiseSessionAgentConfigPatchDependencies.getStructuredOutputCapability,
	};
	const session = await deps.getSession(sessionId);
	if (!session) return { ok: false, status: 404, error: "Session not found" };
	const agent = await deps.resolveSessionAgent({
		agentId: session.agentId,
		agentVersion: session.agentVersion ?? undefined,
	});
	if (!agent) return { ok: false, status: 404, error: "Agent not found" };

	const mergedConfig = {
		...agent.config,
		...patch,
	};
	const runtimeId = mergedConfig.runtime ?? agent.runtime;
	if (needsStructuredOutputCapability) {
		const capability = await deps.getStructuredOutputCapability(runtimeId);
		if (!runtimeSupportsStructuredOutput(capability)) {
			return {
				ok: false,
				status: 400,
				error: `Runtime "${runtimeId}" does not support StructuredOutput with Draft 2020-12`,
			};
		}
	}
	if (!needsMcpResolution) return { ok: true, patch };

	const resolutionTarget = getRuntimeDescriptor(mergedConfig.runtime ?? agent.runtime);
	const resolved = await resolveAgentConfigMcpForProject(
		mergedConfig,
		agent.projectId,
		{
			autoIncludesProjectConnections:
				resolutionTarget?.cliAdapter !== "antigravity",
		},
	);
	return {
		ok: true,
		patch: {
			...patch,
			mcpServers: resolved.mcpServers,
			...(resolved.mcpConnectionWarnings
				? { mcpConnectionWarnings: resolved.mcpConnectionWarnings }
				: {}),
		},
	};
}

export async function raiseSessionAgentConfigPatch(
	sessionId: string,
	input: unknown,
	dependencyOverrides: RaiseSessionAgentConfigPatchDependencies = {},
): Promise<{
	ok: boolean;
	status: number;
	error?: string;
	patch?: SessionAgentConfigPatch;
}> {
	const normalized = normalizeSessionAgentConfigPatch(input);
	if (!normalized.ok) return normalized;

	const resolved = await resolveRuntimePatch(
		sessionId,
		normalized.patch,
		dependencyOverrides,
	);
	if (!resolved.ok) return resolved;

	const result = await raiseSessionEvent(sessionId, SESSION_AGENT_CONFIG_PATCH_EVENT, {
		patch: resolved.patch,
		applies: "next_turn",
	});
	return { ...result, patch: resolved.patch };
}
