import type { AgentSkillConfig } from "$lib/agent-skill-presets";
import type {
	AgentRuntimeOverridePolicy,
	McpServerProfileConfig,
} from "$lib/server/agent-profiles";
import type { SessionRepositoryInput } from "$lib/types/sessions";

/**
 * Loose sandbox-policy shape used for per-node overrides. The authoritative
 * sandbox config lives on an Environment; overrides only tweak it per-node.
 */
export type SandboxPolicyOverride = Record<string, unknown>;

/**
 * Version-pinned reference to a Prompt Workbench preset (`resourcePromptVersions` row).
 * Used in `AgentConfig.staticPromptPresetRefs` and `dynamicPromptPresetRefs`.
 */
export type PromptPresetRef = {
	id: string;
	version: number;
};

export type AgentRuntime =
	| "dapr-agent-py"
	| "dapr-agent-py-testing"
	| "adk-agent-py"
	| "claude-agent-py"
	| "claude-code-cli"
	| "codex-cli"
	| "agy-cli"
	| "browser-use-agent";

export type AgentRuntimeIsolation = "auto" | "shared" | "dedicated";

export type AgentRuntimePoolBinding = {
	appId?: string;
	runtimeClass?: string;
	idleTtlSeconds?: number;
	minReplicas?: number;
	maxReplicas?: number;
	slotsPerReplica?: number;
	maxActiveSessions?: number;
};

export type AgentMemoryConfig = {
	backend?: "dapr_state" | "conversation_list" | "none";
	sessionId?: string;
	storeName?: string;
};

export type AgentBrowserArtifactsConfig = {
	screenshots?: boolean;
	video?: boolean;
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
	/**
	 * The agent's voice — one canonical persona block. Plain text or markdown,
	 * no special structure required. Mirrors CMA's `system` field exactly. For
	 * cross-agent reusable content, bind Prompt Workbench presets via
	 * `staticPromptPresetRefs` / `dynamicPromptPresetRefs` instead of
	 * duplicating here. Mid-session patchable via
	 * `session.control.update_agent_config`.
	 */
	systemPrompt?: string;

	/**
	 * Version-pinned references to Prompt Workbench preset versions whose system
	 * text gets rendered into the static prefix BEFORE persona. Resolved by the
	 * BFF at session-spawn time via `compilePromptStack()` and stamped onto
	 * `compiledStaticPresetSections`. Pinning is intentional: republishing the
	 * agent re-pins to whatever version was current at publish time, so two runs
	 * of the same agent at different times produce the same prompt.
	 */
	staticPromptPresetRefs?: PromptPresetRef[];

	/**
	 * Version-pinned preset references rendered into the dynamic tail BEFORE
	 * Runtime Context. Same shape + resolution model as `staticPromptPresetRefs`.
	 * The same preset can legitimately be a static block for one agent and a
	 * dynamic block for another — kind lives on the binding (which array), not
	 * on the preset row.
	 */
	dynamicPromptPresetRefs?: PromptPresetRef[];

	/**
	 * Resolved preset content stamped by the BFF at session-spawn time after
	 * `compilePromptStack()` resolves `staticPromptPresetRefs`. Runtime-only
	 * (not persisted on `agentVersions.config`) — agentConfig snapshots take it
	 * along the wire to dapr-agent-py so the Python side never needs DB access.
	 */
	compiledStaticPresetSections?: string[];

	/**
	 * Resolved preset content stamped by the BFF at session-spawn time after
	 * `compilePromptStack()` resolves `dynamicPromptPresetRefs`. Runtime-only.
	 */
	compiledDynamicPresetSections?: string[];

	/**
	 * Phase 3a v2: per-ref manifest mirroring `compiledStaticPresetSections` +
	 * `compiledDynamicPresetSections`. Each entry carries the
	 * `resource_prompt_versions.id` (PK) and `mlflow_uri` so dapr-agent-py can
	 * stamp `tag.prompt_version_id` / `tag.prompt_version` on agent traces
	 * without needing DB access. Empty array when no presets are bound.
	 */
	promptPresetManifest?: Array<{
		promptId: string;
		version: number;
		promptVersionId: string;
		mlflowUri: string | null;
	}>;

	modelSpec?: string;

	/**
	 * Fallback model spec for the claude-code-cli adapter — passed as
	 * `--fallback-model` and used when the primary model is overloaded. Normalized
	 * the same way as `modelSpec` (an `anthropic/` prefix is stripped). Claude Code
	 * only; the codex / agy adapters ignore it.
	 */
	fallbackModelSpec?: string;

	/**
	 * Unified reasoning-effort selector for the interactive-cli runtimes. Each CLI
	 * adapter maps it to its own native control (see the adapters under
	 * `services/cli-agent-py/src/cli_adapters/`):
	 *  - claude-code-cli: `low|medium|high|xhigh` → `--effort <v>`; `max` → the
	 *    session-only `CLAUDE_CODE_EFFORT_LEVEL=max` pane env; `ultracode` →
	 *    `--settings '{"ultracode": true}'` (ultracode is a Claude Code setting, not
	 *    an effort level, so it is NOT combined with `--effort`).
	 *  - codex-cli: `low|medium|high` via `-c model_reasoning_effort=<v>`
	 *    (`xhigh|max|ultracode` clamp to `high`).
	 *  - agy-cli: no native reasoning/effort control on the pinned version → a
	 *    documented no-op.
	 * Absent → each CLI's own default effort (current behavior).
	 */
	effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultracode";

	/**
	 * codex-cli only: reasoning-summary verbosity, passed as
	 * `-c model_reasoning_summary=<v>`. Ignored by the other adapters.
	 */
	codexReasoningSummary?: "auto" | "concise" | "detailed" | "none";

	/** codex-cli only: enable codex's web-search tool via the `--search` flag. */
	codexWebSearch?: boolean;

	temperature?: number;
	toolChoice?: AgentToolChoice;

	/**
	 * Anthropic ephemeral prompt cache TTL applied to the static prefix +
	 * tools cache breakpoints. Default `'5m'` matches the SDK default; `'1h'`
	 * is opt-in via Anthropic's extended-cache beta and is the right choice
	 * for long-running Dapr durable agents whose sessions span >5 min between
	 * turns (benchmark loops, multi-step workflows, agents that yield on
	 * `ctx.create_timer`). When `'5m'` (or absent), the cached prefix expires
	 * between long pauses and the next call re-pays full input tokens; `'1h'`
	 * keeps the prefix warm across pod scale events and turn gaps.
	 */
	cacheTtl?: "5m" | "1h";

	maxTurns?: number;
	timeoutMinutes?: number;
	cwd?: string;
	permissionMode?:
		| "default"
		| "acceptEdits"
		| "plan"
		| "bypassPermissions"
		| "bypass"
		| "dontAsk"
		| "auto";

	builtinTools: string[];
	tools?: string[];
	mcpConnectionMode: "project" | "explicit" | "auto";
	mcpServers: McpServerProfileConfig[];
	mcpConnectionWarnings?: string[];
	skills: AgentSkillConfig[];
	hooks?: AgentHooksConfig;
	plugins?: string[];

	/**
	 * Reusable capability-bundle references (Pillar 2). Each ref pins a
	 * `capability_bundles` row, optionally to a specific version (latest when
	 * `version` is omitted). `flattenBundles()` merges each referenced bundle's
	 * mcpServers / skills / tools / hooks / plugins / prompt presets into THIS
	 * config before MCP resolution, with this config's own entries winning on
	 * key collision. Empty / unset = no bundles applied.
	 */
	bundleRefs?: BundleRef[];

	memory?: AgentMemoryConfig;
	browserArtifacts?: AgentBrowserArtifactsConfig;
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

	/**
	 * GitHub repositories cloned into this agent's sandbox before its first
	 * turn. A repo-specialized agent ("fix bugs in repo X") carries its repos
	 * here. Materialized into `session_resources` at session spawn for BOTH
	 * direct sessions (session-create) and workflow `durable/run` steps that
	 * reference this agent (the bridge forwards `agentConfig`, so no
	 * orchestrator change is needed). Private repos reference a vault
		 * credential via `authTokenCredentialId`. See
		 * `src/lib/server/application/adapters/session-repositories.ts`.
	 */
	repositories?: SessionRepositoryInput[];

	runtime: AgentRuntime;
	/**
	 * Runtime-only selector for interactive-cli hosts. The BFF stamps this from
	 * the runtime registry descriptor before dispatch; stored agent rows remain
	 * valid when this is absent.
	 */
	cliAdapter?: "claude-code" | "codex" | "antigravity";
	/**
	 * Runtime-class placement metadata. The default class is derived from
	 * `runtime`; non-browser `dapr-agent-py` agents can share a class pool
	 * because per-session childInput carries the agent-specific config.
	 */
	runtimeClass?: string;
	runtimeIsolation?: AgentRuntimeIsolation;
	runtimePool?: AgentRuntimePoolBinding;
	runtimeOverridePolicy: AgentRuntimeOverridePolicy;

	configuration?: AgentHotReloadConfig;
};

/** A pinned reference to a reusable capability bundle (see `AgentConfig.bundleRefs`). */
export type BundleRef = {
	id: string;
	/** Bundle version to pin; resolves to the latest published version when omitted. */
	version?: number;
};

/**
 * The capability subset a capability bundle carries — a partial `AgentConfig`
 * limited to the reusable, mergeable surfaces. `flattenBundles()` unions each
 * field into the effective config (bundle entries form the base; the agent /
 * session / node config wins on key collision).
 */
export type CapabilityBundleConfig = {
	mcpServers?: McpServerProfileConfig[];
	skills?: AgentSkillConfig[];
	tools?: string[];
	builtinTools?: string[];
	hooks?: AgentHooksConfig;
	plugins?: string[];
	staticPromptPresetRefs?: PromptPresetRef[];
	dynamicPromptPresetRefs?: PromptPresetRef[];
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
	currentConfigHash: string | null;
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
	applicationStateDigest?: string | null;
	mlflowUri?: string | null;
	mlflowModelName?: string | null;
	mlflowModelVersion?: string | null;
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
	/**
	 * Additional capability bundles attached at the node/session level, layered
	 * ON TOP of the agent's own `bundleRefs` (flattened by the resolver after the
	 * agent's bundles). Node entries add capabilities the agent doesn't already
	 * carry; the agent's own config still wins on key collision.
	 */
	bundleRefs?: BundleRef[];
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
		mcpConnectionMode: "auto",
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
