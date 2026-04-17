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

	runtime: AgentRuntime;
	runtimeOverridePolicy: AgentRuntimeOverridePolicy;

	configuration?: AgentHotReloadConfig;
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
	createdAt: string;
	updatedAt: string;
};

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
