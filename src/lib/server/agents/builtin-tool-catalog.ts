/**
 * Short descriptions and argument schemas for built-in tools, used to
 * enrich the `AgentMetadataSchema` blob written to the Dapr agent
 * registry. Descriptions are short (one line) on purpose — registry
 * readers use them for routing hints, not for prompting.
 *
 * Source of truth for descriptions: `services/dapr-agent-py/src/tools/
 * <tool>/prompt.py :: get_*_tool_description()`. Keep these in sync with
 * the Python long-form descriptions; if a Python tool's docstring is the
 * primary prompt shipped to the LLM at runtime, this TS catalog carries
 * only the summary.
 */

export type BuiltinToolSpec = {
	description: string;
	args: Record<string, unknown>; // JSON schema (Draft 2020-12 object)
};

export const BUILTIN_TOOL_CATALOG: Record<string, BuiltinToolSpec> = {
	// bash_run / BashRun (services/dapr-agent-py/src/tools/bash_tool/prompt.py)
	execute_command: {
		description: "Executes a given bash command in the session sandbox and returns its output.",
		args: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command to run." },
				timeout_ms: { type: "integer", description: "Optional timeout in milliseconds." },
				description: { type: "string", description: "Clear one-line description of the command." },
			},
			required: ["command"],
		},
	},
	// file_read / FileRead (services/dapr-agent-py/src/tools/file_read/prompt.py)
	read_file: {
		description:
			"Reads a file from the sandbox filesystem. Supports offset/limit for large files and returns line-numbered output.",
		args: {
			type: "object",
			properties: {
				file_path: { type: "string", description: "Absolute path." },
				offset: { type: "integer", description: "Line number to start from (default 0)." },
				limit: { type: "integer", description: "Number of lines to read." },
			},
			required: ["file_path"],
		},
	},
	// file_write / FileWrite (services/dapr-agent-py/src/tools/file_write/prompt.py)
	write_file: {
		description: "Writes a file to the sandbox filesystem (overwrites if it exists).",
		args: {
			type: "object",
			properties: {
				file_path: { type: "string", description: "Absolute path." },
				content: { type: "string", description: "File content." },
			},
			required: ["file_path", "content"],
		},
	},
	// file_edit / FileEdit (services/dapr-agent-py/src/tools/file_edit/prompt.py)
	edit_file: {
		description:
			"Performs exact string replacements in a file. Use replace_all for variable renames.",
		args: {
			type: "object",
			properties: {
				file_path: { type: "string" },
				old_string: { type: "string" },
				new_string: { type: "string" },
				replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
			},
			required: ["file_path", "old_string", "new_string"],
		},
	},
	// Internal list helper (no direct Python equivalent — closest is glob_search)
	list_files: {
		description: "Enumerate files in a sandbox directory.",
		args: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute directory to list." },
			},
			required: ["path"],
		},
	},
	// glob_search / GlobSearch (services/dapr-agent-py/src/tools/glob_tool/prompt.py)
	glob_files: {
		description:
			"Fast file pattern matching. Supports globs like '**/*.ts'. Returns paths sorted by mtime.",
		args: {
			type: "object",
			properties: {
				pattern: { type: "string" },
				path: { type: "string", description: "Root directory (default cwd)." },
			},
			required: ["pattern"],
		},
	},
	// grep_search / GrepSearch (services/dapr-agent-py/src/tools/grep_tool/prompt.py)
	grep_search: {
		description:
			"Search file contents by regex via ripgrep. Supports context lines, file-type filters, and multiple output modes.",
		args: {
			type: "object",
			properties: {
				pattern: { type: "string" },
				path: { type: "string" },
				glob: { type: "string", description: "Glob filter." },
				output_mode: {
					type: "string",
					enum: ["content", "files_with_matches", "count"],
				},
				"-i": { type: "boolean", description: "Case-insensitive." },
				"-n": { type: "boolean", description: "Show line numbers." },
				"-A": { type: "integer", description: "Lines after each match." },
				"-B": { type: "integer", description: "Lines before each match." },
			},
			required: ["pattern"],
		},
	},
	// Web tools — not currently in services/dapr-agent-py/src/tools but part
	// of the CMA agent_toolset_20260401 surface. Descriptions mirror CMA's.
	web_search: {
		description: "Search the web for up-to-date information.",
		args: {
			type: "object",
			properties: {
				query: { type: "string" },
				allowed_domains: { type: "array", items: { type: "string" } },
				blocked_domains: { type: "array", items: { type: "string" } },
			},
			required: ["query"],
		},
	},
	web_fetch: {
		description: "Fetch the content at a URL and return its extracted text.",
		args: {
			type: "object",
			properties: {
				url: { type: "string", format: "uri" },
				prompt: { type: "string", description: "What to extract from the page." },
			},
			required: ["url"],
		},
	},
};

/** Return the catalog entry for a tool name, or null if unknown. */
export function lookupBuiltinTool(name: string): BuiltinToolSpec | null {
	return BUILTIN_TOOL_CATALOG[name] ?? null;
}
