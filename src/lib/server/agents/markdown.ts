import yaml from "js-yaml";
import type { AgentConfig, AgentRuntime } from "$lib/types/agents";
import { createDefaultAgentConfig } from "$lib/types/agents";

/**
 * Agent Markdown format (compatible with claude-code-src/.claude/agents/*.md
 * and the Anthropic CLI's agent YAML):
 *
 * ---
 * name: my-agent
 * description: ...
 * model: claude-opus-4-7
 * tools: [bash, read, write, glob, grep]
 * allowed_tools: [read, glob]
 * system: |
 *   You are a helpful coding agent. ...
 * instructions:
 *   - Think step by step.
 *   - Cite sources.
 * environment: env_default_sandbox
 * vaults:
 *   - vlt_abc
 * mcp_servers:
 *   - {name: github, url: "https://api.githubcopilot.com/mcp/"}
 * skills: [xlsx]
 * ---
 *
 * # Body (optional)
 *
 * Markdown body is appended to the system prompt as additional guidance.
 *
 * Round-trip is lossy only for fields we don't serialize (runtime-internal
 * caches, per-run overrides). The `config_hash` of import → export → import
 * is stable for the same source input.
 */

export type ParsedAgentMarkdown = {
	name: string;
	description?: string;
	config: AgentConfig;
	environmentRef?: string; // slug or id
	vaultRefs?: string[];
	runtime?: AgentRuntime;
};

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strArray(v: unknown): string[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out = v.map((x) => String(x ?? "").trim()).filter(Boolean);
	return out.length > 0 ? out : undefined;
}

export function parseAgentMarkdown(source: string): ParsedAgentMarkdown {
	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) {
		throw new Error(
			"Expected YAML frontmatter delimited by '---'. See /agents/[id] export for the shape.",
		);
	}
	const [, frontmatter, body] = match;
	const parsed = yaml.load(frontmatter);
	if (!isRecord(parsed)) {
		throw new Error("Frontmatter must be a YAML object.");
	}

	const name =
		typeof parsed.name === "string" && parsed.name.trim()
			? parsed.name.trim()
			: "imported-agent";
	const description =
		typeof parsed.description === "string" ? parsed.description : undefined;

	const defaults = createDefaultAgentConfig();
	const systemFromFrontmatter =
		typeof parsed.system === "string" ? parsed.system : undefined;
	const bodyTrimmed = body.trim();
	const systemPrompt =
		systemFromFrontmatter && bodyTrimmed
			? `${systemFromFrontmatter}\n\n${bodyTrimmed}`
			: systemFromFrontmatter ?? (bodyTrimmed || undefined);

	const runtime: AgentRuntime =
		parsed.runtime === "dapr-agent-py-testing"
			? "dapr-agent-py-testing"
			: parsed.runtime === "adk-agent-py"
				? "adk-agent-py"
				: parsed.runtime === "browser-use-agent"
					? "browser-use-agent"
					: "dapr-agent-py";

	const toolChoice =
		parsed.tool_choice === "auto" ||
		parsed.tool_choice === "required" ||
		parsed.tool_choice === "none"
			? parsed.tool_choice
			: undefined;

	const builtinTools =
		strArray(parsed.tools) ??
		strArray((parsed as Record<string, unknown>).builtin_tools) ??
		defaults.builtinTools;
	const allowedTools = strArray(parsed.allowed_tools);

	const mcpServers = Array.isArray(parsed.mcp_servers)
		? (parsed.mcp_servers as AgentConfig["mcpServers"])
		: [];
	const skills = Array.isArray(parsed.skills)
		? parsed.skills.map((s) =>
				typeof s === "string" ? { name: s } : (s as Record<string, unknown>),
			)
		: [];

	const config: AgentConfig = {
		...defaults,
		systemPrompt,
		modelSpec: typeof parsed.model === "string" ? parsed.model : undefined,
		temperature:
			typeof parsed.temperature === "number" ? parsed.temperature : undefined,
		toolChoice,
		maxTurns:
			typeof parsed.max_turns === "number" ? parsed.max_turns : defaults.maxTurns,
		timeoutMinutes:
			typeof parsed.timeout_minutes === "number"
				? parsed.timeout_minutes
				: defaults.timeoutMinutes,
		builtinTools,
		tools: allowedTools,
		mcpConnectionMode:
			parsed.mcp_connection_mode === "project" ||
			parsed.mcp_connection_mode === "auto" ||
			parsed.mcp_connection_mode === "explicit"
				? parsed.mcp_connection_mode
				: defaults.mcpConnectionMode,
		mcpServers: mcpServers as AgentConfig["mcpServers"],
		skills: skills as AgentConfig["skills"],
		runtime,
		runtimeOverridePolicy: defaults.runtimeOverridePolicy,
	};

	const environmentRef =
		typeof parsed.environment === "string"
			? parsed.environment
			: isRecord(parsed.environment) && typeof parsed.environment.id === "string"
				? (parsed.environment.id as string)
				: undefined;

	const vaultRefs = strArray(parsed.vaults);

	return { name, description, config, environmentRef, vaultRefs, runtime };
}

export type SerializeInput = {
	name: string;
	description?: string | null;
	config: AgentConfig;
	environmentSlugOrId?: string | null;
	vaultIds?: string[];
};

export function serializeAgentMarkdown(input: SerializeInput): string {
	const c = input.config;
	const frontmatter: Record<string, unknown> = {
		name: input.name,
	};
	if (input.description) frontmatter.description = input.description;
	if (c.modelSpec) frontmatter.model = c.modelSpec;
	if (c.temperature !== undefined) frontmatter.temperature = c.temperature;
	if (c.toolChoice) frontmatter.tool_choice = c.toolChoice;
	if (c.maxTurns) frontmatter.max_turns = c.maxTurns;
	if (c.timeoutMinutes) frontmatter.timeout_minutes = c.timeoutMinutes;
	if (c.builtinTools && c.builtinTools.length > 0) {
		frontmatter.tools = c.builtinTools;
	}
	if (c.tools && c.tools.length > 0) {
		frontmatter.allowed_tools = c.tools;
	}
	frontmatter.mcp_connection_mode = c.mcpConnectionMode;
	if (c.mcpServers && c.mcpServers.length > 0) {
		frontmatter.mcp_servers = c.mcpServers;
	}
	if (c.skills && c.skills.length > 0) {
		frontmatter.skills = c.skills;
	}
	if (c.runtime && c.runtime !== "dapr-agent-py") {
		frontmatter.runtime = c.runtime;
	}
	if (input.environmentSlugOrId) {
		frontmatter.environment = input.environmentSlugOrId;
	}
	if (input.vaultIds && input.vaultIds.length > 0) {
		frontmatter.vaults = input.vaultIds;
	}

	const yamlText = yaml.dump(frontmatter, { lineWidth: 120 }).trimEnd();
	const systemBody = c.systemPrompt ? `\n\n${c.systemPrompt}\n` : "";
	return `---\n${yamlText}\n---\n${systemBody}`;
}
