import type { AgentSkillConfig } from "$lib/agent-skill-presets";
import type {
	AgentRuntimeOverridePolicy,
	McpServerProfileConfig,
} from "$lib/server/agent-profiles";

/**
 * Loose sandbox-policy shape used for per-node overrides. The authoritative
 * sandbox config lives on an Environment; overrides only tweak it per-node.
 */
export type SandboxPolicyOverride = Record<string, unknown>;

export type AgentRuntime = "dapr-agent-py" | "dapr-agent-py-testing";

export type AgentMemoryConfig = {
	backend?: "dapr_state" | "conversation_list" | "none";
	sessionId?: string;
	storeName?: string;
};

export type AgentToolChoice = "auto" | "required" | "none";

export type AgentHookCommand = {
	type: "command";
	command: string;
	if?: string;
	timeout?: number;
};

export type AgentHookCallback = {
	type: "callback";
	callback: string;
	if?: string;
};

export type AgentHookDefinition = AgentHookCommand | AgentHookCallback;

export type AgentHookMatcher = {
	matcher?: string;
	hooks: AgentHookDefinition[];
};

export type AgentHooksConfig = Record<string, AgentHookMatcher[]>;

export type AgentHotReloadConfig = {
	storeName?: string;
	configName?: string;
	keys?: string[];
};

export type AgentConfig = {
	role?: string;
	goal?: string;
	instructions?: string[];
	systemPrompt?: string;
	styleGuidelines?: string[];

	modelSpec?: string;
	temperature?: number;
	toolChoice?: AgentToolChoice;

	maxTurns?: number;
	timeoutMinutes?: number;
	cwd?: string;

	builtinTools: string[];
	tools?: string[];
	mcpConnectionMode: "project" | "explicit" | "auto";
	mcpServers: McpServerProfileConfig[];
	skills: AgentSkillConfig[];
	hooks?: AgentHooksConfig;
	plugins?: string[];

	memory?: AgentMemoryConfig;
	sandboxPolicy?: SandboxPolicyOverride;

	/**
	 * Peer agents this agent is allowed to invoke via Dapr Agents'
	 * `call_agent()` primitive. Slugs scoped to the same workspace
	 * (`projectId`). The runtime resolves each slug against the Dapr
	 * agent registry at workflow start; slugs whose target is not
	 * currently `registered` are silently dropped so a stale peer
	 * doesn't hang the parent.
	 *
	 * Empty / unset = `call_agent` tool is not exposed to the LLM.
	 * This is a Phase-2 addition on top of the registry dual-write —
	 * the UI surface is a multi-select picker on the agent-detail
	 * Capabilities tab (filtered to peers with `registryStatus = 'registered'`).
	 */
	callableAgents?: string[];

	runtime: AgentRuntime;
	runtimeOverridePolicy: AgentRuntimeOverridePolicy;

	configuration?: AgentHotReloadConfig;
};

/**
 * Resolved representation of a callable-agent link, emitted by the
 * workflow resolver into `durable/run.with.body.callableAgents` so the
 * runtime can invoke by `slug` without re-hitting the Dapr state store.
 */
export type ResolvedCallableAgent = {
	slug: string;
	agentId: string;
	version: number;
	appId: string;
	team: string;
	registryKey: string;
};

export type AgentRef = {
	id: string;
	version?: number;
};

export type AgentSummary = {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	avatar: string | null;
	tags: string[];
	runtime: AgentRuntime;
	currentVersion: number | null;
	modelSpec: string | null;
	environmentId: string | null;
	environmentVersion: number | null;
	defaultVaultIds: string[];
	usedByCount?: number;
	isArchived: boolean;
	/**
	 * Dual-write registry sync state. Mirrors `agents.registry_*` columns.
	 * Postgres remains source of truth; these fields describe the Dapr
	 * registry's view of this agent. `unregistered` is the default for any
	 * agent that hasn't been published since the dual-write feature flag
	 * was enabled.
	 */
	registryStatus: AgentRegistryStatus;
	registrySyncedAt: string | null;
	registryError: string | null;
	createdAt: string;
	updatedAt: string;
};

export type AgentRegistryStatus =
	| "unregistered"
	| "registered"
	| "failed"
	| "archiving"
	| "archived";

export type AgentDetail = AgentSummary & {
	config: AgentConfig;
	sourceTemplateSlug: string | null;
	sourceTemplateVersion: number | null;
};

export type AgentVersionSummary = {
	id: string;
	agentId: string;
	version: number;
	configHash: string;
	changelog: string | null;
	publishedAt: string | null;
	publishedBy: string | null;
	createdAt: string;
};

export type AgentOverrides = {
	sandboxPolicy?: SandboxPolicyOverride;
	tools?: string[];
	maxTurns?: number;
	timeoutMinutes?: number;
	cwd?: string;
};

export type AgentTaskRef = {
	agentRef: AgentRef;
	prompt: string;
	overrides?: AgentOverrides;
};

export const DEFAULT_AGENT_RUNTIME_OVERRIDE_POLICY: AgentRuntimeOverridePolicy = {
	allowToolNarrowing: true,
	allowServerAdditions: false,
	allowCredentialBinding: true,
	allowSkillAdditions: false,
	allowSkillNarrowing: true,
};

export const DEFAULT_BUILTIN_TOOLS = [
	"execute_command",
	"read_file",
	"write_file",
	"list_files",
	"edit_file",
];

export function createDefaultAgentConfig(): AgentConfig {
	return {
		builtinTools: [...DEFAULT_BUILTIN_TOOLS],
		mcpConnectionMode: "explicit",
		mcpServers: [],
		skills: [],
		runtime: "dapr-agent-py",
		runtimeOverridePolicy: { ...DEFAULT_AGENT_RUNTIME_OVERRIDE_POLICY },
		memory: { backend: "dapr_state" },
		maxTurns: 120,
		timeoutMinutes: 120,
	};
}

// webhook-retest: 1776537560
// validation-1776537745
// debug-test-1776538093
// final-validation-1776538168
// post-restart-1776538357
