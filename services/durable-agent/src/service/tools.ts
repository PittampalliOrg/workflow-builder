/**
 * Workspace Tools as DurableAgentTool Objects
 *
 * Each tool has description, inputSchema (zod), and execute function.
 * These are registered with DurableAgent and become durable Dapr workflow activities.
 */

import { z } from "zod";
import {
	filesystem,
	sandbox,
	executeCommandViaSandbox,
} from "./sandbox-config.js";
import type { DurableAgentTool } from "../types/tool.js";

/** Escape a string for safe use inside single-quoted shell arguments. */
function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

export const TOOL_NAMES = [
	"read_file",
	"write_file",
	"edit_file",
	"list_files",
	"delete_file",
	"mkdir",
	"file_stat",
	"execute_command",
];

export const workspaceTools: Record<string, DurableAgentTool> = {
	read_file: {
		description: "Read a file from the workspace",
		inputSchema: z.object({ path: z.string().describe("File path to read") }),
		execute: async (args) => {
			const content = await filesystem.readFile(args.path as string, {
				encoding: "utf-8",
			});
			return { content };
		},
	},

	write_file: {
		description: "Create or overwrite a file in the workspace",
		inputSchema: z.object({
			path: z.string().describe("File path to write"),
			content: z.string().describe("File content"),
		}),
		execute: async (args) => {
			await filesystem.writeFile(args.path as string, args.content as string, {
				recursive: true,
			});
			return { path: args.path };
		},
	},

	edit_file: {
		description: "Find and replace text in a file",
		inputSchema: z.object({
			path: z.string().describe("File path to edit"),
			old_string: z.string().describe("Text to find"),
			new_string: z.string().describe("Replacement text"),
		}),
		execute: async (args) => {
			const original = (await filesystem.readFile(args.path as string, {
				encoding: "utf-8",
			})) as string;
			const oldStr = args.old_string as string;
			const newStr = args.new_string as string;
			if (!original.includes(oldStr)) {
				throw new Error(`old_string not found in ${args.path as string}`);
			}
			const updated = original.replace(oldStr, newStr);
			await filesystem.writeFile(args.path as string, updated);
			return { path: args.path };
		},
	},

	list_files: {
		description: "List directory contents",
		inputSchema: z.object({
			path: z.string().optional().describe("Directory path (default: workspace root)"),
		}),
		execute: async (args) => {
			const entries = await filesystem.readdir(
				(args.path as string) || ".",
			);
			const files = entries.map((e) => ({
				name: e.name,
				type: e.type,
			}));
			return { files };
		},
	},

	delete_file: {
		description: "Delete a file or directory",
		inputSchema: z.object({
			path: z.string().describe("Path to delete"),
		}),
		execute: async (args) => {
			await filesystem.deleteFile(args.path as string, {
				recursive: true,
				force: true,
			});
			return { deleted: true };
		},
	},

	mkdir: {
		description: "Create a directory",
		inputSchema: z.object({
			path: z.string().describe("Directory path to create"),
		}),
		execute: async (args) => {
			await filesystem.mkdir(args.path as string, { recursive: true });
			return { path: args.path };
		},
	},

	file_stat: {
		description: "Get file or directory metadata",
		inputSchema: z.object({
			path: z.string().describe("Path to get metadata for"),
		}),
		execute: async (args) => {
			const info = await filesystem.stat(args.path as string);
			return {
				size: info.size,
				isFile: info.type === "file",
				isDirectory: info.type === "directory",
				modified: info.modifiedAt.toISOString(),
				created: info.createdAt.toISOString(),
			};
		},
	},

	execute_command: {
		description: "Run a shell command in the workspace",
		inputSchema: z.object({
			command: z.string().describe("Shell command to execute"),
		}),
		execute: async (args) => {
			const command = args.command as string;
			if (!command) throw new Error("command is required");
			return executeCommandViaSandbox(command, { timeout: 30_000 });
		},
	},
};

// ── Tool list for API responses ───────────────────────────────

export function listTools() {
	return [
		{
			id: "read_file",
			name: "Read File",
			description: "Read a file from the workspace",
		},
		{
			id: "write_file",
			name: "Write File",
			description: "Create or overwrite a file",
		},
		{
			id: "edit_file",
			name: "Edit File",
			description: "Find and replace text in a file",
		},
		{
			id: "list_files",
			name: "List Files",
			description: "List directory contents",
		},
		{
			id: "execute_command",
			name: "Execute Command",
			description: "Run a shell command",
		},
		{
			id: "delete_file",
			name: "Delete",
			description: "Delete a file or directory",
		},
		{
			id: "mkdir",
			name: "Create Directory",
			description: "Create a directory",
		},
		{
			id: "file_stat",
			name: "File Stat",
			description: "Get file metadata",
		},
		{
			id: "clone",
			name: "Clone Repository",
			description: "Clone a GitHub repository into the workspace",
		},
	];
}

// ── Direct tool execution (bypass agent) ──────────────────────

/** Map of slug-style tool IDs to workspace tool names. */
const TOOL_ALIASES: Record<string, string> = {
	"read-file": "read_file",
	"write-file": "write_file",
	"edit-file": "edit_file",
	"list-files": "list_files",
	delete: "delete_file",
	"file-stat": "file_stat",
	"execute-command": "execute_command",
	clone: "clone",
};

export async function executeTool(
	rawToolId: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const toolId = TOOL_ALIASES[rawToolId] ?? rawToolId;

	// Handle clone separately (not in workspaceTools as it has complex logic)
	if (toolId === "clone") {
		return executeClone(args);
	}

	const tool = workspaceTools[toolId];
	if (!tool) {
		throw new Error(`Unknown tool: ${rawToolId}`);
	}

	const result = await tool.execute(args);
	return (result as Record<string, unknown>) ?? {};
}

// ── Clone tool ────────────────────────────────────────────────

async function executeClone(
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const owner = ((args.repositoryOwner as string) || "").trim();
	const repo = ((args.repositoryRepo as string) || "").trim();
	const branch = ((args.repositoryBranch as string) || "main").trim();
	const token =
		((args.repositoryToken as string) || "").trim() ||
		((args.githubToken as string) || "").trim();

	if (!owner || !repo) {
		throw new Error("repositoryOwner and repositoryRepo are required");
	}

	const cloneDir = repo;

	// Idempotent: remove existing directory
	const dirExists = await filesystem.exists(cloneDir);
	if (dirExists) {
		await filesystem.deleteFile(cloneDir, { recursive: true, force: true });
	}

	const repoUrl = token
		? `https://${token}@github.com/${owner}/${repo}.git`
		: `https://github.com/${owner}/${repo}.git`;

	// Clone in sandbox
	let commitHash = "unknown";
	let fileCount = 0;

	try {
		const result = await executeCommandViaSandbox(
			`GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch ${shellEscape(branch)} ${shellEscape(repoUrl)} ${shellEscape(cloneDir)}`,
			{ timeout: 120_000 },
		);
		if (result.exitCode !== 0) {
			const sanitized = token
				? result.stderr.replace(new RegExp(token, "g"), "***")
				: result.stderr;
			throw new Error(`git clone failed: ${sanitized}`);
		}
	} catch (cloneError) {
		const rawMsg =
			cloneError instanceof Error ? cloneError.message : String(cloneError);
		const sanitized = token
			? rawMsg.replace(new RegExp(token, "g"), "***")
			: rawMsg;
		throw new Error(
			rawMsg.startsWith("git clone failed")
				? sanitized
				: `git clone failed: ${sanitized}`,
		);
	}

	try {
		const r = await executeCommandViaSandbox(
			`cd ${shellEscape(cloneDir)} && git rev-parse HEAD`,
		);
		if (r.exitCode === 0) commitHash = r.stdout.trim();
	} catch {
		/* non-fatal */
	}
	try {
		const r = await executeCommandViaSandbox(
			`cd ${shellEscape(cloneDir)} && git ls-files --cached`,
		);
		if (r.exitCode === 0) fileCount = r.stdout.split("\n").filter(Boolean).length;
	} catch {
		/* non-fatal */
	}

	return {
		success: true,
		clonePath: cloneDir,
		commitHash,
		repository: `${owner}/${repo}`,
		file_count: fileCount,
	};
}
