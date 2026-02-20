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
	type ChangeArtifactFileSnapshotInput,
	type ChangeArtifactMetadata,
	type ChangeFileEntry,
	type ChangeFileStatus,
	type ExecutionFileSnapshot,
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
import {
	workspaceSessionStore,
	type PersistedWorkspaceSession,
} from "./workspace-session-store.js";

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
	clonePath?: string;
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
	clonePath?: string;
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
	repositoryUrl?: string;
	repositoryOwner?: string;
	repositoryRepo?: string;
	repositoryBranch: string;
	repositoryUsername?: string;
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

function isNoFileChangesReviewResult(input: {
	success: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
}): boolean {
	if (input.success || input.exitCode !== 2) {
		return false;
	}
	const text = `${input.stdout}\n${input.stderr}`.toLowerCase();
	return text.includes("no file changes detected after durable run");
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

	async getExecutionFileSnapshot(
		executionId: string,
		path: string,
		opts?: { durableInstanceId?: string },
	): Promise<ExecutionFileSnapshot | null> {
		const id = executionId.trim();
		const targetPath = path.trim();
		if (!id || !targetPath) {
			return null;
		}
		return await changeArtifacts.getExecutionFileSnapshot(id, targetPath, opts);
	}

	getWorkspaceRefByExecutionId(executionId: string): string | null {
		const ref = this.executionToWorkspace.get(executionId.trim());
		return ref ?? null;
	}

	async getWorkspaceRefByExecutionIdDurable(
		executionId: string,
	): Promise<string | null> {
		const normalized = executionId.trim();
		if (!normalized) return null;
		const inMemory = this.executionToWorkspace.get(normalized);
		if (inMemory) return inMemory;
		try {
			const persisted =
				await workspaceSessionStore.getByExecutionId(normalized);
			if (persisted) {
				return persisted.workspaceRef;
			}
		} catch (err) {
			console.warn(
				`[workspace-sessions] Failed loading workspace by executionId=${normalized}:`,
				err,
			);
		}
		return null;
	}

	async resolveSessionFromArgs(
		args: Record<string, unknown>,
	): Promise<WorkspaceSession | null> {
		const workspaceRef =
			typeof args.workspaceRef === "string" && args.workspaceRef.trim()
				? args.workspaceRef.trim()
				: undefined;
		if (workspaceRef) {
			return await this.getByWorkspaceRefDurable(workspaceRef);
		}

		const instanceId =
			typeof args.__durable_instance_id === "string" &&
			args.__durable_instance_id.trim()
				? args.__durable_instance_id.trim()
				: undefined;
		if (instanceId) {
			const mappedRef = this.durableInstanceToWorkspace.get(instanceId);
			if (mappedRef) {
				return await this.getByWorkspaceRefDurable(mappedRef);
			}
			try {
				const persistedByInstance =
					await workspaceSessionStore.getByDurableInstanceId(instanceId);
				if (persistedByInstance) {
					return await this.getByWorkspaceRefDurable(
						persistedByInstance.workspaceRef,
					);
				}
			} catch (err) {
				console.warn(
					`[workspace-sessions] Failed loading workspace by durable instance ${instanceId}:`,
					err,
				);
			}
		}

		const executionId =
			typeof args.executionId === "string" && args.executionId.trim()
				? args.executionId.trim()
				: undefined;
		if (executionId) {
			const ref = this.executionToWorkspace.get(executionId);
			if (ref) {
				return await this.getByWorkspaceRefDurable(ref);
			}
			try {
				const persistedByExecution =
					await workspaceSessionStore.getByExecutionId(executionId);
				if (persistedByExecution) {
					return await this.getByWorkspaceRefDurable(
						persistedByExecution.workspaceRef,
					);
				}
			} catch (err) {
				console.warn(
					`[workspace-sessions] Failed loading workspace by execution ${executionId}:`,
					err,
				);
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

	async getByWorkspaceRefDurable(
		workspaceRef: string,
	): Promise<WorkspaceSession | null> {
		const normalized = workspaceRef.trim();
		if (!normalized) return null;
		const inMemory = this.sessions.get(normalized);
		if (inMemory) {
			this.touch(inMemory);
			return inMemory;
		}
		try {
			const persisted =
				await workspaceSessionStore.getByWorkspaceRef(normalized);
			if (!persisted) return null;
			return await this.hydrateFromPersisted(persisted);
		} catch (err) {
			console.warn(
				`[workspace-sessions] Failed hydrating workspaceRef=${normalized}:`,
				err,
			);
			return null;
		}
	}

	async bindDurableInstance(
		instanceId: string,
		workspaceRef: string,
	): Promise<void> {
		if (!instanceId || !workspaceRef) return;
		if (!this.sessions.has(workspaceRef)) return;
		this.durableInstanceToWorkspace.set(instanceId, workspaceRef);
		try {
			await workspaceSessionStore.markDurableInstance(workspaceRef, instanceId);
		} catch (err) {
			console.warn(
				`[workspace-sessions] Failed persisting durable binding ${instanceId} -> ${workspaceRef}:`,
				err,
			);
		}
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
		try {
			const persisted =
				await workspaceSessionStore.getByExecutionId(executionId);
			if (persisted) {
				const hydrated = await this.hydrateFromPersisted(persisted);
				if (hydrated) {
					return this.serialize(hydrated);
				}
			}
		} catch (err) {
			console.warn(
				`[workspace-sessions] Failed hydrating persisted profile for execution=${executionId}:`,
				err,
			);
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
		try {
			await workspaceSessionStore.upsert({
				workspaceRef: session.workspaceRef,
				workflowExecutionId: executionId,
				name: session.name,
				rootPath: session.rootPath,
				backend: session.backend,
				enabledTools: [...session.enabledTools],
				requireReadBeforeWrite: session.requireReadBeforeWrite,
				commandTimeoutMs: session.commandTimeoutMs,
				status: "active",
			});
		} catch (err) {
			console.warn(
				`[workspace-sessions] Failed persisting workspace session ${session.workspaceRef}:`,
				err,
			);
		}
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
		const session = await this.resolveFromInput(
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
		const commandCwd = session.clonePath || session.rootPath;

		const result = await session.sandbox.executeCommand(command, undefined, {
			timeout: timeoutMs,
			cwd: commandCwd,
		});
		const normalized = isNoFileChangesReviewResult(result)
			? {
					...result,
					success: true,
					exitCode: 0,
					stderr: "",
				}
			: result;

		const changeSummary = await this.captureWorkspaceChangeSummary({
			session,
			operation: "execute_command",
			durableInstanceId: input.durableInstanceId,
			includeInExecutionPatch: true,
		});

		this.touch(session);
		return {
			stdout: normalized.stdout,
			stderr: normalized.stderr,
			exitCode: normalized.exitCode,
			success: normalized.success,
			executionTimeMs: normalized.executionTimeMs,
			timedOut: normalized.timedOut,
			sandbox: this.buildSandboxMetadata(session),
			...(changeSummary ? { changeSummary } : {}),
		};
	}

	async cloneRepository(
		input: ExecuteWorkspaceCloneInput,
	): Promise<Record<string, unknown>> {
		const session = await this.resolveFromInput(
			input.workspaceRef,
			input.executionId,
		);
		this.assertEnabled(session, "clone");

		const repositoryUrl = String(input.repositoryUrl || "").trim();
		const owner = String(input.repositoryOwner || "").trim();
		const repo = String(input.repositoryRepo || "").trim();
		const branch = String(input.repositoryBranch || "").trim();
		const username = String(input.repositoryUsername || "").trim();
		const token =
			String(input.repositoryToken || "").trim() ||
			String(input.githubToken || "").trim();

		if (!branch) {
			throw new Error("repositoryBranch is required");
		}
		if (!repositoryUrl && (!owner || !repo)) {
			throw new Error(
				"repositoryBranch and either repositoryUrl or repositoryOwner/repositoryRepo are required",
			);
		}

		const repoName = repo || this.resolveRepoNameFromUrl(repositoryUrl);
		if (!repoName) {
			throw new Error("Unable to resolve repository name for clone target");
		}

		const cloneDir = this.resolveCloneTargetDir(
			repoName,
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

		const repoUrl = this.resolveRepositoryUrl({
			repositoryUrl,
			repositoryOwner: owner,
			repositoryRepo: repo,
			repositoryUsername: username,
			token,
		});

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
		const clonePathAbsolute = pathPosix.join(session.rootPath, cloneDir);
		session.clonePath = clonePathAbsolute;
		try {
			await workspaceSessionStore.markClonePath(
				session.workspaceRef,
				clonePathAbsolute,
			);
		} catch (err) {
			console.warn(
				`[workspace-sessions] Failed persisting clonePath for ${session.workspaceRef}:`,
				err,
			);
		}

		this.touch(session);
		return {
			success: true,
			clonePath: clonePathAbsolute,
			repository: owner && repo ? `${owner}/${repo}` : repoName,
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
		const session = await this.resolveFromInput(
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
				this.assertPathWithinCloneScope(session, path, operation);
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
				this.assertPathWithinCloneScope(session, path, operation);
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
				this.assertPathWithinCloneScope(session, path, operation);
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
				this.assertPathWithinCloneScope(session, path, operation);
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
		const ref =
			this.executionToWorkspace.get(id) ||
			(await this.getWorkspaceRefByExecutionIdDurable(id)) ||
			undefined;
		if (!ref) return [];
		await this.cleanupByWorkspaceRef(ref);
		return [ref];
	}

	async cleanupByWorkspaceRef(workspaceRef: string): Promise<boolean> {
		const ref = workspaceRef.trim();
		if (!ref) return false;
		let session = this.sessions.get(ref);
		if (!session) {
			const hydrated = await this.getByWorkspaceRefDurable(ref);
			session = hydrated ?? undefined;
		}
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
		try {
			await workspaceSessionStore.markCleaned(ref);
		} catch (err) {
			console.warn(
				`[workspace-sessions] Failed marking workspace cleaned for ${ref}:`,
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
		const tokens = raw.split("\0").filter(Boolean);
		const files: ChangeFileEntry[] = [];

		for (let index = 0; index < tokens.length; ) {
			const statusToken = tokens[index]?.trim().toUpperCase();
			index += 1;
			if (!statusToken) {
				continue;
			}

			const first = statusToken.charAt(0);
			const status: ChangeFileStatus =
				first === "A" || first === "D" || first === "R" ? first : "M";

			if (status === "R") {
				const oldPath = tokens[index]?.trim();
				const path = tokens[index + 1]?.trim();
				index += 2;
				if (!path) {
					continue;
				}
				files.push({
					path,
					status,
					oldPath: oldPath || undefined,
				});
				continue;
			}

			const path = tokens[index]?.trim();
			index += 1;
			if (!path) {
				continue;
			}
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

	private parseSingleNumStat(raw: string): {
		additions: number;
		deletions: number;
		isBinary: boolean;
	} {
		let additions = 0;
		let deletions = 0;
		let isBinary = false;

		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const parts = trimmed.split("\t");
			if (parts.length < 3) continue;
			if (parts[0] === "-" || parts[1] === "-") {
				isBinary = true;
				continue;
			}
			const add = Number.parseInt(parts[0], 10);
			const del = Number.parseInt(parts[1], 10);
			if (Number.isFinite(add)) additions += add;
			if (Number.isFinite(del)) deletions += del;
		}

		return { additions, deletions, isBinary };
	}

	private inferLanguageFromPath(path: string): string | undefined {
		const filename = path.split("/").at(-1)?.toLowerCase() ?? "";
		if (!filename) {
			return undefined;
		}
		if (filename === "dockerfile") {
			return "dockerfile";
		}
		const extension = filename.includes(".")
			? (filename.split(".").at(-1) ?? "").toLowerCase()
			: "";
		const languageByExtension: Record<string, string> = {
			ts: "typescript",
			tsx: "tsx",
			js: "javascript",
			jsx: "jsx",
			py: "python",
			json: "json",
			md: "markdown",
			css: "css",
			scss: "scss",
			html: "html",
			yaml: "yaml",
			yml: "yaml",
			sh: "bash",
			bash: "bash",
			go: "go",
			rs: "rust",
			sql: "sql",
			java: "java",
			rb: "ruby",
			php: "php",
			c: "c",
			h: "c",
			cpp: "cpp",
			hpp: "cpp",
		};
		return extension ? languageByExtension[extension] : undefined;
	}

	private async readTrackedBlobAsText(
		session: WorkspaceSession,
		spec: string,
	): Promise<string | null> {
		const result = await this.runTrackingGit(
			session,
			`git show --no-textconv --no-color ${shellEscape(spec)}`,
		);
		if (!result.success || result.exitCode !== 0) {
			return null;
		}
		return result.stdout;
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
				"git diff --cached --name-status --find-renames -z HEAD",
			);
			if (!statusResult.success || statusResult.exitCode !== 0) {
				throw new Error(statusResult.stderr || "git diff --name-status failed");
			}
			const files = this.parseNameStatusOutput(statusResult.stdout);

			const numStatResult = await this.runTrackingGit(
				session,
				"git diff --cached --numstat HEAD",
			);
			if (!numStatResult.success || numStatResult.exitCode !== 0) {
				throw new Error(numStatResult.stderr || "git diff --numstat failed");
			}
			const stats = this.parseNumStatOutput(numStatResult.stdout);
			const fileSnapshots: ChangeArtifactFileSnapshotInput[] = [];

			for (const file of files) {
				const statTarget = file.oldPath || file.path;
				const singleNumStatResult = await this.runTrackingGit(
					session,
					`git diff --cached --numstat HEAD -- ${shellEscape(statTarget)}`,
				);
				const singleStats = this.parseSingleNumStat(singleNumStatResult.stdout);
				const isBinary = singleStats.isBinary;

				const oldSpec = `HEAD:${file.oldPath || file.path}`;
				const newSpec = `:${file.path}`;
				const oldContent =
					file.status === "A" || isBinary
						? null
						: await this.readTrackedBlobAsText(session, oldSpec);
				const newContent =
					file.status === "D" || isBinary
						? null
						: await this.readTrackedBlobAsText(session, newSpec);

				fileSnapshots.push({
					path: file.path,
					status: file.status,
					oldPath: file.oldPath,
					isBinary,
					language: this.inferLanguageFromPath(file.path),
					oldContent,
					newContent,
				});
			}

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
				fileSnapshots,
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

	private async resolveFromInput(
		workspaceRef?: string,
		executionId?: string,
	): Promise<WorkspaceSession> {
		if (workspaceRef) {
			const byRef = await this.getByWorkspaceRefDurable(workspaceRef.trim());
			if (byRef) {
				this.touch(byRef);
				return byRef;
			}
		}

		if (executionId) {
			const normalizedExecutionId = executionId.trim();
			const ref = this.executionToWorkspace.get(normalizedExecutionId);
			if (ref) {
				const byExecution = await this.getByWorkspaceRefDurable(ref);
				if (byExecution) {
					this.touch(byExecution);
					return byExecution;
				}
			}
			const durableRef = await this.getWorkspaceRefByExecutionIdDurable(
				normalizedExecutionId,
			);
			if (durableRef) {
				const byExecution = await this.getByWorkspaceRefDurable(durableRef);
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

	private async hydrateFromPersisted(
		record: PersistedWorkspaceSession,
	): Promise<WorkspaceSession | null> {
		const existing = this.sessions.get(record.workspaceRef);
		if (existing) {
			this.touch(existing);
			return existing;
		}

		try {
			const session = await this.createSession({
				executionId: record.workflowExecutionId,
				name: record.name,
				rootPath: record.rootPath,
				enabledTools: record.enabledTools,
				requireReadBeforeWrite: record.requireReadBeforeWrite,
				commandTimeoutMs: record.commandTimeoutMs,
			});
			session.workspaceRef = record.workspaceRef;
			session.clonePath = record.clonePath;
			this.sessions.set(session.workspaceRef, session);
			this.executionToWorkspace.set(
				record.workflowExecutionId,
				record.workspaceRef,
			);
			if (record.durableInstanceId) {
				this.durableInstanceToWorkspace.set(
					record.durableInstanceId,
					record.workspaceRef,
				);
			}
			this.touch(session);
			return session;
		} catch (err) {
			console.warn(
				`[workspace-sessions] Failed hydrating persisted workspace ${record.workspaceRef}:`,
				err,
			);
			try {
				await workspaceSessionStore.markCleaned(
					record.workspaceRef,
					err instanceof Error ? err.message : String(err),
				);
			} catch {
				// Best effort.
			}
			return null;
		}
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
			clonePath: session.clonePath,
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

	private resolveRepoNameFromUrl(repositoryUrl: string): string {
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

	private resolveRepositoryUrl(input: {
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

	private assertPathWithinCloneScope(
		session: WorkspaceSession,
		path: string,
		operation: WorkspaceFileOperation,
	): void {
		if (!session.clonePath) return;
		const normalizedRoot = pathPosix.normalize(session.clonePath);
		const absolutePath = path.startsWith("/")
			? pathPosix.normalize(path)
			: pathPosix.normalize(pathPosix.join(session.rootPath, path));
		const inScope =
			absolutePath === normalizedRoot ||
			absolutePath.startsWith(`${normalizedRoot}/`);
		if (!inScope) {
			throw new Error(
				`${operation} path "${path}" is outside clone root "${normalizedRoot}"`,
			);
		}
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
		void workspaceSessionStore
			.markTouched(session.workspaceRef)
			.catch((err) => {
				console.warn(
					`[workspace-sessions] Failed updating lastAccessedAt for ${session.workspaceRef}:`,
					err,
				);
			});
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
