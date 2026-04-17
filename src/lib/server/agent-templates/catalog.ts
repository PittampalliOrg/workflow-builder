import type { AgentConfig } from "$lib/types/agents";
import type { McpServerProfileConfig } from "$lib/server/agent-profiles";
import { createDefaultAgentConfig } from "$lib/types/agents";

/**
 * Template gallery for the Quickstart wizard. Mirrors the CMA templates
 * observed on platform.claude.com: Blank, Deep researcher, Structured
 * extractor, Field monitor (Notion), Support agent (Notion + Slack),
 * Incident commander (Sentry + Linear + Slack + GitHub), Feedback miner
 * (Slack + Notion + Asana), Sprint retro facilitator (Linear + Slack),
 * Support-to-eng escalator (Intercom + Atlassian + Slack), Data analyst.
 *
 * Each template is a pre-shaped AgentConfig + an optional set of suggested
 * MCP servers. The user picks a template, the wizard creates the agent,
 * and the user attaches vault credentials + environment afterwards.
 *
 * `providerIcons` keys are AP piece slugs — we already render these icons
 * in connections/+page.svelte so the wizard can reuse them.
 */

export type AgentTemplate = {
	slug: string;
	name: string;
	description: string;
	providerIcons: string[];
	highlights: string[];
	suggestedMcpServers?: McpServerProfileConfig[];
	config: AgentConfig;
};

function base(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return { ...createDefaultAgentConfig(), ...overrides };
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
	{
		slug: "blank",
		name: "Blank agent config",
		description: "A blank starting point with the core toolset.",
		providerIcons: [],
		highlights: ["Workspace tools", "No MCP servers", "Default sandbox"],
		config: base({
			role: "Autonomous assistant",
			goal: "Help the user accomplish arbitrary tasks.",
			systemPrompt:
				"You are a helpful autonomous agent. Break work into steps, take safe actions, and explain trade-offs.",
		}),
	},
	{
		slug: "deep-researcher",
		name: "Deep researcher",
		description:
			"Conducts multi-step web research with source synthesis and citations.",
		providerIcons: [],
		highlights: [
			"web_search + web_fetch built-in tools",
			"Citation-heavy output",
			"Long-form synthesis",
		],
		config: base({
			role: "Research analyst",
			goal: "Plan queries, gather diverse sources, synthesize findings with citations.",
			systemPrompt:
				"You are a deep research assistant. Plan queries, gather diverse sources, synthesize key findings, and deliver a structured report with citations and assumptions.",
			maxTurns: 150,
			timeoutMinutes: 60,
			builtinTools: [
				"read_file",
				"write_file",
				"execute_command",
				"glob_files",
				"grep_search",
			],
		}),
	},
	{
		slug: "structured-extractor",
		name: "Structured extractor",
		description: "Parses unstructured text into a typed JSON schema.",
		providerIcons: [],
		highlights: [
			"Strict output schema",
			"Low temperature (0.1)",
			"Short-horizon turns",
		],
		config: base({
			role: "Structured extraction assistant",
			goal: "Parse unstructured input and emit typed JSON output.",
			systemPrompt:
				"You extract structured data from unstructured input. Follow the schema exactly; never invent fields.",
			temperature: 0.1,
			maxTurns: 30,
			timeoutMinutes: 10,
		}),
	},
	{
		slug: "field-monitor-notion",
		name: "Field monitor (Notion)",
		description:
			"Scans software blogs for a topic and writes a weekly what-changed brief.",
		providerIcons: ["notion"],
		highlights: ["Notion MCP write", "Weekly cadence", "Web research"],
		suggestedMcpServers: [
			{
				server_name: "notion",
				displayName: "Notion",
				transport: "streamable_http",
				url: "https://mcp.notion.com/mcp",
			},
		],
		config: base({
			role: "Technical field monitor",
			goal: "Weekly what-changed briefs posted to Notion.",
			systemPrompt:
				"You monitor a specific technical field. Weekly: read sources, cluster themes, write a concise brief to Notion with links.",
			maxTurns: 80,
			mcpServers: [
				{
					server_name: "notion",
					displayName: "Notion",
					transport: "streamable_http",
					url: "https://mcp.notion.com/mcp",
				},
			],
		}),
	},
	{
		slug: "support-agent",
		name: "Support agent",
		description:
			"Answers customer questions from your docs and knowledge base, and escalates when needed.",
		providerIcons: ["notion", "slack"],
		highlights: ["Notion docs read", "Slack escalate", "RAG over knowledge base"],
		suggestedMcpServers: [
			{
				server_name: "notion",
				displayName: "Notion",
				transport: "streamable_http",
				url: "https://mcp.notion.com/mcp",
			},
			{
				server_name: "slack",
				displayName: "Slack",
				transport: "streamable_http",
				url: "https://mcp.slack.com/mcp",
			},
		],
		config: base({
			role: "Customer support agent",
			goal: "Answer questions from your knowledge base; escalate to Slack when unsure.",
			systemPrompt:
				"You answer customer questions using Notion as your source of truth. If confidence is low, post to Slack and tag an on-call engineer.",
		}),
	},
	{
		slug: "incident-commander",
		name: "Incident commander",
		description:
			"Triages a Sentry alert, opens a Linear incident ticket, and runs the Slack war room.",
		providerIcons: ["sentry", "linear", "slack", "github"],
		highlights: [
			"Sentry + Linear + Slack + GitHub MCP",
			"Owner lookup via GitHub CODEOWNERS",
			"Post-mortem doc",
		],
		suggestedMcpServers: [
			{
				server_name: "sentry",
				displayName: "Sentry",
				transport: "streamable_http",
				url: "https://mcp.sentry.io/mcp",
			},
			{
				server_name: "linear",
				displayName: "Linear",
				transport: "streamable_http",
				url: "https://mcp.linear.app/mcp",
			},
			{
				server_name: "slack",
				displayName: "Slack",
				transport: "streamable_http",
				url: "https://mcp.slack.com/mcp",
			},
			{
				server_name: "github",
				displayName: "GitHub",
				transport: "streamable_http",
				url: "https://api.githubcopilot.com/mcp/",
			},
		],
		config: base({
			role: "Incident commander",
			goal: "Turn an alert into a triaged, assigned, and documented incident.",
			systemPrompt:
				"You run incident response. Read the alert, find the owner via CODEOWNERS, open a Linear ticket, start the Slack war room, and draft a post-mortem outline.",
			maxTurns: 120,
		}),
	},
	{
		slug: "feedback-miner",
		name: "Feedback miner",
		description:
			"Clusters raw feedback from Slack and Notion into themes and drafts Asana tasks for the top asks.",
		providerIcons: ["slack", "notion", "asana"],
		highlights: ["Slack + Notion read", "Asana task draft", "Theme clustering"],
		suggestedMcpServers: [
			{
				server_name: "slack",
				displayName: "Slack",
				transport: "streamable_http",
				url: "https://mcp.slack.com/mcp",
			},
			{
				server_name: "notion",
				displayName: "Notion",
				transport: "streamable_http",
				url: "https://mcp.notion.com/mcp",
			},
			{
				server_name: "asana",
				displayName: "Asana",
				transport: "streamable_http",
				url: "https://mcp.asana.com/mcp",
			},
		],
		config: base({
			role: "Feedback analyst",
			goal: "Synthesize raw user feedback into themes + tasks.",
			systemPrompt:
				"You cluster feedback from Slack channels and Notion pages into themes, rank them by frequency + severity, and draft Asana tasks for the top asks.",
		}),
	},
	{
		slug: "sprint-retro-facilitator",
		name: "Sprint retro facilitator",
		description:
			"Pulls a closed sprint from Linear, synthesizes themes, and writes the retro doc before the meeting.",
		providerIcons: ["linear", "slack"],
		highlights: ["Linear sprint read", "Slack digest", "Retro doc"],
		suggestedMcpServers: [
			{
				server_name: "linear",
				displayName: "Linear",
				transport: "streamable_http",
				url: "https://mcp.linear.app/mcp",
			},
			{
				server_name: "slack",
				displayName: "Slack",
				transport: "streamable_http",
				url: "https://mcp.slack.com/mcp",
			},
		],
		config: base({
			role: "Sprint retro facilitator",
			goal: "Prepare retro before the team meeting.",
			systemPrompt:
				"You pull the closed sprint from Linear, synthesize recurring themes, and draft a retro doc: what went well, what didn't, follow-ups.",
		}),
	},
	{
		slug: "support-to-eng-escalator",
		name: "Support-to-eng escalator",
		description:
			"Reads an Intercom conversation, reproduces the bug, and files a linked Jira issue with repro steps.",
		providerIcons: ["intercom", "atlassian", "slack"],
		highlights: ["Intercom read", "Atlassian/Jira create", "Slack ping"],
		suggestedMcpServers: [
			{
				server_name: "intercom",
				displayName: "Intercom",
				transport: "streamable_http",
				url: "https://mcp.intercom.com/mcp",
			},
			{
				server_name: "atlassian",
				displayName: "Atlassian",
				transport: "streamable_http",
				url: "https://mcp.atlassian.com/mcp",
			},
			{
				server_name: "slack",
				displayName: "Slack",
				transport: "streamable_http",
				url: "https://mcp.slack.com/mcp",
			},
		],
		config: base({
			role: "Support-to-eng escalator",
			goal: "Convert a support conversation into an eng-ready Jira issue.",
			systemPrompt:
				"You turn Intercom conversations into Jira issues. Reproduce the bug inside the sandbox when you can, attach repro steps, and ping the owner in Slack.",
		}),
	},
	{
		slug: "data-analyst",
		name: "Data analyst",
		description:
			"Load, explore, and visualize data; build reports and answer questions from datasets.",
		providerIcons: ["amplitude"],
		highlights: ["Python/pandas tools", "Chart generation", "Amplitude MCP"],
		suggestedMcpServers: [
			{
				server_name: "amplitude",
				displayName: "Amplitude",
				transport: "streamable_http",
				url: "https://mcp.amplitude.com/mcp",
			},
		],
		config: base({
			role: "Data analyst",
			goal: "Load, explore, and summarize data from attached sources.",
			systemPrompt:
				"You are a data analyst. Load CSV/Parquet/Amplitude data, write Python to explore it, generate charts, and answer the user's question with specific numbers.",
			maxTurns: 80,
		}),
	},
];

export function findTemplate(slug: string): AgentTemplate | undefined {
	return AGENT_TEMPLATES.find((t) => t.slug === slug);
}
