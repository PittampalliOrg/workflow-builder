/**
 * Shared utility functions for tool view components.
 * Ported from claude-code-src tool UI.tsx files
 */

/**
 * Count visible lines in content. A trailing newline is treated as a
 * line terminator (not a new empty line), matching editor line numbering.
 * Ported from FileWriteTool/UI.tsx lines 35-38.
 */
export function countLines(content: string): number {
	const parts = content.split('\n');
	return content.endsWith('\n') ? parts.length - 1 : parts.length;
}

/**
 * Strip /sandbox/ prefix for shorter path display.
 */
export function getDisplayPath(path: string): string {
	return path.replace(/^\/sandbox\//, '');
}

/**
 * Truncate text with ellipsis.
 */
export function truncateText(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, max) + '…';
}

/**
 * Truncate command display to max lines and max chars.
 * Constants from BashTool/UI.tsx.
 */
const MAX_COMMAND_DISPLAY_LINES = 2;
const MAX_COMMAND_DISPLAY_CHARS = 160;

/** Max lines for collapsed shell/MCP/text result display — from utils/terminal.ts */
export const MAX_OUTPUT_COLLAPSED_LINES = 3;

/** Max file-write lines rendered inline — from FileWriteTool/UI.tsx */
export const MAX_FILE_WRITE_RENDER_LINES = 10;

/** Max JSON string length to attempt pretty-formatting — from OutputLine.tsx */
const MAX_JSON_FORMAT_LENGTH = 10_000;

export function truncateCommand(command: string): string {
	const lines = command.split('\n');
	let truncated = lines.slice(0, MAX_COMMAND_DISPLAY_LINES).join('\n');
	if (lines.length > MAX_COMMAND_DISPLAY_LINES) {
		truncated += '…';
	}
	if (truncated.length > MAX_COMMAND_DISPLAY_CHARS) {
		truncated = truncated.slice(0, MAX_COMMAND_DISPLAY_CHARS) + '…';
	}
	return truncated;
}

/**
 * Parse the "[exit code N]" suffix that execute_command appends on non-zero exit.
 */
export function extractExitCode(output: string): { cleanOutput: string; exitCode: number | null } {
	const match = output.match(/\n?\[exit code (\d+)\]$/);
	if (match) {
		return {
			cleanOutput: output.slice(0, match.index),
			exitCode: parseInt(match[1], 10)
		};
	}
	return { cleanOutput: output, exitCode: null };
}

/**
 * Parse grep -rn output into structured data.
 * Each line is formatted as: file:line:content
 */
export function parseGrepOutput(output: string): { files: string[]; matchCount: number } {
	if (!output || output === 'No matches found.') {
		return { files: [], matchCount: 0 };
	}
	const lines = output.split('\n').filter((l) => l.trim());
	const fileSet = new Set<string>();
	for (const line of lines) {
		const colonIdx = line.indexOf(':');
		if (colonIdx > 0) {
			fileSet.add(line.slice(0, colonIdx));
		}
	}
	return { files: Array.from(fileSet), matchCount: lines.length };
}

/**
 * Detect language from file path extension.
 * Reuses the pattern from sandbox-code-viewer.svelte.
 */
export function detectLang(filePath: string): string {
	const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
	const langMap: Record<string, string> = {
		ts: 'typescript',
		js: 'javascript',
		tsx: 'tsx',
		jsx: 'jsx',
		py: 'python',
		svelte: 'svelte',
		json: 'json',
		css: 'css',
		sh: 'bash',
		bash: 'bash',
		yml: 'yaml',
		yaml: 'yaml',
		md: 'markdown',
		html: 'html',
		sql: 'sql',
		rs: 'rust',
		go: 'go',
		rb: 'ruby',
		java: 'java',
		toml: 'toml'
	};
	return langMap[ext] ?? 'text';
}

/**
 * Truncate content to a max number of lines, returning the truncated text
 * and the number of remaining lines.
 */
export function truncateLines(
	content: string,
	maxLines: number
): { text: string; remainingLines: number } {
	const lines = content.split('\n');
	if (lines.length <= maxLines) {
		return { text: content, remainingLines: 0 };
	}
	return {
		text: lines.slice(0, maxLines).join('\n'),
		remainingLines: lines.length - maxLines
	};
}

/**
 * Count non-empty lines in ls -la output (excluding the "total N" header).
 */
export function countListEntries(output: string): number {
	const lines = output.split('\n').filter((l) => l.trim());
	// ls -la starts with "total N"
	const dataLines = lines.filter((l) => !l.startsWith('total '));
	return dataLines.length;
}

/**
 * Get the first non-empty line of text for preview.
 */
export function firstLine(text: string): string {
	const line = text.split('\n').find((l) => l.trim());
	return line?.trim() ?? '';
}

/**
 * Format short JSON payloads the same way Claude Code's OutputLine does:
 * parse and pretty-print only when the round trip preserves the value.
 */
export function tryFormatJsonLine(line: string): string {
	try {
		const parsed = JSON.parse(line);
		const stringified = JSON.stringify(parsed);
		const normalizedOriginal = line.replace(/\\\//g, '/').replace(/\s+/g, '');
		const normalizedStringified = stringified.replace(/\s+/g, '');
		if (normalizedOriginal !== normalizedStringified) return line;
		return JSON.stringify(parsed, null, 2);
	} catch {
		return line;
	}
}

export function formatOutputForDisplay(content: string): string {
	if (content.length > MAX_JSON_FORMAT_LENGTH) return content;
	return content.split('\n').map(tryFormatJsonLine).join('\n');
}

export function summarizeCollapsedOutput(content: string): { text: string; remainingLines: number } {
	return truncateLines(formatOutputForDisplay(content).trimEnd(), MAX_OUTPUT_COLLAPSED_LINES);
}

// ---------------------------------------------------------------------------
// Constants ported from claude-code-src Tool.ts
// ---------------------------------------------------------------------------

/** Max chars for tool summary display — from Tool.ts TOOL_SUMMARY_MAX_LENGTH */
export const TOOL_SUMMARY_MAX_LENGTH = 50;

/** Max chars for MCP input values in header — from MCPTool/UI.tsx */
const MAX_INPUT_VALUE_CHARS = 80;

/**
 * Truncate a string to maxLength chars, appending "…" if truncated.
 * Ported from claude-code-src utils/truncate.ts.
 */
export function truncateSummary(str: string, maxLength: number = TOOL_SUMMARY_MAX_LENGTH): string {
	if (str.length <= maxLength) return str;
	return str.slice(0, maxLength) + '…';
}

// ---------------------------------------------------------------------------
// Agent color management — ported from AgentTool/agentColorManager.ts
// ---------------------------------------------------------------------------

export type AgentColorName = 'red' | 'blue' | 'green' | 'yellow' | 'purple' | 'orange' | 'pink' | 'cyan';

export interface AgentColorSet {
	bg: string;
	text: string;
	border: string;
	/** Classes for the agent name badge (colored background) */
	name: string;
}

/**
 * Static Tailwind class sets for each agent color.
 * Uses complete class names to avoid Tailwind purge issues.
 */
const AGENT_COLOR_SETS: Record<AgentColorName, AgentColorSet> = {
	red:    { bg: 'bg-red-500/10',    text: 'text-red-400',    border: 'border-red-500/20',    name: 'bg-red-500/80 text-red-100' },
	blue:   { bg: 'bg-blue-500/10',   text: 'text-blue-400',   border: 'border-blue-500/20',   name: 'bg-blue-500/80 text-blue-100' },
	green:  { bg: 'bg-green-500/10',  text: 'text-green-400',  border: 'border-green-500/20',  name: 'bg-green-500/80 text-green-100' },
	yellow: { bg: 'bg-yellow-500/10', text: 'text-yellow-400', border: 'border-yellow-500/20', name: 'bg-yellow-500/80 text-yellow-100' },
	purple: { bg: 'bg-purple-500/10', text: 'text-purple-400', border: 'border-purple-500/20', name: 'bg-purple-500/80 text-purple-100' },
	orange: { bg: 'bg-orange-500/10', text: 'text-orange-400', border: 'border-orange-500/20', name: 'bg-orange-500/80 text-orange-100' },
	pink:   { bg: 'bg-pink-500/10',   text: 'text-pink-400',   border: 'border-pink-500/20',   name: 'bg-pink-500/80 text-pink-100' },
	cyan:   { bg: 'bg-cyan-500/10',   text: 'text-cyan-400',   border: 'border-cyan-500/20',   name: 'bg-cyan-500/80 text-cyan-100' },
};

const AGENT_COLOR_NAMES: readonly AgentColorName[] = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'];

/**
 * Get a deterministic color set for an agent type.
 * Uses a simple string hash to assign one of 8 colors.
 * 'general-purpose' agents get no color (returns undefined).
 * Ported from AgentTool/agentColorManager.ts — adapted from map-based
 * to hash-based since we don't have persistent state across renders.
 */
export function getAgentColor(agentType: string): AgentColorSet | undefined {
	if (!agentType || agentType === 'general-purpose' || agentType === 'worker') {
		return undefined;
	}
	let hash = 0;
	for (let i = 0; i < agentType.length; i++) {
		hash = ((hash << 5) - hash + agentType.charCodeAt(i)) | 0;
	}
	const index = ((hash % AGENT_COLOR_NAMES.length) + AGENT_COLOR_NAMES.length) % AGENT_COLOR_NAMES.length;
	return AGENT_COLOR_SETS[AGENT_COLOR_NAMES[index]];
}

// ---------------------------------------------------------------------------
// MCP tool name parsing
// ---------------------------------------------------------------------------

/**
 * Check if a tool name is an MCP tool (prefixed with mcp_ or mcp__).
 */
export function isMcpTool(toolName: string): boolean {
	return toolName.startsWith('mcp_');
}

/**
 * Parse an MCP tool name into server and action parts.
 * Handles both mcp__server__action and mcp_server_action patterns.
 */
export function parseMcpToolName(toolName: string): { server: string; action: string } {
	// mcp__server__action format (double underscore delimited)
	const doubleMatch = toolName.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
	if (doubleMatch) {
		return {
			server: doubleMatch[1].replace(/_/g, ' '),
			action: doubleMatch[2].replace(/_/g, ' ')
		};
	}
	// Fallback: strip mcp_ prefix and use whole name
	const stripped = toolName.replace(/^mcp_+/, '');
	return { server: '', action: stripped.replace(/_/g, ' ') };
}

// ---------------------------------------------------------------------------
// Format utilities — ported from claude-code-src utils/format.ts
// ---------------------------------------------------------------------------

/**
 * Format byte count as human-readable file size.
 * Ported from claude-code-src utils/format.ts formatFileSize().
 */
export function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------
// MCP-style arg rendering — ported from MCPTool/UI.tsx renderToolUseMessage
// ---------------------------------------------------------------------------

/**
 * Render tool args as "key: value, key: value" with per-value truncation.
 * Ported from MCPTool/UI.tsx renderToolUseMessage().
 */
export function renderArgsSummary(args: Record<string, unknown>): string {
	const entries = Object.entries(args);
	if (entries.length === 0) return '';
	return entries
		.map(([key, value]) => {
			let rendered = JSON.stringify(value);
			if (rendered.length > MAX_INPUT_VALUE_CHARS) {
				rendered = rendered.slice(0, MAX_INPUT_VALUE_CHARS).trimEnd() + '…';
			}
			return `${key}: ${rendered}`;
		})
		.join(', ');
}
