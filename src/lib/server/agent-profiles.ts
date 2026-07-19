import type { AgentSkillConfig } from '$lib/agent-skill-presets';

export type McpServerProfileConfig = {
	server_name?: string;
	serverName?: string;
	name?: string;
	displayName?: string;
	sourceType?: string;
	pieceName?: string | null;
	serverKey?: string | null;
	registryRef?: string | null;
	mcpConnectionExternalId?: string | null;
	connectionExternalId?: string | null;
	transport?: string;
	url?: string;
	serverUrl?: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	allowedTools?: string[];
	headers?: Record<string, string>;
	timeout?: number;
	sse_read_timeout?: number;
	terminate_on_close?: boolean;
};

export type AgentRuntimeOverridePolicy = {
	allowToolNarrowing: boolean;
	allowServerAdditions: boolean;
	allowCredentialBinding: boolean;
	allowSkillAdditions: boolean;
	allowSkillNarrowing: boolean;
};

export type AgentProfileConfig = {
	modelSpec?: string;
	maxTurns?: number;
	timeoutMinutes?: number;
	builtinTools: string[];
	mcpConnectionMode: 'project' | 'explicit' | 'auto';
	mcpServers: McpServerProfileConfig[];
	skills: AgentSkillConfig[];
	runtimeOverridePolicy: AgentRuntimeOverridePolicy;
};

export type AgentProfileSummary = {
	id: string;
	templateId: string;
	slug: string;
	name: string;
	description: string | null;
	category: string | null;
	version: number;
	source: 'database' | 'builtin';
	config: AgentProfileConfig;
};

const DEFAULT_POLICY: AgentRuntimeOverridePolicy = {
	allowToolNarrowing: true,
	allowServerAdditions: false,
	allowCredentialBinding: true,
	allowSkillAdditions: false,
	allowSkillNarrowing: true
};

const DEFAULT_PROFILE_SKILLS: AgentSkillConfig[] = [];

const BROWSER_MCP_SERVERS: McpServerProfileConfig[] = [
	{
		server_name: 'playwright',
		displayName: 'Playwright',
		sourceType: 'preset',
		transport: 'stdio',
		command: 'npx',
		args: ['@playwright/mcp@latest']
	},
	{
		server_name: 'chrome_devtools',
		displayName: 'Chrome DevTools',
		sourceType: 'preset',
		transport: 'stdio',
		command: 'npx',
		args: ['chrome-devtools-mcp@latest']
	},
	{
		server_name: 'claude_in_chrome',
		displayName: 'Claude in Chrome',
		sourceType: 'preset',
		transport: 'stdio',
		command: 'claude',
		args: ['--claude-in-chrome-mcp']
	}
];

function builtinAgentProfiles(skills: AgentSkillConfig[] = DEFAULT_PROFILE_SKILLS): AgentProfileSummary[] {
	return [
	{
		id: 'builtin:default-sandbox-agent',
		templateId: 'builtin:default-sandbox-agent',
		slug: 'default-sandbox-agent',
		name: 'Default Sandbox Agent',
		description: 'Workspace tools only. Use this for ordinary sandbox-backed agent runs.',
		category: 'general',
		version: 1,
		source: 'builtin',
		config: {
			builtinTools: [
				'execute_command',
				'read_file',
				'write_file',
				'list_files',
				'edit_file',
				'glob_files',
				'grep_search'
			],
			mcpConnectionMode: 'explicit',
			mcpServers: [],
			skills,
			runtimeOverridePolicy: DEFAULT_POLICY
		}
	},
	{
		id: 'builtin:github-mcp-agent',
		templateId: 'builtin:github-mcp-agent',
		slug: 'github-mcp-agent',
		name: 'GitHub MCP Agent',
		description: 'GitHub MCP access narrowed to repository discovery and read operations.',
		category: 'mcp',
		version: 1,
		source: 'builtin',
		config: {
			builtinTools: [
				'execute_command',
				'read_file',
				'write_file',
				'list_files',
				'edit_file',
				'glob_files',
				'grep_search'
			],
			mcpConnectionMode: 'explicit',
			mcpServers: [
				{
					server_name: 'piece_github',
					displayName: 'GitHub',
					sourceType: 'nimble_piece',
					pieceName: 'github',
					transport: 'streamable_http',
					allowedTools: ['list_repositories', 'get_repository', 'search_repositories']
				}
			],
			skills,
			runtimeOverridePolicy: DEFAULT_POLICY
		}
	},
	{
		id: 'builtin:browser-testing-agent',
		templateId: 'builtin:browser-testing-agent',
		slug: 'browser-testing-agent',
		name: 'Browser Testing Agent',
		description: 'Browser automation MCP presets for validating generated web apps.',
		category: 'testing',
		version: 1,
		source: 'builtin',
		config: {
			builtinTools: [
				'execute_command',
				'read_file',
				'write_file',
				'list_files',
				'edit_file',
				'glob_files',
				'grep_search'
			],
			mcpConnectionMode: 'explicit',
			mcpServers: BROWSER_MCP_SERVERS,
			skills,
			runtimeOverridePolicy: DEFAULT_POLICY
		}
	},
	{
		id: 'builtin:full-testing-agent',
		templateId: 'builtin:full-testing-agent',
		slug: 'full-testing-agent',
		name: 'Full Testing Agent',
		description: 'Workspace tools plus browser MCP presets for end-to-end app demos.',
		category: 'testing',
		version: 1,
		source: 'builtin',
		config: {
			builtinTools: [
				'execute_command',
				'read_file',
				'write_file',
				'list_files',
				'edit_file',
				'glob_files',
				'grep_search'
			],
			mcpConnectionMode: 'explicit',
			mcpServers: BROWSER_MCP_SERVERS,
			skills,
			runtimeOverridePolicy: DEFAULT_POLICY
		}
	}
];
}

export const BUILTIN_AGENT_PROFILES: AgentProfileSummary[] = builtinAgentProfiles();

export function listBuiltInAgentProfiles(): AgentProfileSummary[] {
	return builtinAgentProfiles();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value !== 'string' || !value.trim()) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function runtimeOverridePolicy(value: unknown): AgentRuntimeOverridePolicy {
	const record = isRecord(value) ? value : {};
	return {
		allowToolNarrowing:
			typeof record.allowToolNarrowing === 'boolean'
				? record.allowToolNarrowing
				: DEFAULT_POLICY.allowToolNarrowing,
		allowServerAdditions:
			typeof record.allowServerAdditions === 'boolean'
				? record.allowServerAdditions
				: DEFAULT_POLICY.allowServerAdditions,
		allowCredentialBinding:
			typeof record.allowCredentialBinding === 'boolean'
				? record.allowCredentialBinding
				: DEFAULT_POLICY.allowCredentialBinding,
		allowSkillAdditions:
			typeof record.allowSkillAdditions === 'boolean'
				? record.allowSkillAdditions
				: DEFAULT_POLICY.allowSkillAdditions,
		allowSkillNarrowing:
			typeof record.allowSkillNarrowing === 'boolean'
				? record.allowSkillNarrowing
				: DEFAULT_POLICY.allowSkillNarrowing
	};
}

function normalizeSkillConfig(value: unknown): AgentSkillConfig | null {
	if (!isRecord(value)) return null;
	const name = String(value.name || '').trim();
	if (!name) return null;
	const description = typeof value.description === 'string' ? value.description : undefined;
	const whenToUse =
		typeof value.whenToUse === 'string'
			? value.whenToUse
			: typeof value.when_to_use === 'string'
				? value.when_to_use
				: undefined;
	const sourceType = value.sourceType === 'registry' ? 'registry' : 'profile';
	const registryId = typeof value.registryId === 'string' ? value.registryId : undefined;
	const slug = typeof value.slug === 'string' ? value.slug : undefined;
	const version = typeof value.version === 'string' ? value.version : undefined;
	const sourceRepo = typeof value.sourceRepo === 'string' ? value.sourceRepo : undefined;
	const sourceRef = typeof value.sourceRef === 'string' ? value.sourceRef : undefined;
	const skillPath = typeof value.skillPath === 'string' ? value.skillPath : undefined;
	const registryUrl = typeof value.registryUrl === 'string' ? value.registryUrl : undefined;
	const installSource =
		typeof value.installSource === 'string'
			? value.installSource
			: typeof value.sourceRepo === 'string'
				? value.sourceRepo
				: undefined;
	const skillName = typeof value.skillName === 'string' ? value.skillName : name;
	const installAgent = typeof value.installAgent === 'string' ? value.installAgent : 'universal';
	return {
		name,
		...(description ? { description } : {}),
		...(whenToUse ? { whenToUse } : {}),
		allowedTools: stringArray(value.allowedTools ?? value.allowed_tools),
		sourceType,
		...(registryId ? { registryId } : {}),
		...(slug ? { slug } : {}),
		...(version ? { version } : {}),
		...(sourceRepo ? { sourceRepo } : {}),
		...(sourceRef ? { sourceRef } : {}),
		...(skillPath ? { skillPath } : {}),
		...(registryUrl ? { registryUrl } : {}),
		...(installSource ? { installSource } : {}),
		skillName,
		installAgent
	};
}

function normalizeSkills(value: unknown): AgentSkillConfig[] {
	if (!Array.isArray(value)) return [];
	return value.map(normalizeSkillConfig).filter((item): item is AgentSkillConfig => Boolean(item));
}

export function normalizeAgentProfileConfig(input: {
	toolPolicy?: Record<string, unknown> | null;
	model?: Record<string, unknown> | null;
	execution?: Record<string, unknown> | null;
}): AgentProfileConfig {
	const toolPolicy = input.toolPolicy ?? {};
	const model = input.model ?? {};
	const execution = input.execution ?? {};
	const servers = Array.isArray(toolPolicy.mcpServers)
		? (toolPolicy.mcpServers.filter(isRecord) as McpServerProfileConfig[])
		: [];
	const skills = normalizeSkills(toolPolicy.skills);
	const mode = String(toolPolicy.mcpConnectionMode || 'auto').trim();
	return {
		modelSpec:
			typeof model.modelSpec === 'string'
				? model.modelSpec
				: typeof model.model === 'string'
					? model.model
					: undefined,
		maxTurns: numberValue(execution.maxTurns ?? execution.maxIterations),
		timeoutMinutes: numberValue(execution.timeoutMinutes),
		builtinTools: stringArray(toolPolicy.builtinTools ?? toolPolicy.tools),
		mcpConnectionMode: mode === 'project' || mode === 'explicit' ? mode : 'auto',
		mcpServers: servers,
		skills,
		runtimeOverridePolicy: runtimeOverridePolicy(toolPolicy.runtimeOverridePolicy)
	};
}
