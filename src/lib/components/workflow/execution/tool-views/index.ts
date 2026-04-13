import type { Component } from 'svelte';
import BashToolView from './bash-tool-view.svelte';
import ReadToolView from './read-tool-view.svelte';
import WriteToolView from './write-tool-view.svelte';
import ListToolView from './list-tool-view.svelte';
import SearchToolView from './search-tool-view.svelte';
import WebSearchToolView from './web-search-tool-view.svelte';
import WebFetchToolView from './web-fetch-tool-view.svelte';
import AgentToolView from './agent-tool-view.svelte';
import McpToolView from './mcp-tool-view.svelte';
import GenericToolView from './generic-tool-view.svelte';

export interface ToolViewProps {
	phase: 'start' | 'end';
	toolName: string;
	args?: Record<string, unknown>;
	output?: string;
	success?: boolean;
	error?: string;
	state?: 'running' | 'completed' | 'error' | 'pending';
}

/**
 * Tool name to component mapping.
 *
 * Maps:
 * - Python function names from services/dapr-agent-py/src/tools.py
 * - dapr-agents SDK built-in tool names (BashRun, FileWrite, etc.)
 * - Claude Code tool names (WebSearch, WebFetch, Agent, etc.)
 *
 * The SDK emits its own tool names in events regardless of the
 * underlying Python function names.
 */
const TOOL_MAP: Record<string, Component<ToolViewProps>> = {
	// ── Bash / terminal ──────────────────────────────────────
	BashRun: BashToolView,          // dapr-agents SDK
	execute_command: BashToolView,   // dapr-agent-py tools.py
	Bash: BashToolView,             // durable-agent (Claude Code userFacingName)
	SandboxedBash: BashToolView,    // durable-agent sandbox mode

	// ── File read ────────────────────────────────────────────
	FileRead: ReadToolView,         // dapr-agents SDK
	read_file: ReadToolView,        // dapr-agent-py tools.py
	Read: ReadToolView,             // durable-agent (Claude Code userFacingName)

	// ── File write / edit ────────────────────────────────────
	FileWrite: WriteToolView,       // dapr-agents SDK
	write_file: WriteToolView,      // dapr-agent-py tools.py
	Write: WriteToolView,           // durable-agent (Claude Code userFacingName)
	Create: WriteToolView,          // durable-agent (new file)
	Update: WriteToolView,          // durable-agent (edit file)
	FileEdit: WriteToolView,        // dapr-agents SDK edit variant

	// ── File search / glob ───────────────────────────────────
	GlobSearch: ListToolView,       // dapr-agents SDK
	list_files: ListToolView,       // dapr-agent-py tools.py
	search_files: SearchToolView,   // dapr-agent-py tools.py
	Search: SearchToolView,         // durable-agent (Claude Code userFacingName for Grep/Glob)
	Grep: SearchToolView,           // durable-agent
	Glob: ListToolView,             // durable-agent
	Find: ListToolView,             // alternative name

	// ── Web search ───────────────────────────────────────────
	WebSearch: WebSearchToolView,    // durable-agent
	web_search: WebSearchToolView,  // snake_case variant

	// ── Web fetch ────────────────────────────────────────────
	WebFetch: WebFetchToolView,     // durable-agent
	web_fetch: WebFetchToolView,    // snake_case variant
	Fetch: WebFetchToolView,        // Claude Code userFacingName

	// ── Agent / subagent ─────────────────────────────────────
	Agent: AgentToolView,           // durable-agent
	agent: AgentToolView,           // snake_case variant
	SubAgent: AgentToolView,        // subagent variant
	sub_agent: AgentToolView,       // snake_case variant

	// ── Task / todo management ───────────────────────────────
	TodoWrite: GenericToolView,     // durable-agent task tracking
};

/**
 * Look up the view component for a given tool name.
 * MCP tools (mcp_ / mcp__ prefix) get the MCP view.
 * Returns GenericToolView for unrecognized tools.
 */
export function getToolComponent(toolName: string): Component<ToolViewProps> {
	if (TOOL_MAP[toolName]) return TOOL_MAP[toolName];
	// MCP tools: mcp_ or mcp__ prefix → dedicated MCP view
	if (toolName.startsWith('mcp_')) return McpToolView;
	return GenericToolView;
}
