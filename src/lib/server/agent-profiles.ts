import { asc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	agentExecutionFacetVersions,
	agentModelFacetVersions,
	agentProfileTemplateVersions,
	agentProfileTemplates,
	agentToolPolicyFacetVersions
} from '$lib/server/db/schema';
import {
	DEFAULT_CURATED_AGENT_SKILLS,
	profileSkillSnapshot,
	type AgentSkillConfig
} from '$lib/agent-skill-presets';
import { listAgentSkills } from '$lib/server/agent-skills';

export type McpServerProfileConfig = {
	server_name?: string;
	serverName?: string;
	name?: string;
	displayName?: string;
	sourceType?: string;
	pieceName?: string | null;
	serverKey?: string | null;
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

const DEFAULT_PROFILE_SKILLS = DEFAULT_CURATED_AGENT_SKILLS.map(profileSkillSnapshot);

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
			builtinTools: ['execute_command', 'read_file', 'write_file', 'list_files', 'edit_file'],
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
			builtinTools: ['execute_command', 'read_file', 'write_file', 'list_files', 'edit_file'],
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
			builtinTools: ['execute_command', 'read_file', 'write_file', 'list_files', 'edit_file'],
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
			builtinTools: ['execute_command', 'read_file', 'write_file', 'list_files', 'edit_file'],
			mcpConnectionMode: 'explicit',
			mcpServers: BROWSER_MCP_SERVERS,
			skills,
			runtimeOverridePolicy: DEFAULT_POLICY
		}
	}
];
}

export const BUILTIN_AGENT_PROFILES: AgentProfileSummary[] = builtinAgentProfiles();

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
	const prompt = String(value.prompt || '').trim();
	if (!name || !prompt) return null;
	const description = typeof value.description === 'string' ? value.description : undefined;
	const whenToUse =
		typeof value.whenToUse === 'string'
			? value.whenToUse
			: typeof value.when_to_use === 'string'
				? value.when_to_use
				: undefined;
	const argumentHint =
		typeof value.argumentHint === 'string'
			? value.argumentHint
			: typeof value.argument_hint === 'string'
				? value.argument_hint
				: undefined;
	const model = typeof value.model === 'string' ? value.model : undefined;
	const sourceType =
		value.sourceType === 'profile' ||
		value.sourceType === 'inline' ||
		value.sourceType === 'preset' ||
		value.sourceType === 'registry' ||
		value.sourceType === 'curated' ||
		value.sourceType === 'imported' ||
		value.sourceType === 'builtin'
			? value.sourceType
			: 'profile';
	const registryId = typeof value.registryId === 'string' ? value.registryId : undefined;
	const slug = typeof value.slug === 'string' ? value.slug : undefined;
	const version = typeof value.version === 'string' ? value.version : undefined;
	const contentHash = typeof value.contentHash === 'string' ? value.contentHash : undefined;
	const sourceRepo = typeof value.sourceRepo === 'string' ? value.sourceRepo : undefined;
	const sourceRef = typeof value.sourceRef === 'string' ? value.sourceRef : undefined;
	const skillPath = typeof value.skillPath === 'string' ? value.skillPath : undefined;
	const license = typeof value.license === 'string' ? value.license : undefined;
	const compatibility = isRecord(value.compatibility) ? value.compatibility : undefined;
	const packageManifest = isRecord(value.packageManifest) ? value.packageManifest : undefined;
	return {
		name,
		...(description ? { description } : {}),
		prompt,
		...(whenToUse ? { whenToUse } : {}),
		allowedTools: stringArray(value.allowedTools ?? value.allowed_tools),
		arguments: stringArray(value.arguments),
		...(argumentHint ? { argumentHint } : {}),
		...(model ? { model } : {}),
		userInvocable:
			typeof value.userInvocable === 'boolean'
				? value.userInvocable
				: typeof value.user_invocable === 'boolean'
					? value.user_invocable
					: true,
		disableModelInvocation:
			typeof value.disableModelInvocation === 'boolean'
				? value.disableModelInvocation
				: typeof value.disable_model_invocation === 'boolean'
					? value.disable_model_invocation
					: false,
		sourceType,
		...(registryId ? { registryId } : {}),
		...(slug ? { slug } : {}),
		...(version ? { version } : {}),
		...(contentHash ? { contentHash } : {}),
		...(sourceRepo ? { sourceRepo } : {}),
		...(sourceRef ? { sourceRef } : {}),
		...(skillPath ? { skillPath } : {}),
		...(license ? { license } : {}),
		...(compatibility ? { compatibility } : {}),
		...(packageManifest ? { packageManifest } : {})
	};
}

function normalizeSkills(value: unknown): AgentSkillConfig[] {
	if (!Array.isArray(value)) return [];
	return value.map(normalizeSkillConfig).filter((item): item is AgentSkillConfig => Boolean(item));
}

function normalizeConfig(input: {
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
	const mode = String(toolPolicy.mcpConnectionMode || 'explicit').trim();
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
		mcpConnectionMode: mode === 'project' || mode === 'auto' ? mode : 'explicit',
		mcpServers: servers,
		skills,
		runtimeOverridePolicy: runtimeOverridePolicy(toolPolicy.runtimeOverridePolicy)
	};
}

export async function listAgentProfiles(): Promise<AgentProfileSummary[]> {
	const registrySkills = (await listAgentSkills()).map(profileSkillSnapshot);
	const builtInProfiles = builtinAgentProfiles(registrySkills);
	if (!db) return builtInProfiles;
	try {
		const rows = await db
			.select({
				templateId: agentProfileTemplates.id,
				slug: agentProfileTemplates.slug,
				name: agentProfileTemplates.name,
				description: agentProfileTemplates.description,
				category: agentProfileTemplates.category,
				version: agentProfileTemplateVersions.version,
				isDefaultVersion: agentProfileTemplateVersions.isDefault,
				toolPolicy: agentToolPolicyFacetVersions.config,
				model: agentModelFacetVersions.config,
				execution: agentExecutionFacetVersions.config
			})
			.from(agentProfileTemplates)
			.leftJoin(
				agentProfileTemplateVersions,
				eq(agentProfileTemplateVersions.templateId, agentProfileTemplates.id)
			)
			.leftJoin(
				agentToolPolicyFacetVersions,
				eq(
					agentToolPolicyFacetVersions.id,
					agentProfileTemplateVersions.toolPolicyFacetVersionId
				)
			)
			.leftJoin(
				agentModelFacetVersions,
				eq(agentModelFacetVersions.id, agentProfileTemplateVersions.modelFacetVersionId)
			)
			.leftJoin(
				agentExecutionFacetVersions,
				eq(agentExecutionFacetVersions.id, agentProfileTemplateVersions.executionFacetVersionId)
			)
			.where(eq(agentProfileTemplates.isEnabled, true))
			.orderBy(asc(agentProfileTemplates.sortOrder), asc(agentProfileTemplates.name));

		const byTemplate = new Map<string, (typeof rows)[number]>();
		for (const row of rows) {
			const existing = byTemplate.get(row.templateId);
			if (
				!existing ||
				row.isDefaultVersion ||
				(!existing.isDefaultVersion && (row.version ?? 0) > (existing.version ?? 0))
			) {
				byTemplate.set(row.templateId, row);
			}
		}

		const dbProfiles = [...byTemplate.values()].map((row) => ({
			id: row.templateId,
			templateId: row.templateId,
			slug: row.slug,
			name: row.name,
			description: row.description,
			category: row.category,
			version: row.version ?? 1,
			source: 'database' as const,
			config: normalizeConfig({
				toolPolicy: row.toolPolicy,
				model: row.model,
				execution: row.execution
			})
		}));

		const merged = new Map<string, AgentProfileSummary>();
		for (const profile of builtInProfiles) {
			merged.set(profile.slug, profile);
		}
		for (const profile of dbProfiles) {
			merged.set(profile.slug, profile);
		}
		return [...merged.values()];
	} catch (err) {
		console.warn('[agent-profiles] Failed loading DB profiles, using built-ins:', err);
		return builtInProfiles;
	}
}
