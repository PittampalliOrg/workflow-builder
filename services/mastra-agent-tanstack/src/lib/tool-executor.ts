/**
 * Tool Executor — Direct workspace tool execution
 *
 * Implements workspace tools (read, write, edit, list, delete, mkdir,
 * execute-command) as direct Node.js operations, bypassing the LLM agent.
 * Called by the function-router via POST /api/tools/{toolId}.
 */

import { readFile, writeFile, rm, mkdir, stat, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { executeCommandViaSandbox, WORKSPACE_PATH } from "./sandbox-config";

const execFileAsync = promisify(execFile);

/** Resolve a user-provided path safely within the workspace. */
function safePath(userPath: string): string {
	const resolved = resolve(WORKSPACE_PATH, userPath);
	if (!resolved.startsWith(WORKSPACE_PATH)) {
		throw new Error("Path escapes workspace boundary");
	}
	return resolved;
}

type ToolResult = Record<string, unknown>;

/** Map of slug-style tool IDs to workspace tool names. */
const TOOL_ALIASES: Record<string, string> = {
	"read-file": "read-file",
	"write-file": "write-file",
	"edit-file": "edit-file",
	"list-files": "list-files",
	delete: "delete",
	mkdir: "mkdir",
	"file-stat": "file-stat",
	"execute-command": "execute-command",
	// Also accept mastra_workspace_* names
	mastra_workspace_read_file: "read-file",
	mastra_workspace_write_file: "write-file",
	mastra_workspace_edit_file: "edit-file",
	mastra_workspace_list_files: "list-files",
	mastra_workspace_delete: "delete",
	mastra_workspace_mkdir: "mkdir",
	mastra_workspace_file_stat: "file-stat",
	mastra_workspace_execute_command: "execute-command",
	// Clone
	clone: "clone",
	"git-clone": "clone",
	mastra_workspace_clone: "clone",
	// Agentic run
	run: "run",
};

export function listTools() {
	return [
		{
			id: "read-file",
			name: "Read File",
			description: "Read a file from the workspace",
		},
		{
			id: "write-file",
			name: "Write File",
			description: "Create or overwrite a file",
		},
		{
			id: "edit-file",
			name: "Edit File",
			description: "Find and replace text in a file",
		},
		{
			id: "list-files",
			name: "List Files",
			description: "List directory contents",
		},
		{
			id: "execute-command",
			name: "Execute Command",
			description: "Run a shell command",
		},
		{ id: "delete", name: "Delete", description: "Delete a file or directory" },
		{
			id: "mkdir",
			name: "Create Directory",
			description: "Create a directory",
		},
		{
			id: "file-stat",
			name: "File Stat",
			description: "Get file metadata",
		},
		{
			id: "clone",
			name: "Clone Repository",
			description: "Clone a GitHub repository into the workspace",
		},
		{
			id: "run",
			name: "Run Agent",
			description: "Run the agent with a prompt (agentic mode)",
		},
	];
}

export async function executeTool(
	rawToolId: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const toolId = TOOL_ALIASES[rawToolId] ?? rawToolId;

	switch (toolId) {
		case "read-file": {
			const filePath = safePath(args.path as string);
			const content = await readFile(filePath, "utf-8");
			return { content };
		}

		case "write-file": {
			const filePath = safePath(args.path as string);
			const dir = filePath.substring(0, filePath.lastIndexOf("/"));
			if (dir && !existsSync(dir)) {
				await mkdir(dir, { recursive: true });
			}
			await writeFile(filePath, args.content as string, "utf-8");
			return { path: args.path as string };
		}

		case "edit-file": {
			const filePath = safePath(args.path as string);
			const original = await readFile(filePath, "utf-8");
			const oldStr = args.old_string as string;
			const newStr = args.new_string as string;
			if (!original.includes(oldStr)) {
				throw new Error(
					`old_string not found in ${args.path as string}`,
				);
			}
			const updated = original.replace(oldStr, newStr);
			await writeFile(filePath, updated, "utf-8");
			return { path: args.path as string };
		}

		case "list-files": {
			const dirPath = safePath((args.path as string) || ".");
			const entries = await readdir(dirPath, { withFileTypes: true });
			const files = entries.map((e) => ({
				name: e.name,
				type: e.isDirectory() ? "directory" : "file",
			}));
			return { files };
		}

		case "execute-command": {
			const command = args.command as string;
			if (!command) throw new Error("command is required");
			return executeCommandViaSandbox(command, { timeout: 30_000 });
		}

		case "delete": {
			const filePath = safePath(args.path as string);
			await rm(filePath, { recursive: true, force: true });
			return { deleted: true };
		}

		case "mkdir": {
			const dirPath = safePath(args.path as string);
			await mkdir(dirPath, { recursive: true });
			return { path: args.path as string };
		}

		case "file-stat": {
			const filePath = safePath(args.path as string);
			const info = await stat(filePath);
			return {
				size: info.size,
				isFile: info.isFile(),
				isDirectory: info.isDirectory(),
				modified: info.mtime.toISOString(),
				created: info.birthtime.toISOString(),
			};
		}

		case "clone": {
			const owner = (args.repositoryOwner as string || "").trim();
			const repo = (args.repositoryRepo as string || "").trim();
			const branch = (args.repositoryBranch as string || "main").trim();
			const token =
				(args.repositoryToken as string || "").trim() ||
				(args.githubToken as string || "").trim();

			if (!owner || !repo) {
				throw new Error("repositoryOwner and repositoryRepo are required");
			}

			const cloneDir = join(WORKSPACE_PATH, repo);

			// Idempotent: remove existing directory
			if (existsSync(cloneDir)) {
				await rm(cloneDir, { recursive: true, force: true });
			}

			const repoUrl = token
				? `https://${token}@github.com/${owner}/${repo}.git`
				: `https://github.com/${owner}/${repo}.git`;

			try {
				await execFileAsync(
					"git",
					["clone", "--depth", "1", "--branch", branch, repoUrl, cloneDir],
					{
						env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
						timeout: 120_000,
					},
				);
			} catch (cloneError) {
				// Sanitize token from error messages
				const rawMsg =
					cloneError instanceof Error ? cloneError.message : String(cloneError);
				const sanitized = token
					? rawMsg.replace(new RegExp(token, "g"), "***")
					: rawMsg;
				throw new Error(`git clone failed: ${sanitized}`);
			}

			// Get HEAD commit hash
			let commitHash = "unknown";
			try {
				const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
					cwd: cloneDir,
				});
				commitHash = stdout.trim();
			} catch {
				// non-fatal
			}

			// Count files
			let fileCount = 0;
			try {
				const { stdout } = await execFileAsync(
					"git",
					["ls-files", "--cached"],
					{ cwd: cloneDir },
				);
				fileCount = stdout.split("\n").filter(Boolean).length;
			} catch {
				// non-fatal
			}

			return {
				success: true,
				clonePath: cloneDir,
				commitHash,
				repository: `${owner}/${repo}`,
				file_count: fileCount,
			};
		}

		case "run": {
			// Agentic mode — delegate to runAgent (imported by caller)
			// This is handled separately in server.ts /api/tools/run route
			throw new Error(
				"Use /api/run for agentic execution, not /api/tools/run",
			);
		}

		default:
			throw new Error(`Unknown tool: ${rawToolId}`);
	}
}
