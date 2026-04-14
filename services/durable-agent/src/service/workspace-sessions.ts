/**
 * Workspace session manager for execution-scoped workspaces.
 *
 * Each workflow execution can own a workspace session that carries:
 * - isolated filesystem + sandbox handles
 * - workspace tool policy (enabled tools, read-before-write)
 * - runtime bindings from durable workflow instance -> workspaceRef
 */

import { execFile } from "node:child_process";
import {
	appendFile,
	mkdtemp,
	mkdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	join as pathJoin,
	posix as pathPosix,
	resolve as pathResolve,
} from "node:path";
import { promisify } from "node:util";
import { nanoid } from "nanoid";
import {
	type WorkflowBrowserArtifactRecord,
	type WorkflowBrowserArtifactStatus,
} from "./browser-artifacts.js";
import {
	changeArtifacts,
	type ChangeArtifactFileSnapshotInput,
	type ChangeArtifactMetadata,
	type ChangeFileEntry,
	type ChangeFileStatus,
	type ExecutionFileSnapshot,
} from "./change-artifacts.js";
import {
	OpenShellFilesystem,
	OpenShellSandbox,
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

/** Info needed to re-clone a repository after sandbox re-provisioning. */
type CloneInfo = {
	repositoryUrl: string;
	repositoryOwner: string;
	repositoryRepo: string;
	repositoryBranch: string;
	repositoryUsername: string;
	repositoryToken: string;
	cloneDir: string;
};

type WorkspaceSession = {
	workspaceRef: string;
	executionId: string;
	name: string;
	rootPath: string;
	clonePath?: string;
	cloneInfo?: CloneInfo;
	backend: "openshell";
	sandbox: Sandbox;
	filesystem: Filesystem;
	enabledTools: Set<WorkspaceToolName>;
	requireReadBeforeWrite: boolean;
	commandTimeoutMs: number;
	readPaths: Set<string>;
	changeSequence: number;
	trackingGitDir?: string;
	keepAfterRun?: boolean;
	ttlSeconds?: number;
	sandboxPolicy?: Record<string, unknown>;
	createdAt: number;
	lastAccessedAt: number;
};

export type WorkspaceSandboxMetadata = {
	backend: "openshell";
	rootPath: string;
	workingDirectory: string;
	details: Record<string, unknown>;
	sandboxPolicy?: Record<string, unknown>;
	keepAfterRun?: boolean;
	ttlSeconds?: number;
	expiresAt?: string;
};

export type WorkspaceProfileResult = {
	workspaceRef: string;
	executionId: string;
	name: string;
	rootPath: string;
	repoName: string;
	clonePath?: string;
	backend: "openshell";
	enabledTools: WorkspaceToolName[];
	requireReadBeforeWrite: boolean;
	commandTimeoutMs: number;
	createdAt: string;
	keepAfterRun?: boolean;
	ttlSeconds?: number;
	sandboxPolicy?: Record<string, unknown>;
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

export type PersistExecutionChangeArtifactInput = {
	executionId: string;
	workspaceRef: string;
	operation: string;
	sequence: number;
	patch: string;
	files: ChangeFileEntry[];
	additions: number;
	deletions: number;
	durableInstanceId?: string;
	includeInExecutionPatch?: boolean;
	baseRevision?: string;
	headRevision?: string;
	fileSnapshots?: ChangeArtifactFileSnapshotInput[];
};

export type WorkspaceProfileInput = {
	executionId: string;
	name?: string;
	rootPath?: string;
	enabledTools?: string[];
	requireReadBeforeWrite?: boolean;
	commandTimeoutMs?: number;
	sandboxTemplate?: string;
	workspaceRef?: string;
	reuseExecutionWorkspace?: boolean;
	keepAfterRun?: boolean;
	ttlSeconds?: number;
	sandboxPolicy?: Record<string, unknown>;
};

export type ExecuteWorkspaceCommandInput = {
	workspaceRef?: string;
	executionId?: string;
	durableInstanceId?: string;
	command: string;
	timeoutMs?: number;
	env?: Record<string, string>;
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

export type ExecuteWorkspacePublishGiteaInput = {
	workspaceRef?: string;
	executionId?: string;
	durableInstanceId?: string;
	repositoryUrl: string;
	repositoryOwner?: string;
	repositoryRepo: string;
	repositoryBranch?: string;
	repositoryUsername?: string;
	repositoryToken?: string;
	commitMessage?: string;
	gitUserName?: string;
	gitUserEmail?: string;
	timeoutMs?: number;
	force?: boolean;
};

export type MaterializeChangeArtifactInput = {
	workspaceRef?: string;
	executionId?: string;
	sourceExecutionId?: string;
	durableInstanceId?: string;
	preferredOperation?: string;
};

export type BrowserCaptureFlowInput = {
	workspaceRef?: string;
	executionId?: string;
	workflowId: string;
	nodeId: string;
	baseUrl: string;
	steps: BrowserCaptureStepInput[];
	timeoutMs?: number;
	metadata?: Record<string, unknown>;
};

export type BrowserCaptureStepInput = {
	id?: string;
	label?: string;
	path?: string;
	url?: string;
	waitForSelector?: string;
	waitForText?: string;
	delayMs?: number;
	fullPage?: boolean;
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
const TRACKING_GIT_IGNORED_PATHS = [
	".git",
	"node_modules",
	".svelte-kit",
	".vite",
	"build",
	"dist",
	".turbo",
	".cache",
	"coverage",
	"playwright-report",
	"test-results",
] as const;

const execFileAsync = promisify(execFile);
const LOCAL_COMMAND_MAX_BUFFER = 20 * 1024 * 1024;

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

type LocalCommandResult = {
	success: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
};

async function runLocalCommand(
	command: string,
	args: string[],
	options?: { cwd?: string; env?: Record<string, string> },
): Promise<LocalCommandResult> {
	try {
		const result = await execFileAsync(command, args, {
			cwd: options?.cwd,
			env: { ...process.env, ...(options?.env ?? {}) },
			encoding: "utf8",
			maxBuffer: LOCAL_COMMAND_MAX_BUFFER,
		});
		return {
			success: true,
			exitCode: 0,
			stdout: String(result.stdout || ""),
			stderr: String(result.stderr || ""),
		};
	} catch (err) {
		const error = err as Error & {
			code?: number | string;
			stdout?: string | Buffer;
			stderr?: string | Buffer;
		};
		return {
			success: false,
			exitCode: typeof error.code === "number" ? error.code : 1,
			stdout: String(error.stdout || ""),
			stderr: String(error.stderr || error.message || "unknown error"),
		};
	}
}

async function requireLocalCommand(
	command: string,
	args: string[],
	options?: { cwd?: string; env?: Record<string, string> },
): Promise<LocalCommandResult> {
	const result = await runLocalCommand(command, args, options);
	if (!result.success || result.exitCode !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed: ${
				result.stderr || result.stdout || "unknown error"
			}`,
		);
	}
	return result;
}

function trackingGitAddCommand(): string {
	const excludedPathspecs = TRACKING_GIT_IGNORED_PATHS.flatMap((path) => [
		shellEscape(`:!${path}`),
		shellEscape(`:!${path}/**`),
	]);
	return ["git add -A -- .", ...excludedPathspecs].join(" ");
}

function trackingGitExcludeFileContent(): string {
	return `${TRACKING_GIT_IGNORED_PATHS.map((path) => `${path}/`).join("\n")}\n`;
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
		process.env.WORKSPACE_SESSIONS_ROOT || "/sandbox/workspaces";

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

	async persistExecutionChangeArtifact(
		input: PersistExecutionChangeArtifactInput,
	): Promise<ChangeArtifactMetadata> {
		await changeArtifacts.ensureReady();
		return await changeArtifacts.save({
			executionId: input.executionId.trim(),
			workspaceRef: input.workspaceRef.trim(),
			operation: input.operation.trim(),
			sequence: input.sequence,
			patch: input.patch,
			files: input.files,
			additions: input.additions,
			deletions: input.deletions,
			durableInstanceId: input.durableInstanceId?.trim() || undefined,
			includeInExecutionPatch: input.includeInExecutionPatch,
			baseRevision: input.baseRevision?.trim() || undefined,
			headRevision: input.headRevision?.trim() || undefined,
			fileSnapshots: input.fileSnapshots ?? [],
		});
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

		const reuseExecutionWorkspace = input.reuseExecutionWorkspace !== false;
		if (reuseExecutionWorkspace) {
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
		}

		const rootPath = this.resolveRootPath(
			executionId,
			input.rootPath,
			input.sandboxTemplate,
		);
		const session = await this.createSession({
			workspaceRef: input.workspaceRef,
			executionId,
			name: input.name?.trim() || `workspace-${executionId}`,
			rootPath,
			enabledTools: input.enabledTools,
			requireReadBeforeWrite: Boolean(input.requireReadBeforeWrite),
			commandTimeoutMs:
				typeof input.commandTimeoutMs === "number" && input.commandTimeoutMs > 0
					? Math.floor(input.commandTimeoutMs)
					: parseInt(process.env.SANDBOX_TIMEOUT_MS || "30000", 10),
			sandboxTemplate: input.sandboxTemplate,
			keepAfterRun: input.keepAfterRun,
			ttlSeconds: input.ttlSeconds,
			sandboxPolicy: input.sandboxPolicy,
		});

		this.sessions.set(session.workspaceRef, session);
		if (reuseExecutionWorkspace) {
			this.executionToWorkspace.set(executionId, session.workspaceRef);
		}
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
			await this.persistSandboxState(session);
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
			env: input.env,
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

	async materializeChangeArtifact(
		input: MaterializeChangeArtifactInput,
	): Promise<{
		workspaceRef: string;
		changeSetId: string;
		operation: string;
		restoredPaths: string[];
		deletedPaths: string[];
		sandbox: WorkspaceSandboxMetadata;
	}> {
		const session = await this.resolveFromInput(
			input.workspaceRef,
			input.executionId,
		);
		const sourceExecutionId =
			String(
				input.sourceExecutionId || input.executionId || session.executionId,
			).trim() || session.executionId;
		const preferredOperation = String(input.preferredOperation || "").trim();
		const changes =
			await this.listChangeArtifactsByExecutionId(sourceExecutionId);
		const selected =
			(preferredOperation
				? changes.find((change) => change.operation === preferredOperation)
				: undefined) ||
			changes.find((change) => change.includeInExecutionPatch) ||
			changes[0];

		if (!selected) {
			throw new Error(
				`No durable change artifact found for execution ${sourceExecutionId}`,
			);
		}

		const restoredPaths: string[] = [];
		const deletedPaths: string[] = [];

		for (const file of selected.files) {
			if (file.status === "D") {
				const absolutePath = this.resolveSessionPath(session, file.path);
				await session.filesystem.deleteFile(absolutePath, {
					force: true,
					recursive: true,
				});
				deletedPaths.push(absolutePath);
				continue;
			}

			const snapshot = await this.getExecutionFileSnapshot(
				sourceExecutionId,
				file.path,
				{
					durableInstanceId:
						input.durableInstanceId || selected.durableInstanceId,
				},
			);
			if (!snapshot) {
				throw new Error(
					`Unable to resolve snapshot for ${file.path} from ${selected.changeSetId}`,
				);
			}
			if (snapshot.isBinary || snapshot.newContent == null) {
				throw new Error(
					`Binary file materialization is not supported for ${file.path}`,
				);
			}

			const absolutePath = this.resolveSessionPath(session, file.path);
			await session.filesystem.writeFile(absolutePath, snapshot.newContent, {
				recursive: true,
			});
			restoredPaths.push(absolutePath);

			if (file.oldPath && file.oldPath !== file.path) {
				const oldPath = this.resolveSessionPath(session, file.oldPath);
				await session.filesystem.deleteFile(oldPath, {
					force: true,
					recursive: true,
				});
				deletedPaths.push(oldPath);
			}
		}

		this.touch(session);
		return {
			workspaceRef: session.workspaceRef,
			changeSetId: selected.changeSetId,
			operation: selected.operation,
			restoredPaths,
			deletedPaths,
			sandbox: this.buildSandboxMetadata(session),
		};
	}

	async captureBrowserFlow(input: BrowserCaptureFlowInput): Promise<{
		artifact: WorkflowBrowserArtifactRecord;
		artifactId: string;
		stepCount: number;
		status: WorkflowBrowserArtifactStatus;
		sandbox: WorkspaceSandboxMetadata;
	}> {
		const session = await this.resolveFromInput(
			input.workspaceRef,
			input.executionId,
		);
		const response = await fetch(
			`${process.env.OPENSHELL_AGENT_RUNTIME_API_BASE_URL?.trim() || "http://openshell-agent-runtime.openshell.svc.cluster.local:8083"}/api/browser/capture-flow`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					workspaceRef: session.workspaceRef,
					executionId: session.executionId,
					workflowId: input.workflowId,
					nodeId: input.nodeId,
					baseUrl: input.baseUrl,
					steps: input.steps,
					timeoutMs: input.timeoutMs,
					metadata: input.metadata,
				}),
			},
		);
		const payload = (await response.json()) as Record<string, unknown>;
		if (!response.ok) {
			throw new Error(
				String(payload.error || `Browser capture failed (${response.status})`),
			);
		}
		const artifact = payload.artifact as WorkflowBrowserArtifactRecord;
		const status = String(payload.status || "failed") as WorkflowBrowserArtifactStatus;

		this.touch(session);
		return {
			artifact,
			artifactId: String(payload.artifactId || artifact.id),
			stepCount: Number(payload.stepCount || 0),
			status,
			sandbox: this.buildSandboxMetadata(session),
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

		// Configure git credential store so subsequent push/pull commands
		// can authenticate without interactive prompts. The credential entry
		// is written to a file inside the clone dir's .git so it is scoped
		// to this sandbox session and cleaned up with the workspace.
		console.log(
			`[workspace-sessions] Credential store check: username=${JSON.stringify(username)}, token=${token ? "***" : "(empty)"}, STRIP_CLONE_GIT_DIR=${STRIP_CLONE_GIT_DIR}, cloneDir=${cloneDir}, rootPath=${session.rootPath}`,
		);
		if (username && token && !STRIP_CLONE_GIT_DIR) {
			try {
				const parsed = new URL(repoUrl);
				const credentialLine = `${parsed.protocol}//${encodeURIComponent(username)}:${encodeURIComponent(token)}@${parsed.host}`;
				const credStorePath = pathPosix.join(".git", ".git-credentials");
				const credCmd = `cd ${shellEscape(cloneDir)} && git config credential.helper 'store --file=${shellEscape(credStorePath)}' && printf '%s\\n' ${shellEscape(credentialLine)} > ${shellEscape(credStorePath)}`;
				console.log(
					`[workspace-sessions] Setting up git credential store in ${cloneDir}/${credStorePath}`,
				);
				const credResult = await session.sandbox.executeCommand(
					credCmd,
					undefined,
					{ timeout: Math.min(timeoutMs, 15_000), cwd: session.rootPath },
				);
				if (!credResult.success || credResult.exitCode !== 0) {
					console.warn(
						`[workspace-sessions] Credential store command failed: exit=${credResult.exitCode}, stderr=${credResult.stderr}`,
					);
				} else {
					console.log(
						"[workspace-sessions] Git credential store configured successfully",
					);
				}
			} catch (err) {
				console.warn(
					"[workspace-sessions] Failed to configure git credential store (push may require explicit auth):",
					err,
				);
			}
		} else {
			console.log(
				"[workspace-sessions] Skipping credential store: conditions not met",
			);
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
		session.cloneInfo = {
			repositoryUrl: repositoryUrl,
			repositoryOwner: owner,
			repositoryRepo: repo,
			repositoryBranch: branch,
			repositoryUsername: username,
			repositoryToken: token,
			cloneDir,
		};
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

	async publishGiteaRepository(
		input: ExecuteWorkspacePublishGiteaInput,
	): Promise<Record<string, unknown>> {
		const session = await this.resolveFromInput(
			input.workspaceRef,
			input.executionId,
		);
		this.assertEnabled(session, "execute_command");

		const repositoryUrl = String(input.repositoryUrl || "").trim();
		const repositoryOwner = String(input.repositoryOwner || "").trim();
		const repositoryRepo = String(input.repositoryRepo || "").trim();
		const branch = String(input.repositoryBranch || "main").trim() || "main";
		const username = String(input.repositoryUsername || "").trim();
		const token = String(input.repositoryToken || "").trim();
		const commandCwd = session.clonePath || session.rootPath;
		const timeoutMs =
			typeof input.timeoutMs === "number" && input.timeoutMs > 0
				? Math.floor(input.timeoutMs)
				: Math.max(session.commandTimeoutMs, 300_000);

		if (!repositoryUrl) {
			throw new Error("repositoryUrl is required for publish-gitea");
		}
		if (!repositoryRepo) {
			throw new Error("repositoryRepo is required for publish-gitea");
		}

		let credentialLine = "";
		try {
			const parsed = new URL(repositoryUrl);
			if (username && token) {
				credentialLine = `${parsed.protocol}//${encodeURIComponent(username)}:${encodeURIComponent(token)}@${parsed.host}`;
			}
		} catch {
			throw new Error(`Invalid repositoryUrl for publish-gitea: ${repositoryUrl}`);
		}

		const gitignoreEntries = TRACKING_GIT_IGNORED_PATHS.filter(
			(path) => path !== ".git",
		).map((path) => `${path}/`);
		const tarExcludeArgs = TRACKING_GIT_IGNORED_PATHS.flatMap((path) => [
			`--exclude=${shellEscape(path)}`,
			`--exclude=${shellEscape(`./${path}`)}`,
			`--exclude=${shellEscape(`./${path}/**`)}`,
		]).join(" ");
		const archiveCommand = [
			"set -eu",
			"command -v tar >/dev/null 2>&1 || { echo 'tar is not installed in the sandbox runtime' >&2; exit 127; }",
			"command -v base64 >/dev/null 2>&1 || { echo 'base64 is not installed in the sandbox runtime' >&2; exit 127; }",
			`if base64 --help 2>&1 | grep -q -- '-w'; then tar ${tarExcludeArgs} -czf - -C ${shellEscape(commandCwd)} . | base64 -w 0; else tar ${tarExcludeArgs} -czf - -C ${shellEscape(commandCwd)} . | base64 | tr -d '\\n'; fi`,
		].join(" && ");

		const archiveResult = await session.sandbox.executeCommand(
			archiveCommand,
			undefined,
			{
				timeout: timeoutMs,
				cwd: commandCwd,
			},
		);

		const sanitize = (value: string) =>
			[token, credentialLine]
				.filter(Boolean)
				.reduce((text, secret) => text.replaceAll(secret, "***"), value);
		if (!archiveResult.success || archiveResult.exitCode !== 0) {
			throw new Error(
				`workspace archive failed: ${sanitize(archiveResult.stderr || archiveResult.stdout || "unknown error")}`,
			);
		}

		const archiveB64 = archiveResult.stdout.trim();
		if (!archiveB64) {
			throw new Error("workspace archive failed: sandbox returned empty archive");
		}

		const tempDir = await mkdtemp(pathJoin(tmpdir(), "workflow-builder-publish-"));
		const worktreeDir = pathJoin(tempDir, "worktree");
		const archivePath = pathJoin(tempDir, "workspace.tar.gz");
		const gitEnv = {
			GIT_TERMINAL_PROMPT: "0",
			NO_PROXY:
				"127.0.0.1,localhost,::1,.svc,.svc.cluster.local,.cluster.local,gitea-http.gitea.svc.cluster.local",
			no_proxy:
				"127.0.0.1,localhost,::1,.svc,.svc.cluster.local,.cluster.local,gitea-http.gitea.svc.cluster.local",
		};

		let stdout = "";
		let stderr = "";
		let commitHash = "unknown";
		let fileCount = 0;
		try {
			await mkdir(worktreeDir, { recursive: true });
			await writeFile(archivePath, Buffer.from(archiveB64, "base64"));
			await requireLocalCommand("tar", ["-xzf", archivePath, "-C", worktreeDir]);
			await requireLocalCommand("git", ["init", "-q"], {
				cwd: worktreeDir,
				env: gitEnv,
			});
			await requireLocalCommand(
				"git",
				[
					"config",
					"user.name",
					String(input.gitUserName || "").trim() || "Workflow Builder",
				],
				{ cwd: worktreeDir, env: gitEnv },
			);
			await requireLocalCommand(
				"git",
				[
					"config",
					"user.email",
					String(input.gitUserEmail || "").trim() ||
						"workflow-builder@local",
				],
				{ cwd: worktreeDir, env: gitEnv },
			);
			await requireLocalCommand("git", ["remote", "add", "origin", repositoryUrl], {
				cwd: worktreeDir,
				env: gitEnv,
			});
			if (credentialLine) {
				const credentialsPath = pathJoin(worktreeDir, ".git", ".git-credentials");
				await writeFile(credentialsPath, `${credentialLine}\n`, { mode: 0o600 });
				await requireLocalCommand(
					"git",
					["config", "credential.helper", `store --file=${credentialsPath}`],
					{ cwd: worktreeDir, env: gitEnv },
				);
			}

			const gitignorePath = pathJoin(worktreeDir, ".gitignore");
			let existingGitignore = "";
			try {
				existingGitignore = await readFile(gitignorePath, "utf8");
			} catch {
				// Missing .gitignore is expected for new generated workspaces.
			}
			const gitignoreAdditions = gitignoreEntries.filter(
				(entry) => !existingGitignore.split(/\r?\n/).includes(entry),
			);
			if (gitignoreAdditions.length > 0) {
				await appendFile(gitignorePath, `${gitignoreAdditions.join("\n")}\n`);
			}

			await requireLocalCommand("git", ["checkout", "-B", branch], {
				cwd: worktreeDir,
				env: gitEnv,
			});
			const excludedPathspecs = TRACKING_GIT_IGNORED_PATHS.flatMap((path) => [
				`:!${path}`,
				`:!${path}/**`,
			]);
			await requireLocalCommand(
				"git",
				["add", "-A", "--", ".", ...excludedPathspecs],
				{ cwd: worktreeDir, env: gitEnv },
			);
			const hasHead = await runLocalCommand(
				"git",
				["rev-parse", "--verify", "HEAD"],
				{ cwd: worktreeDir, env: gitEnv },
			);
			const diff = await runLocalCommand("git", ["diff", "--cached", "--quiet"], {
				cwd: worktreeDir,
				env: gitEnv,
			});
			if (!hasHead.success || diff.exitCode === 1) {
				await requireLocalCommand(
					"git",
					[
						"commit",
						...(hasHead.success ? [] : ["--allow-empty"]),
						"-m",
						String(input.commitMessage || "").trim() ||
							`Publish ${repositoryRepo} from workflow-builder`,
					],
					{ cwd: worktreeDir, env: gitEnv },
				);
			}
			const pushArgs = [
				"push",
				...(input.force === true ? ["--force"] : []),
				"-u",
				"origin",
				`HEAD:refs/heads/${branch}`,
			];
			const push = await requireLocalCommand("git", pushArgs, {
				cwd: worktreeDir,
				env: gitEnv,
			});
			const revParse = await requireLocalCommand("git", ["rev-parse", "HEAD"], {
				cwd: worktreeDir,
				env: gitEnv,
			});
			const lsFiles = await requireLocalCommand("git", ["ls-files", "--cached"], {
				cwd: worktreeDir,
				env: gitEnv,
			});
			commitHash = revParse.stdout.trim() || "unknown";
			fileCount = lsFiles.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean).length;
			stdout = sanitize(
				[
					push.stdout,
					`commit=${commitHash}`,
					`tracked_files=${fileCount}`,
				]
					.filter(Boolean)
					.join("\n"),
			);
			stderr = sanitize(push.stderr);
		} catch (err) {
			throw new Error(
				`git publish failed: ${sanitize(err instanceof Error ? err.message : String(err))}`,
			);
		} finally {
			await rm(tempDir, { recursive: true, force: true }).catch((err) => {
				console.warn(
					`[workspace-sessions] Failed removing publish temp dir ${tempDir}:`,
					err,
				);
			});
		}

		const changeSummary = await this.captureWorkspaceChangeSummary({
			session,
			operation: "publish_gitea",
			durableInstanceId: input.durableInstanceId,
			includeInExecutionPatch: true,
		});

		this.touch(session);
		return {
			success: true,
			repository:
				repositoryOwner && repositoryRepo
					? `${repositoryOwner}/${repositoryRepo}`
					: repositoryRepo,
			repositoryUrl,
			branch,
			commitHash,
			fileCount,
			force: input.force === true,
			stdout,
			stderr,
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
				const path = this.resolveSessionPath(
					session,
					this.requirePath(input.path, operation),
				);
				this.assertPathWithinCloneScope(session, path, operation);
				const content = await session.filesystem.readFile(path, {
					encoding: "utf-8",
				});
				session.readPaths.add(normalizePathKey(path));
				this.touch(session);
				return { content: String(content) };
			}

			case "write_file": {
				const path = this.resolveSessionPath(
					session,
					this.requirePath(input.path, operation),
				);
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
				const path = this.resolveSessionPath(
					session,
					this.requirePath(input.path, operation),
				);
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
				const path = this.resolveSessionPath(session, input.path, {
					defaultToScopeRoot: true,
				});
				this.assertPathWithinCloneScope(session, path, operation);
				const entries = await session.filesystem.readdir(path);
				this.touch(session);
				return {
					files: entries.map((e) => ({ name: e.name, type: e.type })),
				};
			}

			case "delete_file": {
				const path = this.resolveSessionPath(
					session,
					this.requirePath(input.path, operation),
				);
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
				const path = this.resolveSessionPath(
					session,
					this.requirePath(input.path, operation),
				);
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
				const path = this.resolveSessionPath(
					session,
					this.requirePath(input.path, operation),
				);
				this.assertPathWithinCloneScope(session, path, operation);
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
		const refs = new Set<string>();
		const mappedRef = this.executionToWorkspace.get(id);
		if (mappedRef) refs.add(mappedRef);
		try {
			const persisted = await workspaceSessionStore.listActiveByExecutionId(id);
			for (const record of persisted) refs.add(record.workspaceRef);
		} catch (err) {
			console.warn(
				`[workspace-sessions] Failed listing workspaces for execution=${id}:`,
				err,
			);
		}
		if (refs.size === 0) {
			const durableRef = (await this.getWorkspaceRefByExecutionIdDurable(id)) || undefined;
			if (durableRef) refs.add(durableRef);
		}
		for (const ref of refs) {
			await this.cleanupByWorkspaceRef(ref);
		}
		return [...refs];
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
		workspaceRef?: string;
		executionId: string;
		name: string;
		rootPath: string;
		enabledTools?: string[];
		requireReadBeforeWrite: boolean;
		commandTimeoutMs: number;
		sandboxTemplate?: string;
		keepAfterRun?: boolean;
		ttlSeconds?: number;
		sandboxPolicy?: Record<string, unknown>;
	}): Promise<WorkspaceSession> {
		const workspaceRef = input.workspaceRef || `ws_${nanoid(12)}`;
		const sandbox = new OpenShellSandbox(
			workspaceRef,
			input.rootPath,
			input.commandTimeoutMs,
			input.executionId,
			input.enabledTools,
			{
				sandboxTemplate: input.sandboxTemplate,
				keepAfterRun: input.keepAfterRun,
				ttlSeconds: input.ttlSeconds,
				sandboxPolicy: input.sandboxPolicy,
			},
		);
		await sandbox.start();
		const filesystem = new OpenShellFilesystem(sandbox, input.rootPath);

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
		const session: WorkspaceSession = {
			workspaceRef,
			executionId: input.executionId,
			name: input.name,
			rootPath: input.rootPath,
			backend: SANDBOX_BACKEND,
			sandbox,
			filesystem,
			enabledTools,
			requireReadBeforeWrite: input.requireReadBeforeWrite,
			commandTimeoutMs: input.commandTimeoutMs,
			readPaths: new Set<string>(),
			changeSequence: 0,
			trackingGitDir: trackingGitDir ?? undefined,
			keepAfterRun: input.keepAfterRun,
			ttlSeconds: input.ttlSeconds,
			sandboxPolicy: input.sandboxPolicy,
			createdAt: now,
			lastAccessedAt: now,
		};

		return session;
	}

	/**
	 * Restore workspace state after the sandbox pod was re-provisioned.
	 * Creates workspace directory, re-clones repositories, and re-initializes
	 * the change tracking git repo on the new pod.
	 */
	private async restoreWorkspaceAfterReprovision(
		session: WorkspaceSession,
	): Promise<void> {
		console.log(
			`[workspace-sessions] Restoring workspace after sandbox re-provision (ref=${session.workspaceRef})`,
		);

		// 1. Re-create workspace root directory
		await session.sandbox.executeCommand(
			`mkdir -p ${shellEscape(session.rootPath)}`,
			undefined,
			{ timeout: 15_000, cwd: "/" },
		);

		// 2. Re-clone repository if one was previously cloned
		if (session.cloneInfo) {
			const info = session.cloneInfo;
			const repoUrl = this.resolveRepositoryUrl({
				repositoryUrl: info.repositoryUrl,
				repositoryOwner: info.repositoryOwner,
				repositoryRepo: info.repositoryRepo,
				repositoryUsername: info.repositoryUsername,
				token: info.repositoryToken,
			});

			const cloneResult = await session.sandbox.executeCommand(
				`GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch ${shellEscape(info.repositoryBranch)} ${shellEscape(repoUrl)} ${shellEscape(info.cloneDir)}`,
				undefined,
				{
					timeout: Math.max(session.commandTimeoutMs, 120_000),
					cwd: session.rootPath,
				},
			);

			if (!cloneResult.success || cloneResult.exitCode !== 0) {
				const stderr = cloneResult.stderr || "unknown clone error";
				const sanitized = info.repositoryToken
					? stderr.replaceAll(info.repositoryToken, "***")
					: stderr;
				console.error(
					`[workspace-sessions] Re-clone failed after re-provision: ${sanitized}`,
				);
				throw new Error(
					`Re-clone failed after sandbox re-provision: ${sanitized}`,
				);
			}

			if (
				info.repositoryUsername &&
				info.repositoryToken &&
				!STRIP_CLONE_GIT_DIR
			) {
				try {
					const parsed = new URL(repoUrl);
					const credentialLine = `${parsed.protocol}//${encodeURIComponent(info.repositoryUsername)}:${encodeURIComponent(info.repositoryToken)}@${parsed.host}`;
					const credStorePath = pathPosix.join(".git", ".git-credentials");
					await session.sandbox.executeCommand(
						`cd ${shellEscape(info.cloneDir)} && git config credential.helper 'store --file=${shellEscape(credStorePath)}' && printf '%s\\n' ${shellEscape(credentialLine)} > ${shellEscape(credStorePath)}`,
						undefined,
						{ timeout: 15_000, cwd: session.rootPath },
					);
				} catch (err) {
					console.warn(
						"[workspace-sessions] Failed to configure git credential store on re-clone:",
						err,
					);
				}
			}

			if (STRIP_CLONE_GIT_DIR) {
				await session.sandbox.executeCommand(
					`rm -rf ${shellEscape(pathPosix.join(info.cloneDir, ".git"))}`,
					undefined,
					{
						timeout: 30_000,
						cwd: session.rootPath,
					},
				);
			}

			console.log(
				`[workspace-sessions] Re-cloned ${info.cloneDir} after sandbox re-provision`,
			);
		}

		// 3. Re-initialize change tracking git repo
		const newTrackingGitDir = await this.initializeTrackingRepository({
			sandbox: session.sandbox,
			rootPath: session.rootPath,
			executionId: session.executionId,
		});
		session.trackingGitDir = newTrackingGitDir ?? undefined;
		await this.persistSandboxState(session);
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
			`printf '%s' ${shellEscape(trackingGitExcludeFileContent())} > ${shellEscape(pathPosix.join(gitDir, "info", "exclude"))}`,
			`GIT_DIR=${shellEscape(gitDir)} GIT_WORK_TREE=${shellEscape(input.rootPath)} ${trackingGitAddCommand()}`,
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
		const add = await this.runTrackingGit(session, trackingGitAddCommand());
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

	private computeStatsFromPatch(patch: string): {
		additions: number;
		deletions: number;
	} {
		let additions = 0;
		let deletions = 0;
		for (const line of patch.split("\n")) {
			if (line.startsWith("+") && !line.startsWith("+++")) {
				additions++;
			} else if (line.startsWith("-") && !line.startsWith("---")) {
				deletions++;
			}
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

			const stage = await this.runTrackingGit(session, trackingGitAddCommand());
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

			const stats = this.computeStatsFromPatch(patch);
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
			const sandboxState =
				record.sandboxState && typeof record.sandboxState === "object"
					? record.sandboxState
					: {};
			const session = await this.createSession({
				workspaceRef: record.workspaceRef,
				executionId: record.workflowExecutionId,
				name: record.name,
				rootPath: record.rootPath,
				enabledTools: record.enabledTools,
				requireReadBeforeWrite: record.requireReadBeforeWrite,
				commandTimeoutMs: record.commandTimeoutMs,
				keepAfterRun:
					typeof sandboxState.keepAfterRun === "boolean"
						? sandboxState.keepAfterRun
						: undefined,
				ttlSeconds:
					typeof sandboxState.ttlSeconds === "number"
						? sandboxState.ttlSeconds
						: undefined,
				sandboxPolicy:
					sandboxState.sandboxPolicy &&
					typeof sandboxState.sandboxPolicy === "object" &&
					!Array.isArray(sandboxState.sandboxPolicy)
						? (sandboxState.sandboxPolicy as Record<string, unknown>)
						: undefined,
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
			await this.persistSandboxState(session);
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

	private resolveRootPath(
		executionId: string,
		requested?: string,
		sandboxTemplate?: string,
	): string {
		const requestedPath = String(requested || "").trim();
		const base = this.defaultRoot.startsWith("/")
			? this.defaultRoot
			: pathResolve(this.defaultRoot);
		if (requestedPath) {
			// If rootPath ends with "/" the repo name was empty -- auto-generate one
			if (requestedPath.endsWith("/")) {
				const slug = `project-${Date.now().toString(36)}`;
				return requestedPath + slug;
			}
			if (requestedPath.startsWith("/")) return requestedPath;
			return pathPosix.join(base, sanitizeSegment(requestedPath));
		}
		return pathPosix.join(base, sanitizeSegment(executionId));
	}

	private serialize(session: WorkspaceSession): WorkspaceProfileResult {
		// Extract repoName from the last segment of rootPath
		const rootSegments = session.rootPath.split("/").filter(Boolean);
		const repoName = rootSegments.length > 0 ? rootSegments[rootSegments.length - 1] : session.name;

		return {
			workspaceRef: session.workspaceRef,
			executionId: session.executionId,
			name: session.name,
			rootPath: session.rootPath,
			repoName,
			clonePath: session.clonePath,
			backend: session.backend,
			enabledTools: [...session.enabledTools],
			requireReadBeforeWrite: session.requireReadBeforeWrite,
			commandTimeoutMs: session.commandTimeoutMs,
			createdAt: new Date(session.createdAt).toISOString(),
			...(session.keepAfterRun !== undefined
				? { keepAfterRun: session.keepAfterRun }
				: {}),
			...(session.ttlSeconds ? { ttlSeconds: session.ttlSeconds } : {}),
			...(session.sandboxPolicy ? { sandboxPolicy: session.sandboxPolicy } : {}),
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
				input.repositoryUsername ||
				(parsed.hostname === "github.com" ? input.token : "");
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

	private resolveSessionPath(
		session: WorkspaceSession,
		path: string | undefined,
		options?: { defaultToScopeRoot?: boolean },
	): string {
		const normalized = String(path || "").trim();
		const basePath = session.clonePath || session.rootPath;
		if (!normalized) {
			if (options?.defaultToScopeRoot) {
				return pathPosix.normalize(basePath);
			}
			throw new Error("path is required");
		}
		if (normalized.startsWith("/")) {
			return pathPosix.normalize(normalized);
		}
		return pathPosix.normalize(pathPosix.join(basePath, normalized));
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
		const workingDirectory = session.clonePath || session.rootPath;
		const expiresAt =
			session.keepAfterRun && session.ttlSeconds
				? new Date(session.createdAt + session.ttlSeconds * 1000).toISOString()
				: undefined;
		return {
			backend: session.backend,
			rootPath: session.rootPath,
			workingDirectory,
			details: session.sandbox.getDebugInfo?.() ?? {},
			...(session.sandboxPolicy ? { sandboxPolicy: session.sandboxPolicy } : {}),
			...(session.keepAfterRun !== undefined
				? { keepAfterRun: session.keepAfterRun }
				: {}),
			...(session.ttlSeconds ? { ttlSeconds: session.ttlSeconds } : {}),
			...(expiresAt ? { expiresAt } : {}),
		};
	}

	private async persistSandboxState(session: WorkspaceSession): Promise<void> {
		try {
			await workspaceSessionStore.markSandboxState(
				session.workspaceRef,
				this.buildSandboxMetadata(session) as unknown as Record<string, unknown>,
			);
		} catch (err) {
			console.warn(
				`[workspace-sessions] Failed persisting sandbox_state for ${session.workspaceRef}:`,
				err,
			);
		}
	}

	private resolveBrowserStepUrl(
		baseUrl: string,
		step: BrowserCaptureStepInput,
	): string {
		const explicitUrl = String(step.url || "").trim();
		if (explicitUrl) {
			return explicitUrl;
		}
		const path = String(step.path || "").trim();
		if (!path) {
			return baseUrl;
		}
		return new URL(path, `${baseUrl.replace(/\/+$/, "")}/`).toString();
	}

	private async sweepExpired(): Promise<void> {
		const now = Date.now();
		for (const [workspaceRef, session] of this.sessions) {
			const ttlMs =
				session.keepAfterRun && session.ttlSeconds
					? session.ttlSeconds * 1000
					: SESSION_TTL_MS;
			const referenceTime = session.keepAfterRun ? session.createdAt : session.lastAccessedAt;
			if (now - referenceTime <= ttlMs) continue;
			await this.cleanupByWorkspaceRef(workspaceRef);
		}
	}
}

export const workspaceSessions = new WorkspaceSessionManager();
