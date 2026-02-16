/**
 * Tool Executor — Direct workspace tool execution
 *
 * Implements workspace tools (read, write, edit, list, delete, mkdir,
 * execute-command) using the shared filesystem abstraction, bypassing
 * the LLM agent. Called by the function-router via POST /api/tools/{toolId}.
 *
 * In K8s mode, all file operations route through the sandbox pod's filesystem
 * (K8sRemoteFilesystem), ensuring files and commands share the same environment.
 * In local mode, operations use the local filesystem (LocalFilesystem).
 */

import {
	executeCommandViaSandbox,
	filesystem,
	sandbox,
} from "./sandbox-config";

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
			const content = await filesystem.readFile(args.path as string, {
				encoding: "utf-8",
			});
			return { content };
		}

		case "write-file": {
			await filesystem.writeFile(args.path as string, args.content as string, {
				recursive: true,
			});
			return { path: args.path as string };
		}

		case "edit-file": {
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
			return { path: args.path as string };
		}

		case "list-files": {
			const entries = await filesystem.readdir((args.path as string) || ".");
			const files = entries.map((e) => ({
				name: e.name,
				type: e.type,
			}));
			return { files };
		}

		case "execute-command": {
			const command = args.command as string;
			if (!command) throw new Error("command is required");
			return executeCommandViaSandbox(command, { timeout: 30_000 });
		}

		case "delete": {
			await filesystem.deleteFile(args.path as string, {
				recursive: true,
				force: true,
			});
			return { deleted: true };
		}

		case "mkdir": {
			await filesystem.mkdir(args.path as string, {
				recursive: true,
			});
			return { path: args.path as string };
		}

		case "file-stat": {
			const info = await filesystem.stat(args.path as string);
			return {
				size: info.size,
				isFile: info.type === "file",
				isDirectory: info.type === "directory",
				modified: info.modifiedAt.toISOString(),
				created: info.createdAt.toISOString(),
			};
		}

		case "clone": {
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
				await filesystem.deleteFile(cloneDir, {
					recursive: true,
					force: true,
				});
			}

			const repoUrl = token
				? `https://${token}@github.com/${owner}/${repo}.git`
				: `https://github.com/${owner}/${repo}.git`;

			// Try cloning inside the sandbox first (if git is available)
			const gitCheck = await executeCommandViaSandbox("which git", {
				timeout: 5_000,
			});
			const sandboxHasGit = gitCheck.exitCode === 0;

			let commitHash = "unknown";
			let fileCount = 0;

			if (sandboxHasGit) {
				// Clone directly in the sandbox
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
						cloneError instanceof Error
							? cloneError.message
							: String(cloneError);
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
			} else {
				// Sandbox lacks git — clone on host, then transfer via
				// filesystem (tar stream through exec)
				const { execFile: execFileCb } = await import("node:child_process");
				const { promisify } = await import("node:util");
				const { resolve, join } = await import("node:path");
				const { rm, existsSync } = await import("node:fs");
				const execFileAsync = promisify(execFileCb);

				const WORKSPACE = process.env.AGENT_WORKSPACE_PATH || "./workspace";
				const hostCloneDir = resolve(WORKSPACE, repo);

				// Clean up host dir
				const { rm: rmAsync } = await import("node:fs/promises");
				if ((await import("node:fs")).existsSync(hostCloneDir)) {
					await rmAsync(hostCloneDir, {
						recursive: true,
						force: true,
					});
				}

				try {
					await execFileAsync(
						"git",
						[
							"clone",
							"--depth",
							"1",
							"--branch",
							branch,
							repoUrl,
							hostCloneDir,
						],
						{
							env: {
								...process.env,
								GIT_TERMINAL_PROMPT: "0",
							},
							timeout: 120_000,
						},
					);
				} catch (cloneError) {
					const rawMsg =
						cloneError instanceof Error
							? cloneError.message
							: String(cloneError);
					const sanitized = token
						? rawMsg.replace(new RegExp(token, "g"), "***")
						: rawMsg;
					throw new Error(`git clone failed: ${sanitized}`);
				}

				// Get metadata from host
				try {
					const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
						cwd: hostCloneDir,
					});
					commitHash = stdout.trim();
				} catch {
					/* non-fatal */
				}
				try {
					const { stdout } = await execFileAsync(
						"git",
						["ls-files", "--cached"],
						{ cwd: hostCloneDir },
					);
					fileCount = stdout.split("\n").filter(Boolean).length;
				} catch {
					/* non-fatal */
				}

				// Transfer to sandbox via streaming HTTP upload (avoids OOM from large repos)
				try {
					const { execSync: execSyncTransfer } = await import(
						"node:child_process"
					);
					const { openAsBlob } = await import("node:fs");
					const { unlink: unlinkAsync } = await import("node:fs/promises");

					// Write tar to file on disk, excluding .git (saves ~25% size)
					const hostTmpTar = `/tmp/_clone_${Date.now()}.tar`;
					execSyncTransfer(
						`cd ${shellEscape(hostCloneDir)} && tar cf ${shellEscape(hostTmpTar)} --exclude=.git .`,
						{ timeout: 120_000 },
					);

					// Create target dir in sandbox
					await executeCommandViaSandbox(`mkdir -p ${shellEscape(cloneDir)}`);

					// Stream upload tar to sandbox via /upload endpoint
					// Uses openAsBlob for memory-efficient file-backed streaming (no readFileSync)
					const podIp = (sandbox as any).getSandboxPodIp?.() as string | null;
					if (!podIp) throw new Error("Sandbox pod not ready for upload");

					const fileBlob = await openAsBlob(hostTmpTar);
					const formData = new FormData();
					formData.append("file", fileBlob, "_clone_transfer.tar");

					const uploadRes = await fetch(`http://${podIp}:8888/upload`, {
						method: "POST",
						body: formData,
					});
					if (!uploadRes.ok) {
						const errText = await uploadRes.text();
						throw new Error(
							`Sandbox /upload returned ${uploadRes.status}: ${errText}`,
						);
					}

					// Extract tar in sandbox (uploaded to /app/_clone_transfer.tar)
					await executeCommandViaSandbox(
						`cd ${shellEscape(cloneDir)} && tar xf /app/_clone_transfer.tar && rm -f /app/_clone_transfer.tar`,
						{ timeout: 120_000 },
					);

					// Clean up host tar file
					try {
						await unlinkAsync(hostTmpTar);
					} catch {
						/* non-fatal */
					}
				} catch (transferErr) {
					throw new Error(
						`git clone succeeded but transfer to sandbox failed: ${transferErr instanceof Error ? transferErr.message : String(transferErr)}`,
					);
				}

				// Cleanup host
				try {
					await rmAsync(hostCloneDir, {
						recursive: true,
						force: true,
					});
				} catch {
					/* non-fatal */
				}
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
			throw new Error("Use /api/run for agentic execution, not /api/tools/run");
		}

		default:
			throw new Error(`Unknown tool: ${rawToolId}`);
	}
}

/** Escape a string for safe use inside single-quoted shell arguments. */
function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
