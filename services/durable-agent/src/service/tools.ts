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
import { workspaceSessions } from "./workspace-sessions.js";
import type { DurableAgentTool } from "../types/tool.js";

const INTERNAL_ARG_KEYS = new Set([
	"__durable_instance_id",
	"workspaceRef",
	"executionId",
]);

function stripInternalArgs(
	args: Record<string, unknown>,
): Record<string, unknown> {
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (!INTERNAL_ARG_KEYS.has(key)) {
			cleaned[key] = value;
		}
	}
	return cleaned;
}

function getDurableInstanceId(
	args: Record<string, unknown>,
): string | undefined {
	return typeof args.__durable_instance_id === "string"
		? args.__durable_instance_id
		: undefined;
}

/** Escape a string for safe use inside single-quoted shell arguments. */
function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

function resolveRepoNameFromUrl(repositoryUrl: string): string {
	if (!repositoryUrl) return "";
	try {
		const url = new URL(repositoryUrl);
		const parts = url.pathname.split("/").filter(Boolean);
		const value = parts[parts.length - 1] || "";
		return value.replace(/\.git$/i, "").trim();
	} catch {
		return "";
	}
}

function resolveRepositoryUrl(input: {
	repositoryUrl: string;
	repositoryOwner: string;
	repositoryRepo: string;
	repositoryUsername: string;
	token: string;
}): string {
	if (!input.repositoryUrl) {
		const base = `https://github.com/${input.repositoryOwner}/${input.repositoryRepo}.git`;
		if (!input.token) return base;
		if (!input.repositoryUsername) {
			return `https://${input.token}@github.com/${input.repositoryOwner}/${input.repositoryRepo}.git`;
		}
		return `https://${encodeURIComponent(input.repositoryUsername)}:${encodeURIComponent(input.token)}@github.com/${input.repositoryOwner}/${input.repositoryRepo}.git`;
	}

	if (!input.token) {
		return input.repositoryUrl;
	}

	try {
		const parsed = new URL(input.repositoryUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return input.repositoryUrl;
		}
		const user =
			input.repositoryUsername || (parsed.hostname === "github.com" ? input.token : "");
		if (!user) {
			return input.repositoryUrl;
		}
		parsed.username = user;
		parsed.password =
			input.repositoryUsername || parsed.hostname !== "github.com"
				? input.token
				: "";
		return parsed.toString();
	} catch {
		return input.repositoryUrl;
	}
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
			const cleanArgs = stripInternalArgs(args);
			const session = await workspaceSessions.resolveSessionFromArgs(args);
			if (session) {
				return workspaceSessions.executeFileOperation({
					workspaceRef: session.workspaceRef,
					durableInstanceId: getDurableInstanceId(args),
					operation: "read_file",
					path: cleanArgs.path as string | undefined,
				});
			}
			const content = await filesystem.readFile(cleanArgs.path as string, {
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
			const cleanArgs = stripInternalArgs(args);
			const session = await workspaceSessions.resolveSessionFromArgs(args);
			if (session) {
				return workspaceSessions.executeFileOperation({
					workspaceRef: session.workspaceRef,
					durableInstanceId: getDurableInstanceId(args),
					operation: "write_file",
					path: cleanArgs.path as string | undefined,
					content: cleanArgs.content as string | undefined,
				});
			}
			await filesystem.writeFile(
				cleanArgs.path as string,
				cleanArgs.content as string,
				{
					recursive: true,
				},
			);
			return { path: cleanArgs.path };
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
			const cleanArgs = stripInternalArgs(args);
			const session = await workspaceSessions.resolveSessionFromArgs(args);
			if (session) {
				return workspaceSessions.executeFileOperation({
					workspaceRef: session.workspaceRef,
					durableInstanceId: getDurableInstanceId(args),
					operation: "edit_file",
					path: cleanArgs.path as string | undefined,
					old_string: cleanArgs.old_string as string | undefined,
					new_string: cleanArgs.new_string as string | undefined,
				});
			}
			const original = (await filesystem.readFile(cleanArgs.path as string, {
				encoding: "utf-8",
			})) as string;
			const oldStr = cleanArgs.old_string as string;
			const newStr = cleanArgs.new_string as string;
			if (!original.includes(oldStr)) {
				throw new Error(`old_string not found in ${cleanArgs.path as string}`);
			}
			const updated = original.replace(oldStr, newStr);
			await filesystem.writeFile(cleanArgs.path as string, updated);
			return { path: cleanArgs.path };
		},
	},

	list_files: {
		description: "List directory contents",
		inputSchema: z.object({
			path: z
				.string()
				.optional()
				.describe("Directory path (default: workspace root)"),
		}),
		execute: async (args) => {
			const cleanArgs = stripInternalArgs(args);
			const session = await workspaceSessions.resolveSessionFromArgs(args);
			if (session) {
				return workspaceSessions.executeFileOperation({
					workspaceRef: session.workspaceRef,
					durableInstanceId: getDurableInstanceId(args),
					operation: "list_files",
					path: cleanArgs.path as string | undefined,
				});
			}
			const entries = await filesystem.readdir(
				(cleanArgs.path as string) || ".",
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
			const cleanArgs = stripInternalArgs(args);
			const session = await workspaceSessions.resolveSessionFromArgs(args);
			if (session) {
				return workspaceSessions.executeFileOperation({
					workspaceRef: session.workspaceRef,
					durableInstanceId: getDurableInstanceId(args),
					operation: "delete_file",
					path: cleanArgs.path as string | undefined,
				});
			}
			await filesystem.deleteFile(cleanArgs.path as string, {
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
			const cleanArgs = stripInternalArgs(args);
			const session = await workspaceSessions.resolveSessionFromArgs(args);
			if (session) {
				return workspaceSessions.executeFileOperation({
					workspaceRef: session.workspaceRef,
					durableInstanceId: getDurableInstanceId(args),
					operation: "mkdir",
					path: cleanArgs.path as string | undefined,
				});
			}
			await filesystem.mkdir(cleanArgs.path as string, { recursive: true });
			return { path: cleanArgs.path };
		},
	},

	file_stat: {
		description: "Get file or directory metadata",
		inputSchema: z.object({
			path: z.string().describe("Path to get metadata for"),
		}),
		execute: async (args) => {
			const cleanArgs = stripInternalArgs(args);
			const session = await workspaceSessions.resolveSessionFromArgs(args);
			if (session) {
				return workspaceSessions.executeFileOperation({
					workspaceRef: session.workspaceRef,
					durableInstanceId: getDurableInstanceId(args),
					operation: "file_stat",
					path: cleanArgs.path as string | undefined,
				});
			}
			const info = await filesystem.stat(cleanArgs.path as string);
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
			const cleanArgs = stripInternalArgs(args);
			const command = cleanArgs.command as string;
			if (!command) throw new Error("command is required");
			const session = await workspaceSessions.resolveSessionFromArgs(args);
			if (session) {
				return workspaceSessions.executeCommand({
					workspaceRef: session.workspaceRef,
					durableInstanceId: getDurableInstanceId(args),
					command,
				});
			}
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

	if (!tool.execute) {
		throw new Error(`Tool "${rawToolId}" has no execute function`);
	}
	const result = await tool.execute(args);
	return (result as Record<string, unknown>) ?? {};
}

// ── Clone tool ────────────────────────────────────────────────

async function executeClone(
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const repositoryUrl = ((args.repositoryUrl as string) || "").trim();
	const owner = ((args.repositoryOwner as string) || "").trim();
	const repo = ((args.repositoryRepo as string) || "").trim();
	const branch = ((args.repositoryBranch as string) || "").trim();
	const username = ((args.repositoryUsername as string) || "").trim();
	const token =
		((args.repositoryToken as string) || "").trim() ||
		((args.githubToken as string) || "").trim();

	if (!branch) {
		throw new Error("repositoryBranch is required");
	}
	if (!repositoryUrl && (!owner || !repo)) {
		throw new Error(
			"repositoryBranch and either repositoryUrl or repositoryOwner/repositoryRepo are required",
		);
	}

	const repoName = repo || resolveRepoNameFromUrl(repositoryUrl);
	if (!repoName) {
		throw new Error("Unable to resolve repository name for clone target");
	}

	const cloneDir = repoName;

	// Idempotent: remove existing directory
	const dirExists = await filesystem.exists(cloneDir);
	if (dirExists) {
		await filesystem.deleteFile(cloneDir, { recursive: true, force: true });
	}

	const repoUrl = resolveRepositoryUrl({
		repositoryUrl,
		repositoryOwner: owner,
		repositoryRepo: repo,
		repositoryUsername: username,
		token,
	});

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
		if (r.exitCode === 0)
			fileCount = r.stdout.split("\n").filter(Boolean).length;
	} catch {
		/* non-fatal */
	}

	return {
		success: true,
		clonePath: cloneDir,
		commitHash,
		repository: owner && repo ? `${owner}/${repo}` : repoName,
		file_count: fileCount,
	};
}
