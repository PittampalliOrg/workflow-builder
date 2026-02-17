/**
 * Centralized Sandbox Configuration
 *
 * Factory that creates the appropriate sandbox based on SANDBOX_BACKEND:
 * - "k8s": K8sSandbox — routes commands to an isolated Agent Sandbox pod
 * - "local": Simple local sandbox using child_process
 *
 * No @mastra/core dependency — all implementations are standalone.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import {
	readFile,
	writeFile,
	rm,
	mkdir as fsMkdir,
	readdir as fsReaddir,
	stat as fsStat,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { K8sSandbox } from "./k8s-sandbox.js";
import type { CommandResult } from "./k8s-sandbox.js";
import { K8sRemoteFilesystem } from "./k8s-remote-filesystem.js";
import type { FileEntry, FileStat } from "./k8s-remote-filesystem.js";

const execFileAsync = promisify(execFile);

export const WORKSPACE_PATH = resolve(
	process.env.AGENT_WORKSPACE_PATH || "./workspace",
);

export const SANDBOX_BACKEND = resolveBackend();

function resolveBackend(): "k8s" | "local" {
	const inCluster = existsSync(
		"/var/run/secrets/kubernetes.io/serviceaccount/token",
	);
	const configured = String(process.env.SANDBOX_BACKEND || "").trim();
	if (!configured) {
		return detectBackend();
	}

	if (configured === "k8s") {
		return "k8s";
	}

	if (configured === "local") {
		if (inCluster) {
			throw new Error(
				"[sandbox] Invalid production configuration: SANDBOX_BACKEND=local " +
					"is not allowed in-cluster. Set SANDBOX_BACKEND=k8s.",
			);
		}
		return "local";
	}

	console.warn(
		`[sandbox] Unknown SANDBOX_BACKEND "${configured}", falling back to auto-detect`,
	);
	return detectBackend();
}

/** Auto-detect: use K8s if running in-cluster, local otherwise. */
function detectBackend(): "k8s" | "local" {
	if (existsSync("/var/run/secrets/kubernetes.io/serviceaccount/token")) {
		console.log("[sandbox] Detected in-cluster environment, using k8s backend");
		return "k8s";
	}
	console.log("[sandbox] No K8s service account found, using local backend");
	return "local";
}

// ── Environment Allowlist (for local sandbox) ─────────────────
const ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"NODE_ENV",
	"LANG",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
];

function buildAllowedEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ENV_ALLOWLIST) {
		if (process.env[key]) {
			env[key] = process.env[key];
		}
	}
	return env;
}

// ── Local Sandbox ─────────────────────────────────────────────

/** Shared sandbox interface for command execution */
export interface Sandbox {
	readonly name: string;
	start(): Promise<void>;
	stop(): Promise<void>;
	destroy(): Promise<void>;
	isReady(): Promise<boolean>;
	executeCommand(
		command: string,
		args?: string[],
		options?: { timeout?: number; cwd?: string },
	): Promise<CommandResult>;
	getSandboxPodIp?(): string | null;
	getDebugInfo?(): Record<string, unknown>;
}

/** Shared filesystem interface */
export interface Filesystem {
	readonly name: string;
	readFile(
		path: string,
		options?: { encoding?: string },
	): Promise<string | Buffer>;
	writeFile(
		path: string,
		content: string | Buffer | Uint8Array,
		options?: { recursive?: boolean },
	): Promise<void>;
	deleteFile(
		path: string,
		options?: { recursive?: boolean; force?: boolean },
	): Promise<void>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	readdir(path: string): Promise<FileEntry[]>;
	exists(path: string): Promise<boolean>;
	stat(path: string): Promise<FileStat>;
	shellEscape?(s: string): string;
}

export class LocalSandbox implements Sandbox {
	readonly name = "LocalSandbox";
	private readonly workDir: string;
	private readonly _timeout: number;

	constructor(workDir: string, timeout = 30_000) {
		this.workDir = workDir;
		this._timeout = timeout;
	}

	async start(): Promise<void> {
		// Ensure workspace exists
		if (!existsSync(this.workDir)) {
			await fsMkdir(this.workDir, { recursive: true });
		}
		console.log(`[sandbox] LocalSandbox started (workDir=${this.workDir})`);
	}

	async stop(): Promise<void> {
		console.log("[sandbox] LocalSandbox stopped");
	}

	async destroy(): Promise<void> {
		console.log("[sandbox] LocalSandbox destroyed");
	}

	async isReady(): Promise<boolean> {
		return true;
	}

	async executeCommand(
		command: string,
		args?: string[],
		options?: { timeout?: number; cwd?: string },
	): Promise<CommandResult> {
		const timeout = options?.timeout ?? this._timeout;
		const cwd = options?.cwd ?? this.workDir;

		let fullCommand: string;
		if (args && args.length > 0) {
			const escaped = args.map((a) =>
				a.includes(" ") ? `"${a.replace(/"/g, '\\"')}"` : a,
			);
			fullCommand = `${command} ${escaped.join(" ")}`;
		} else {
			fullCommand = command;
		}

		const startTime = Date.now();

		try {
			const { stdout, stderr } = await execFileAsync(
				"sh",
				["-c", fullCommand],
				{
					cwd,
					timeout,
					env: { ...buildAllowedEnv(), HOME: cwd },
					maxBuffer: 10 * 1024 * 1024, // 10MB
				},
			);

			return {
				command,
				args,
				stdout: stdout || "",
				stderr: stderr || "",
				exitCode: 0,
				success: true,
				executionTimeMs: Date.now() - startTime,
			};
		} catch (err: any) {
			const executionTimeMs = Date.now() - startTime;
			const isTimeout = err.killed || err.signal === "SIGTERM";

			return {
				command,
				args,
				stdout: err.stdout || "",
				stderr: err.stderr || err.message || "",
				exitCode: err.code ?? (isTimeout ? 124 : 1),
				success: false,
				executionTimeMs,
				timedOut: isTimeout,
			};
		}
	}

	getDebugInfo(): Record<string, unknown> {
		return {
			backend: "local",
			workDir: this.workDir,
			timeoutMs: this._timeout,
		};
	}
}

export class LocalFilesystem implements Filesystem {
	readonly name = "LocalFilesystem";
	private readonly _basePath: string;

	get basePath(): string {
		return this._basePath;
	}

	constructor(basePath: string) {
		this._basePath = basePath;
	}

	private resolvePath(userPath: string): string {
		if (userPath.startsWith("/")) return userPath;
		return resolve(this._basePath, userPath);
	}

	async readFile(
		path: string,
		options?: { encoding?: string },
	): Promise<string | Buffer> {
		const absPath = this.resolvePath(path);
		if (options?.encoding) {
			return readFile(absPath, {
				encoding: options.encoding as BufferEncoding,
			});
		}
		return readFile(absPath);
	}

	async writeFile(
		path: string,
		content: string | Buffer | Uint8Array,
		options?: { recursive?: boolean },
	): Promise<void> {
		const absPath = this.resolvePath(path);
		if (options?.recursive) {
			const dir = absPath.substring(0, absPath.lastIndexOf("/"));
			if (dir) {
				await fsMkdir(dir, { recursive: true });
			}
		}
		await writeFile(absPath, content);
	}

	async deleteFile(
		path: string,
		options?: { recursive?: boolean; force?: boolean },
	): Promise<void> {
		const absPath = this.resolvePath(path);
		await rm(absPath, {
			recursive: options?.recursive,
			force: options?.force,
		});
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		const absPath = this.resolvePath(path);
		await fsMkdir(absPath, { recursive: options?.recursive ?? true });
	}

	async readdir(path: string): Promise<FileEntry[]> {
		const absPath = this.resolvePath(path);
		const entries = await fsReaddir(absPath, { withFileTypes: true });
		return entries.map((e) => ({
			name: e.name,
			type: e.isDirectory() ? ("directory" as const) : ("file" as const),
		}));
	}

	async exists(path: string): Promise<boolean> {
		const absPath = this.resolvePath(path);
		return existsSync(absPath);
	}

	async stat(path: string): Promise<FileStat> {
		const absPath = this.resolvePath(path);
		const s = await fsStat(absPath);
		const name = absPath.split("/").pop() || "";
		return {
			name,
			path: absPath,
			type: s.isDirectory() ? "directory" : "file",
			size: s.size,
			createdAt: s.birthtime,
			modifiedAt: s.mtime,
		};
	}

	shellEscape(s: string): string {
		return `'${s.replace(/'/g, "'\\''")}'`;
	}
}

// ── Export Shared Instances ───────────────────────────────────

function createK8sSandbox(): K8sSandbox {
	const timeout = parseInt(process.env.SANDBOX_TIMEOUT_MS || "30000", 10);
	return new K8sSandbox({
		timeout,
		onStart: async () => {
			console.log("[sandbox] K8sSandbox started");
		},
		onStop: async () => {
			console.log("[sandbox] K8sSandbox stopped");
		},
		onDestroy: async () => {
			console.log("[sandbox] K8sSandbox destroyed");
		},
	});
}

function createLocalSandbox(): LocalSandbox {
	const timeout = parseInt(process.env.SANDBOX_TIMEOUT_MS || "30000", 10);
	return new LocalSandbox(WORKSPACE_PATH, timeout);
}

export const sandbox: Sandbox =
	SANDBOX_BACKEND === "k8s" ? createK8sSandbox() : createLocalSandbox();

export const filesystem: Filesystem =
	SANDBOX_BACKEND === "k8s"
		? new K8sRemoteFilesystem({
				sandbox: sandbox as K8sSandbox,
				basePath: "/app",
			})
		: new LocalFilesystem(WORKSPACE_PATH);

console.log(`[sandbox] Backend: ${SANDBOX_BACKEND}`);

// ── Helper for tool execution ─────────────────────────────────

/**
 * Execute a shell command string through the sandbox.
 */
export async function executeCommandViaSandbox(
	command: string,
	opts?: { timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const timeout =
		opts?.timeout ?? parseInt(process.env.SANDBOX_TIMEOUT_MS || "30000", 10);

	const result = await sandbox.executeCommand("sh", ["-c", command], {
		timeout,
	});
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
	};
}
