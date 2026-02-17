/**
 * Workspace session manager for execution-scoped workspaces.
 *
 * Each workflow execution can own a workspace session that carries:
 * - isolated filesystem + sandbox handles
 * - workspace tool policy (enabled tools, read-before-write)
 * - runtime bindings from durable workflow instance -> workspaceRef
 */

import { posix as pathPosix, resolve as pathResolve } from "node:path";
import { nanoid } from "nanoid";
import {
	changeArtifacts,
	type ChangeArtifactMetadata,
	type ChangeFileEntry,
	type ChangeFileStatus,
} from "./change-artifacts.js";
import { K8sRemoteFilesystem } from "./k8s-remote-filesystem.js";
import { K8sSandbox } from "./k8s-sandbox.js";
import {
	LocalFilesystem,
	LocalSandbox,
	SANDBOX_BACKEND,
	type Filesystem,
	type Sandbox,
} from "./sandbox-config.js";

const WORKSPACE_TOOL_NAMES = [
	"read_file",
	"write_file",
	"edit_file",
	"list_files",
	"delete_file",
	"mkdir",
	"file_stat",
	"execute_command",
	"clone",
] as const;

export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];

export type WorkspaceFileOperation = Exclude<
	WorkspaceToolName,
	"execute_command" | "clone"
>;

type WorkspaceSession = {
	workspaceRef: string;
	executionId: string;
	name: string;
	rootPath: string;
	backend: "k8s" | "local";
	sandbox: Sandbox;
	filesystem: Filesystem;
	enabledTools: Set<WorkspaceToolName>;
	requireReadBeforeWrite: boolean;
	commandTimeoutMs: number;
	readPaths: Set<string>;
	changeSequence: number;
	trackingGitDir?: string;
	createdAt: number;
	lastAccessedAt: number;
};

export type WorkspaceSandboxMetadata = {
	backend: "k8s" | "local";
	rootPath: string;
	workingDirectory: string;
	details: Record<string, unknown>;
};

export type WorkspaceProfileResult = {
	workspaceRef: string;
	executionId: string;
	name: string;
	rootPath: string;
	backend: "k8s" | "local";
	enabledTools: WorkspaceToolName[];
	requireReadBeforeWrite: boolean;
	commandTimeoutMs: number;
	createdAt: string;
	sandbox: WorkspaceSandboxMetadata;
};

export type WorkspaceChangeSummary = {
	changed: boolean;
	files: ChangeFileEntry[];
	stats: {
		files: number;
		additions: number;
		deletions: number;
	};
	patchRef?: string;
	patchSha256?: string;
	patchBytes?: number;
	truncatedInlinePatch?: boolean;
	inlinePatchPreview?: string;
	truncatedArtifact?: boolean;
	artifactOriginalBytes?: number;
	baseRevision?: string;
	headRevision?: string;
	trackingError?: string;
};

export type WorkspaceProfileInput = {
	executionId: string;
	name?: string;
	rootPath?: string;
	enabledTools?: string[];
	requireReadBeforeWrite?: boolean;
	commandTimeoutMs?: number;
};

export type ExecuteWorkspaceCommandInput = {
	workspaceRef?: string;
	executionId?: string;
	durableInstanceId?: string;
	command: string;
	timeoutMs?: number;
};

export type ExecuteWorkspaceFileInput = {
	workspaceRef?: string;
	executionId?: string;
	durableInstanceId?: string;
	operation: WorkspaceFileOperation;
	path?: string;
	content?: string;
	old_string?: string;
	new_string?: string;
};

export type ExecuteWorkspaceCloneInput = {
	workspaceRef?: string;
	executionId?: string;
	durableInstanceId?: string;
	repositoryOwner?: string;
	repositoryRepo?: string;
	repositoryBranch?: string;
	targetDir?: string;
	repositoryToken?: string;
	githubToken?: string;
	timeoutMs?: number;
};

const SESSION_TTL_MS = parseInt(
	process.env.WORKSPACE_SESSION_TTL_MS || `${30 * 60 * 1000}`,
	10,
);
const SWEEP_INTERVAL_MS = parseInt(
	process.env.WORKSPACE_SESSION_SWEEP_MS || `${60 * 1000}`,
	10,
);
const STRIP_CLONE_GIT_DIR =
	process.env.WORKSPACE_CLONE_STRIP_GIT_DIR !== "false";
const INLINE_PATCH_PREVIEW_BYTES = parseInt(
	process.env.WORKSPACE_INLINE_PATCH_PREVIEW_BYTES || "16384",
	10,
);

function sanitizeSegment(input: string): string {
	return input.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function normalizeToolName(input: string): WorkspaceToolName | null {
	if ((WORKSPACE_TOOL_NAMES as readonly string[]).includes(input)) {
		return input as WorkspaceToolName;
	}
	return null;
}

function normalizePathKey(input: string): string {
	return input.trim().replace(/\/+/g, "/");
}

function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

class WorkspaceSessionManager {
	private readonly sessions = new Map<string, WorkspaceSession>();
	private readonly executionToWorkspace = new Map<string, string>();
	private readonly durableInstanceToWorkspace = new Map<string, string>();
	private readonly defaultRoot =
		process.env.WORKSPACE_SESSIONS_ROOT ||
		(SANDBOX_BACKEND === "k8s" ? "/app/workspaces" : "./workspace-runs");

	constructor() {
		const timer = setInterval(() => {
			void this.sweepExpired();
		}, SWEEP_INTERVAL_MS);
		timer.unref();
	}

	getStats(): { activeWorkspaces: number; mappedInstances: number } {
		return {
			activeWorkspaces: this.sessions.size,
			mappedInstances: this.durableInstanceToWorkspace.size,
		};
	}

	async ensureChangeArtifactPersistence(): Promise<void> {
		await changeArtifacts.ensureReady();
	}

	async getChangeArtifact(changeSetId: string): Promise<{
		metadata: ChangeArtifactMetadata;
		patch: string;
	} | null> {
		const id = changeSetId.trim();
		if (!id) return null;
		return await changeArtifacts.get(id);
	}

	async listChangeArtifactsByExecutionId(
		executionId: string,
	): Promise<ChangeArtifactMetadata[]> {
		const id = executionId.trim();
		if (!id) return [];
		return await changeArtifacts.listByExecutionId(id);
	}

	async getExecutionPatch(
		executionId: string,
		opts?: { durableInstanceId?: string },
	): Promise<{ patch: string; changeSets: ChangeArtifactMetadata[] }> {
		const id = executionId.trim();
		if (!id) {
			return { patch: "", changeSets: [] };
		}
		return await changeArtifacts.getExecutionPatch(id, opts);
	}

	getWorkspaceRefByExecutionId(executionId: string): string | null {
		const ref = this.executionToWorkspace.get(executionId);
		return ref ?? null;
	}

	resolveSessionFromArgs(
		args: Record<string, unknown>,
	): WorkspaceSession | null {
		const workspaceRef =
			typeof args.workspaceRef === "string" && args.workspaceRef.trim()
				? args.workspaceRef.trim()
				: undefined;
		if (workspaceRef) {
			return this.getByWorkspaceRef(workspaceRef);
		}

		const instanceId =
			typeof args.__durable_instance_id === "string" &&
			args.__durable_instance_id.trim()
				? args.__durable_instance_id.trim()
				: undefined;
		if (instanceId) {
			const mappedRef = this.durableInstanceToWorkspace.get(instanceId);
			if (mappedRef) {
				return this.getByWorkspaceRef(mappedRef);
			}
		}

		const executionId =
			typeof args.executionId === "string" && args.executionId.trim()
				? args.executionId.trim()
				: undefined;
		if (executionId) {
			const ref = this.executionToWorkspace.get(executionId);
			if (ref) {
				return this.getByWorkspaceRef(ref);
			}
		}

		return null;
	}

	getByWorkspaceRef(workspaceRef: string): WorkspaceSession | null {
		const session = this.sessions.get(workspaceRef);
		if (!session) return null;
		this.touch(session);
		return session;
	}

	bindDurableInstance(instanceId: string, workspaceRef: string): void {
		if (!instanceId || !workspaceRef) return;
		if (!this.sessions.has(workspaceRef)) return;
		this.durableInstanceToWorkspace.set(instanceId, workspaceRef);
	}

	unbindDurableInstance(instanceId: string): void {
		if (!instanceId) return;
		this.durableInstanceToWorkspace.delete(instanceId);
	}

	async createOrGetProfile(
		input: WorkspaceProfileInput,
	): Promise<WorkspaceProfileResult> {
		const executionId = String(input.executionId || "").trim();
		if (!executionId) {
			throw new Error("executionId is required");
		}

		const existingRef = this.executionToWorkspace.get(executionId);
		if (existingRef) {
			const existing = this.sessions.get(existingRef);
			if (existing) {
				this.touch(existing);
				return this.serialize(existing);
			}
			this.executionToWorkspace.delete(executionId);
		}

		const rootPath = this.resolveRootPath(executionId, input.rootPath);
		const session = await this.createSession({
			executionId,
			name: input.name?.trim() || `workspace-${executionId}`,
			rootPath,
			enabledTools: input.enabledTools,
			requireReadBeforeWrite: Boolean(input.requireReadBeforeWrite),
			commandTimeoutMs:
				typeof input.commandTimeoutMs === "number" && input.commandTimeoutMs > 0
					? Math.floor(input.commandTimeoutMs)
					: parseInt(process.env.SANDBOX_TIMEOUT_MS || "30000", 10),
		});

		this.sessions.set(session.workspaceRef, session);
		this.executionToWorkspace.set(executionId, session.workspaceRef);
		return this.serialize(session);
	}

	async executeCommand(input: ExecuteWorkspaceCommandInput): Promise<{
		stdout: string;
		stderr: string;
		exitCode: number;
		success: boolean;
		executionTimeMs: number;
		timedOut?: boolean;
		sandbox: WorkspaceSandboxMetadata;
		changeSummary?: WorkspaceChangeSummary;
	}> {
		const session = this.resolveFromInput(
			input.workspaceRef,
			input.executionId,
		);
		this.assertEnabled(session, "execute_command");

		const timeoutMs =
			typeof input.timeoutMs === "number" && input.timeoutMs > 0
				? Math.floor(input.timeoutMs)
				: session.commandTimeoutMs;
		const command = String(input.command || "").trim();
		if (!command) {
			throw new Error("command is required");
		}

		const result = await session.sandbox.executeCommand(command, undefined, {
			timeout: timeoutMs,
			cwd: session.rootPath,
		});

		const changeSummary = await this.captureWorkspaceChangeSummary({
			session,
			operation: "execute_command",
			durableInstanceId: input.durableInstanceId,
			includeInExecutionPatch: true,
		});

		this.touch(session);
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode,
			success: result.success,
			executionTimeMs: result.executionTimeMs,
			timedOut: result.timedOut,
			sandbox: this.buildSandboxMetadata(session),
			...(changeSummary ? { changeSummary } : {}),
		};
	}

	async cloneRepository(
		input: ExecuteWorkspaceCloneInput,
	): Promise<Record<string, unknown>> {
		const session = this.resolveFromInput(
			input.workspaceRef,
			input.executionId,
		);
		this.assertEnabled(session, "clone");

		const owner = String(input.repositoryOwner || "").trim();
		const repo = String(input.repositoryRepo || "").trim();
		const branch = String(input.repositoryBranch || "main").trim() || "main";
		const token =
			String(input.repositoryToken || "").trim() ||
			String(input.githubToken || "").trim();

		if (!owner || !repo) {
			throw new Error("repositoryOwner and repositoryRepo are required");
		}

		const cloneDir = this.resolveCloneTargetDir(
			repo,
			String(input.targetDir || "").trim(),
		);
		const timeoutMs =
			typeof input.timeoutMs === "number" && input.timeoutMs > 0
				? Math.floor(input.timeoutMs)
				: Math.max(session.commandTimeoutMs, 120_000);

		const dirExists = await session.filesystem.exists(cloneDir);
		if (dirExists) {
			await session.filesystem.deleteFile(cloneDir, {
				recursive: true,
				force: true,
			});
		}

		const repoUrl = token
			? `https://${token}@github.com/${owner}/${repo}.git`
			: `https://github.com/${owner}/${repo}.git`;

		const gitCheck = await session.sandbox.executeCommand(
			"command -v git",
			undefined,
			{
				timeout: Math.min(timeoutMs, 15_000),
				cwd: session.rootPath,
			},
		);
		let commitHash = "unknown";
		let fileCount = 0;
		if (!gitCheck.success || gitCheck.exitCode !== 0) {
			throw new Error(
				"git is not installed in the sandbox runtime. Update the production SandboxTemplate image.",
			);
		}

		const cloneResult = await session.sandbox.executeCommand(
			`GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch ${shellEscape(branch)} ${shellEscape(repoUrl)} ${shellEscape(cloneDir)}`,
			undefined,
			{
				timeout: timeoutMs,
				cwd: session.rootPath,
			},
		);
		if (!cloneResult.success || cloneResult.exitCode !== 0) {
			const stderr = cloneResult.stderr || "unknown clone error";
			const sanitized = token ? stderr.replaceAll(token, "***") : stderr;
			throw new Error(`git clone failed: ${sanitized}`);
		}

		const revParse = await session.sandbox.executeCommand(
			`cd ${shellEscape(cloneDir)} && git rev-parse HEAD`,
			undefined,
			{
				timeout: timeoutMs,
				cwd: session.rootPath,
			},
		);
		if (revParse.success && revParse.exitCode === 0) {
			commitHash = revParse.stdout.trim();
		}

		const lsFiles = await session.sandbox.executeCommand(
			`cd ${shellEscape(cloneDir)} && git ls-files --cached`,
			undefined,
			{
				timeout: timeoutMs,
				cwd: session.rootPath,
			},
		);
		if (lsFiles.success && lsFiles.exitCode === 0) {
			fileCount = lsFiles.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean).length;
		}
		let strippedGitDir = false;
		if (STRIP_CLONE_GIT_DIR) {
			const stripGit = await session.sandbox.executeCommand(
				`rm -rf ${shellEscape(pathPosix.join(cloneDir, ".git"))}`,
				undefined,
				{
					timeout: timeoutMs,
					cwd: session.rootPath,
				},
			);
			if (!stripGit.success || stripGit.exitCode !== 0) {
				throw new Error(
					`failed to strip clone git metadata in ${cloneDir}: ${stripGit.stderr || "unknown error"}`,
				);
			}
			strippedGitDir = true;
		}

		const changeSummary = await this.captureWorkspaceChangeSummary({
			session,
			operation: "clone",
			durableInstanceId: input.durableInstanceId,
			includeInExecutionPatch: false,
		});

		this.touch(session);
		return {
			success: true,
			clonePath: cloneDir,
			repository: `${owner}/${repo}`,
			branch,
			commitHash,
			fileCount,
			gitMetadataStripped: strippedGitDir,
			sandbox: this.buildSandboxMetadata(session),
			...(changeSummary ? { changeSummary } : {}),
		};
	}

	async executeFileOperation(
		input: ExecuteWorkspaceFileInput,
	): Promise<Record<string, unknown>> {
		const session = this.resolveFromInput(
			input.workspaceRef,
			input.executionId,
		);
		const operation = input.operation;
		this.assertEnabled(session, operation);

		switch (operation) {
			case "read_file": {
				const path = this.requirePath(input.path, operation);
				const content = await session.filesystem.readFile(path, {
					encoding: "utf-8",
				});
				session.readPaths.add(normalizePathKey(path));
				this.touch(session);
				return { content: String(content) };
			}

			case "write_file": {
				const path = this.requirePath(input.path, operation);
				await this.enforceReadBeforeWrite(session, path);
				await session.filesystem.writeFile(path, String(input.content ?? ""), {
					recursive: true,
				});
				const changeSummary = await this.captureWorkspaceChangeSummary({
					session,
					operation: "write_file",
					durableInstanceId: input.durableInstanceId,
					includeInExecutionPatch: true,
				});
				this.touch(session);
				return { path, ...(changeSummary ? { changeSummary } : {}) };
			}

			case "edit_file": {
				const path = this.requirePath(input.path, operation);
				await this.enforceReadBeforeWrite(session, path);
				const oldStr = String(input.old_string ?? "");
				const newStr = String(input.new_string ?? "");
				if (!oldStr) throw new Error("old_string is required for edit_file");
				const original = await session.filesystem.readFile(path, {
					encoding: "utf-8",
				});
				const originalText = String(original);
				if (!originalText.includes(oldStr)) {
					throw new Error(`old_string not found in ${path}`);
				}
				await session.filesystem.writeFile(
					path,
					originalText.replace(oldStr, newStr),
				);
				const changeSummary = await this.captureWorkspaceChangeSummary({
					session,
					operation: "edit_file",
					durableInstanceId: input.durableInstanceId,
					includeInExecutionPatch: true,
				});
				this.touch(session);
				return { path, ...(changeSummary ? { changeSummary } : {}) };
			}

			case "list_files": {
				const path = String(input.path || ".").trim() || ".";
				const entries = await session.filesystem.readdir(path);
				this.touch(session);
				return {
					files: entries.map((e) => ({ name: e.name, type: e.type })),
				};
			}

			case "delete_file": {
				const path = this.requirePath(input.path, operation);
				await session.filesystem.deleteFile(path, {
					recursive: true,
					force: true,
				});
				const changeSummary = await this.captureWorkspaceChangeSummary({
					session,
					operation: "delete_file",
					durableInstanceId: input.durableInstanceId,
					includeInExecutionPatch: true,
				});
				this.touch(session);
				return {
					deleted: true,
					path,
					...(changeSummary ? { changeSummary } : {}),
				};
			}

			case "mkdir": {
				const path = this.requirePath(input.path, operation);
				await session.filesystem.mkdir(path, { recursive: true });
				const changeSummary = await this.captureWorkspaceChangeSummary({
					session,
					operation: "mkdir",
					durableInstanceId: input.durableInstanceId,
					includeInExecutionPatch: true,
				});
				this.touch(session);
				return { path, ...(changeSummary ? { changeSummary } : {}) };
			}

			case "file_stat": {
				const path = this.requirePath(input.path, operation);
				const info = await session.filesystem.stat(path);
				this.touch(session);
				return {
					size: info.size,
					isFile: info.type === "file",
					isDirectory: info.type === "directory",
					modified: info.modifiedAt.toISOString(),
					created: info.createdAt.toISOString(),
				};
			}
		}
	}

	async cleanupByExecutionId(executionId: string): Promise<string[]> {
		const id = executionId.trim();
		if (!id) return [];
		const ref = this.executionToWorkspace.get(id);
		if (!ref) return [];
		await this.cleanupByWorkspaceRef(ref);
		return [ref];
	}

	async cleanupByWorkspaceRef(workspaceRef: string): Promise<boolean> {
		const ref = workspaceRef.trim();
		if (!ref) return false;
		const session = this.sessions.get(ref);
		if (!session) return false;

		this.sessions.delete(ref);
		this.executionToWorkspace.delete(session.executionId);
		for (const [instanceId, mappedRef] of this.durableInstanceToWorkspace) {
			if (mappedRef === ref) {
				this.durableInstanceToWorkspace.delete(instanceId);
			}
		}

		if (session.trackingGitDir) {
			try {
				await session.sandbox.executeCommand(
					`rm -rf ${shellEscape(session.trackingGitDir)}`,
					undefined,
					{
						timeout: Math.max(session.commandTimeoutMs, 10_000),
						cwd: session.rootPath,
					},
				);
			} catch (err) {
				console.warn(
					`[workspace-sessions] Failed to remove tracking repo ${session.trackingGitDir}:`,
					err,
				);
			}
		}

		try {
			await session.sandbox.destroy();
		} catch (err) {
			console.warn(
				`[workspace-sessions] Failed to destroy sandbox ${ref}:`,
				err,
			);
		}

		return true;
	}

	async destroyAll(): Promise<void> {
		const refs = [...this.sessions.keys()];
		for (const ref of refs) {
			await this.cleanupByWorkspaceRef(ref);
		}
	}

	private async createSession(input: {
		executionId: string;
		name: string;
		rootPath: string;
		enabledTools?: string[];
		requireReadBeforeWrite: boolean;
		commandTimeoutMs: number;
	}): Promise<WorkspaceSession> {
		let sandbox: Sandbox;
		let filesystem: Filesystem;

		if (SANDBOX_BACKEND === "k8s") {
			const k8sSandbox = new K8sSandbox({
				workingDirectory: input.rootPath,
				timeout: input.commandTimeoutMs,
			});
			await k8sSandbox.start();
			sandbox = k8sSandbox;
			filesystem = new K8sRemoteFilesystem({
				sandbox: k8sSandbox,
				basePath: input.rootPath,
				timeout: input.commandTimeoutMs,
			});
		} else {
			const localSandbox = new LocalSandbox(
				input.rootPath,
				input.commandTimeoutMs,
			);
			await localSandbox.start();
			sandbox = localSandbox;
			filesystem = new LocalFilesystem(input.rootPath);
		}

		await filesystem.mkdir(".", { recursive: true });

		const trackingGitDir = await this.initializeTrackingRepository({
			sandbox,
			rootPath: input.rootPath,
			executionId: input.executionId,
		});

		const enabledTools = new Set<WorkspaceToolName>();
		if (Array.isArray(input.enabledTools) && input.enabledTools.length > 0) {
			for (const t of input.enabledTools) {
				const normalized = normalizeToolName(String(t).trim());
				if (normalized) {
					enabledTools.add(normalized);
				}
			}
		}
		if (enabledTools.size === 0) {
			for (const t of WORKSPACE_TOOL_NAMES) enabledTools.add(t);
		}

		const now = Date.now();
		return {
			workspaceRef: `ws_${nanoid(12)}`,
			executionId: input.executionId,
			name: input.name,
			rootPath: input.rootPath,
			backend: SANDBOX_BACKEND === "k8s" ? "k8s" : "local",
			sandbox,
			filesystem,
			enabledTools,
			requireReadBeforeWrite: input.requireReadBeforeWrite,
			commandTimeoutMs: input.commandTimeoutMs,
			readPaths: new Set<string>(),
			changeSequence: 0,
			trackingGitDir: trackingGitDir ?? undefined,
			createdAt: now,
			lastAccessedAt: now,
		};
	}

	private async initializeTrackingRepository(input: {
		sandbox: Sandbox;
		rootPath: string;
		executionId: string;
	}): Promise<string | null> {
		const gitDir = `/tmp/wb-change-tracker-${sanitizeSegment(input.executionId)}-${nanoid(8)}.git`;
		const initCmd = [
			`mkdir -p ${shellEscape(gitDir)}`,
			`GIT_DIR=${shellEscape(gitDir)} GIT_WORK_TREE=${shellEscape(input.rootPath)} git init -q`,
			`GIT_DIR=${shellEscape(gitDir)} GIT_WORK_TREE=${shellEscape(input.rootPath)} git config user.email ${shellEscape("workspace-tracker@local")}`,
			`GIT_DIR=${shellEscape(gitDir)} GIT_WORK_TREE=${shellEscape(input.rootPath)} git config user.name ${shellEscape("Workspace Tracker")}`,
			`GIT_DIR=${shellEscape(gitDir)} GIT_WORK_TREE=${shellEscape(input.rootPath)} git add -A .`,
			`GIT_DIR=${shellEscape(gitDir)} GIT_WORK_TREE=${shellEscape(input.rootPath)} git commit -q --allow-empty -m ${shellEscape("workspace baseline")}`,
		].join(" && ");

		const result = await input.sandbox.executeCommand(initCmd, undefined, {
			timeout: 60_000,
			cwd: input.rootPath,
		});
		if (!result.success || result.exitCode !== 0) {
			console.warn(
				`[workspace-sessions] Change tracking disabled (execution=${input.executionId}): ${result.stderr || "git init failed"}`,
			);
			return null;
		}
		return gitDir;
	}

	private async runTrackingGit(
		session: WorkspaceSession,
		command: string,
		timeoutMs = Math.max(session.commandTimeoutMs, 60_000),
	): Promise<{
		success: boolean;
		exitCode: number;
		stdout: string;
		stderr: string;
	}> {
		if (!session.trackingGitDir) {
			return {
				success: false,
				exitCode: 1,
				stdout: "",
				stderr: "tracking repository not initialized",
			};
		}
		const wrapped = `GIT_DIR=${shellEscape(session.trackingGitDir)} GIT_WORK_TREE=${shellEscape(session.rootPath)} ${command}`;
		const result = await session.sandbox.executeCommand(wrapped, undefined, {
			timeout: timeoutMs,
			cwd: session.rootPath,
		});
		return {
			success: result.success,
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
		};
	}

	private async snapshotTrackingBaseline(
		session: WorkspaceSession,
		operation: string,
	): Promise<void> {
		if (!session.trackingGitDir) return;
		const add = await this.runTrackingGit(session, "git add -A .");
		if (!add.success || add.exitCode !== 0) return;
		const commit = await this.runTrackingGit(
			session,
			`git commit -q --allow-empty -m ${shellEscape(`snapshot:${operation}:${session.changeSequence + 1}`)}`,
		);
		if (commit.success && commit.exitCode === 0) {
			session.changeSequence += 1;
		}
	}

	private parseNameStatusOutput(raw: string): ChangeFileEntry[] {
		const files: ChangeFileEntry[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const parts = trimmed.split("\t");
			if (parts.length < 2) continue;
			const rawStatus = parts[0].trim().toUpperCase();
			const first = rawStatus.charAt(0);
			const status: ChangeFileStatus =
				first === "A" || first === "D" || first === "R" ? first : "M";
			const path = status === "R" ? parts[2] || parts[1] : parts[1];
			files.push({ path, status });
		}
		return files;
	}

	private parseNumStatOutput(raw: string): {
		additions: number;
		deletions: number;
	} {
		let additions = 0;
		let deletions = 0;
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const parts = trimmed.split("\t");
			if (parts.length < 3) continue;
			const add = Number.parseInt(parts[0], 10);
			const del = Number.parseInt(parts[1], 10);
			if (Number.isFinite(add)) additions += add;
			if (Number.isFinite(del)) deletions += del;
		}
		return { additions, deletions };
	}

	private buildChangeSummaryFromArtifact(
		metadata: ChangeArtifactMetadata,
		patch: string,
	): WorkspaceChangeSummary {
		const preview = patch.slice(0, INLINE_PATCH_PREVIEW_BYTES);
		return {
			changed: metadata.filesChanged > 0,
			files: metadata.files,
			stats: {
				files: metadata.filesChanged,
				additions: metadata.additions,
				deletions: metadata.deletions,
			},
			patchRef: metadata.changeSetId,
			patchSha256: metadata.sha256,
			patchBytes: metadata.bytes,
			truncatedInlinePatch: patch.length > INLINE_PATCH_PREVIEW_BYTES,
			inlinePatchPreview: preview,
			truncatedArtifact: metadata.truncated,
			artifactOriginalBytes: metadata.originalBytes,
			baseRevision: metadata.baseRevision,
			headRevision: metadata.headRevision,
		};
	}

	private async captureWorkspaceChangeSummary(input: {
		session: WorkspaceSession;
		operation: string;
		durableInstanceId?: string;
		includeInExecutionPatch: boolean;
	}): Promise<WorkspaceChangeSummary | undefined> {
		const session = input.session;
		if (!session.trackingGitDir) {
			return {
				changed: false,
				files: [],
				stats: { files: 0, additions: 0, deletions: 0 },
				trackingError:
					"Workspace change tracking is unavailable (git tracker not initialized)",
			};
		}

		try {
			const baseRevision = await this.getTrackingHeadRevision(session);

			const stage = await this.runTrackingGit(session, "git add -A .");
			if (!stage.success || stage.exitCode !== 0) {
				throw new Error(stage.stderr || "git add failed");
			}

			const patchResult = await this.runTrackingGit(
				session,
				"git diff --cached --binary --full-index --no-color --patch HEAD",
			);
			if (!patchResult.success || patchResult.exitCode !== 0) {
				throw new Error(patchResult.stderr || "git diff failed");
			}

			const patch = patchResult.stdout;
			if (!patch.trim()) {
				return {
					changed: false,
					files: [],
					stats: { files: 0, additions: 0, deletions: 0 },
				};
			}

			const statusResult = await this.runTrackingGit(
				session,
				"git diff --cached --name-status --find-renames HEAD",
			);
			const files = this.parseNameStatusOutput(statusResult.stdout);

			const numStatResult = await this.runTrackingGit(
				session,
				"git diff --cached --numstat HEAD",
			);
			const stats = this.parseNumStatOutput(numStatResult.stdout);

			const commitResult = await this.runTrackingGit(
				session,
				`git commit -q --allow-empty -m ${shellEscape(`change:${input.operation}:${session.changeSequence + 1}`)}`,
			);
			if (!commitResult.success || commitResult.exitCode !== 0) {
				throw new Error(commitResult.stderr || "git commit failed");
			}
			session.changeSequence += 1;
			const headRevision = await this.getTrackingHeadRevision(session);

			const metadata = await changeArtifacts.save({
				executionId: session.executionId,
				workspaceRef: session.workspaceRef,
				durableInstanceId: input.durableInstanceId,
				operation: input.operation,
				sequence: session.changeSequence,
				patch,
				files,
				additions: stats.additions,
				deletions: stats.deletions,
				includeInExecutionPatch: input.includeInExecutionPatch,
				baseRevision: baseRevision || undefined,
				headRevision: headRevision || undefined,
			});

			return this.buildChangeSummaryFromArtifact(metadata, patch);
		} catch (err) {
			return {
				changed: false,
				files: [],
				stats: { files: 0, additions: 0, deletions: 0 },
				trackingError: err instanceof Error ? err.message : String(err),
			};
		}
	}

	private async getTrackingHeadRevision(
		session: WorkspaceSession,
	): Promise<string | null> {
		const revision = await this.runTrackingGit(session, "git rev-parse HEAD");
		if (!revision.success || revision.exitCode !== 0) {
			return null;
		}
		const value = revision.stdout.trim();
		return value || null;
	}

	private resolveFromInput(
		workspaceRef?: string,
		executionId?: string,
	): WorkspaceSession {
		if (workspaceRef) {
			const byRef = this.sessions.get(workspaceRef.trim());
			if (byRef) {
				this.touch(byRef);
				return byRef;
			}
		}

		if (executionId) {
			const ref = this.executionToWorkspace.get(executionId.trim());
			if (ref) {
				const byExecution = this.sessions.get(ref);
				if (byExecution) {
					this.touch(byExecution);
					return byExecution;
				}
			}
		}

		throw new Error(
			"Workspace session not found (provide workspaceRef or executionId)",
		);
	}

	private resolveRootPath(executionId: string, requested?: string): string {
		const requestedPath = String(requested || "").trim();
		if (SANDBOX_BACKEND === "k8s") {
			const base = this.defaultRoot.startsWith("/")
				? this.defaultRoot
				: pathPosix.join("/app", this.defaultRoot);
			if (requestedPath) {
				if (requestedPath.startsWith("/")) return requestedPath;
				return pathPosix.join(base, sanitizeSegment(requestedPath));
			}
			return pathPosix.join(base, sanitizeSegment(executionId));
		}

		const base = pathResolve(this.defaultRoot);
		if (requestedPath) {
			if (requestedPath.startsWith("/")) return requestedPath;
			return pathResolve(base, requestedPath);
		}
		return pathResolve(base, sanitizeSegment(executionId));
	}

	private serialize(session: WorkspaceSession): WorkspaceProfileResult {
		return {
			workspaceRef: session.workspaceRef,
			executionId: session.executionId,
			name: session.name,
			rootPath: session.rootPath,
			backend: session.backend,
			enabledTools: [...session.enabledTools],
			requireReadBeforeWrite: session.requireReadBeforeWrite,
			commandTimeoutMs: session.commandTimeoutMs,
			createdAt: new Date(session.createdAt).toISOString(),
			sandbox: this.buildSandboxMetadata(session),
		};
	}

	private resolveCloneTargetDir(repo: string, targetDir?: string): string {
		const candidate = (targetDir || repo).trim();
		if (!candidate) {
			throw new Error("targetDir could not be resolved");
		}

		const normalized = pathPosix.normalize(candidate);
		if (
			!normalized ||
			normalized === "." ||
			normalized.startsWith("..") ||
			pathPosix.isAbsolute(normalized)
		) {
			throw new Error(
				"targetDir must be a relative path inside workspace root",
			);
		}

		return normalized.replace(/^\.\/+/, "");
	}

	private assertEnabled(
		session: WorkspaceSession,
		toolName: WorkspaceToolName,
	): void {
		if (!session.enabledTools.has(toolName)) {
			throw new Error(
				`Tool "${toolName}" is disabled for workspace ${session.workspaceRef}`,
			);
		}
	}

	private requirePath(
		path: string | undefined,
		operation: WorkspaceFileOperation,
	): string {
		const normalized = String(path || "").trim();
		if (!normalized) {
			throw new Error(`path is required for ${operation}`);
		}
		return normalized;
	}

	private async enforceReadBeforeWrite(
		session: WorkspaceSession,
		path: string,
	): Promise<void> {
		if (!session.requireReadBeforeWrite) return;
		const normalizedPath = normalizePathKey(path);
		const exists = await session.filesystem.exists(path);
		if (!exists) return;
		if (!session.readPaths.has(normalizedPath)) {
			throw new Error(
				`Write blocked by read-before-write policy for "${path}" in workspace ${session.workspaceRef}`,
			);
		}
	}

	private touch(session: WorkspaceSession): void {
		session.lastAccessedAt = Date.now();
	}

	private buildSandboxMetadata(
		session: WorkspaceSession,
	): WorkspaceSandboxMetadata {
		const workingDirectory =
			session.backend === "k8s" && session.sandbox instanceof K8sSandbox
				? session.sandbox.workingDirectory
				: session.rootPath;
		return {
			backend: session.backend,
			rootPath: session.rootPath,
			workingDirectory,
			details: session.sandbox.getDebugInfo?.() ?? {},
		};
	}

	private async sweepExpired(): Promise<void> {
		const now = Date.now();
		for (const [workspaceRef, session] of this.sessions) {
			if (now - session.lastAccessedAt <= SESSION_TTL_MS) continue;
			await this.cleanupByWorkspaceRef(workspaceRef);
		}
	}
}

export const workspaceSessions = new WorkspaceSessionManager();
