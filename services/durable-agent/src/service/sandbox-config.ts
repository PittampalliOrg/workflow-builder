/**
 * OpenShell-backed workspace runtime.
 *
 * SW 1.0 uses a single sandbox backend: OpenShell. Durable-agent keeps the
 * durable control loop, while all filesystem/process side effects execute
 * through openshell-agent-runtime using workspaceRef bindings.
 */

import { posix as pathPosix } from "node:path";
import { Agent, request } from "undici";

export interface CommandResult {
	command: string;
	args?: string[];
	stdout: string;
	stderr: string;
	exitCode: number;
	success: boolean;
	executionTimeMs: number;
	timedOut?: boolean;
}

export interface FileEntry {
	name: string;
	type: "file" | "directory";
}

export interface FileStat {
	name: string;
	path: string;
	type: "file" | "directory";
	size: number;
	createdAt: Date;
	modifiedAt: Date;
}

export const OPEN_SHELL_RUNTIME_BASE_URL =
	process.env.OPENSHELL_AGENT_RUNTIME_API_BASE_URL?.trim() ||
	"http://openshell-agent-runtime.openshell.svc.cluster.local:8083";

export const WORKSPACE_PATH = (
	process.env.AGENT_WORKSPACE_PATH || "/sandbox/shared/durable-agent"
).trim();

export const SANDBOX_BACKEND = "openshell" as const;

const OPEN_SHELL_HTTP_TIMEOUT_MS = Math.max(
	60_000,
	Number.parseInt(process.env.OPENSHELL_HTTP_TIMEOUT_MS || "", 10) ||
		60 * 60_000,
);
const openShellDispatcher = new Agent({
	headersTimeout: OPEN_SHELL_HTTP_TIMEOUT_MS,
	bodyTimeout: OPEN_SHELL_HTTP_TIMEOUT_MS,
});

export interface Sandbox {
	readonly name: string;
	start(): Promise<void>;
	stop(): Promise<void>;
	destroy(): Promise<void>;
	isReady(): Promise<boolean>;
	executeCommand(
		command: string,
		args?: string[],
		options?: { timeout?: number; cwd?: string; env?: Record<string, string> },
	): Promise<CommandResult>;
	getSandboxPodIp?(): string | null;
	getDebugInfo?(): Record<string, unknown>;
}

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

function shellEscape(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

async function postOpenShell<T>(
	path: string,
	payload: Record<string, unknown>,
): Promise<T> {
	const response = await request(`${OPEN_SHELL_RUNTIME_BASE_URL}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
		dispatcher: openShellDispatcher,
	});
	const text = await response.body.text();
	const parsed = text.trim()
		? (() => {
				try {
					return JSON.parse(text) as T & { error?: string };
				} catch {
					return ({ raw: text } as unknown) as T & { error?: string };
				}
			})()
		: ({} as T & { error?: string });
	if (response.statusCode < 200 || response.statusCode >= 300) {
		const error =
			typeof parsed === "object" && parsed && "error" in parsed
				? String(parsed.error || response.statusText)
				: response.statusText || "unknown error";
		throw new Error(`OpenShell ${path} failed (${response.statusCode}): ${error}`);
	}
	return parsed as T;
}

function buildCommand(command: string, args?: string[]): string {
	if (args && args.length > 0) {
		if (
			(command === "sh" || command === "bash") &&
			args[0] === "-c" &&
			typeof args[1] === "string"
		) {
			return args[1];
		}
		const escaped = args.map((arg) => shellEscape(String(arg))).join(" ");
		return `${command} ${escaped}`.trim();
	}
	return command.trim();
}

function withEnvPrefix(
	command: string,
	env?: Record<string, string>,
): string {
	if (!env) return command;
	const entries = Object.entries(env).filter(
		([key, value]) => /^[A-Z_][A-Z0-9_]*$/.test(key) && value.length > 0,
	);
	if (entries.length === 0) return command;
	const prefix = entries
		.map(([key, value]) => `${key}=${shellEscape(value)}`)
		.join(" ");
	return `${prefix} ${command}`;
}

export class OpenShellSandbox implements Sandbox {
	readonly name = "OpenShellSandbox";
	private started = false;
	private latestProfileDetails: Record<string, unknown> | null = null;

	constructor(
		private readonly workspaceRef: string,
		private readonly rootPath: string,
		private readonly commandTimeoutMs: number,
		private readonly executionId?: string,
		private readonly enabledTools?: string[],
	) {}

	async start(): Promise<void> {
		if (this.started) return;
		const profile = await postOpenShell<{
			sandbox?: {
				details?: Record<string, unknown>;
			};
		}>("/api/workspaces/profile", {
			workspaceRef: this.workspaceRef,
			rootPath: this.rootPath,
			commandTimeoutMs: this.commandTimeoutMs,
			...(this.executionId ? { executionId: this.executionId } : {}),
			...(this.enabledTools?.length ? { enabledTools: this.enabledTools } : {}),
		});
		this.latestProfileDetails =
			profile?.sandbox?.details && typeof profile.sandbox.details === "object"
				? profile.sandbox.details
				: null;
		this.started = true;
	}

	async stop(): Promise<void> {
		// No-op. Workspace lifecycle is managed explicitly via cleanup.
	}

	async destroy(): Promise<void> {
		await postOpenShell<{ cleanedWorkspaceRefs?: string[] }>(
			"/api/workspaces/cleanup",
			{
				workspaceRef: this.workspaceRef,
				...(this.executionId ? { executionId: this.executionId } : {}),
			},
		);
		this.started = false;
	}

	async isReady(): Promise<boolean> {
		try {
			await this.start();
			return true;
		} catch {
			return false;
		}
	}

	async executeCommand(
		command: string,
		args?: string[],
		options?: { timeout?: number; cwd?: string; env?: Record<string, string> },
	): Promise<CommandResult> {
		await this.start();
		const finalCommand = withEnvPrefix(buildCommand(command, args), options?.env);
		const result = await postOpenShell<{
			stdout?: string;
			stderr?: string;
			exitCode?: number;
			success?: boolean;
			executionTimeMs?: number;
			timedOut?: boolean;
		}>("/api/workspaces/command", {
			workspaceRef: this.workspaceRef,
			command: finalCommand,
			cwd: options?.cwd || this.rootPath,
			timeoutMs: options?.timeout ?? this.commandTimeoutMs,
			...(this.executionId ? { executionId: this.executionId } : {}),
		});
		return {
			command,
			args,
			stdout: String(result.stdout || ""),
			stderr: String(result.stderr || ""),
			exitCode: Number(result.exitCode ?? 1),
			success: Boolean(result.success),
			executionTimeMs: Number(result.executionTimeMs ?? 0),
			timedOut: Boolean(result.timedOut),
		};
	}

	getDebugInfo(): Record<string, unknown> {
		return {
			backend: SANDBOX_BACKEND,
			workspaceRef: this.workspaceRef,
			rootPath: this.rootPath,
			executionId: this.executionId,
			...(this.latestProfileDetails ?? {}),
		};
	}

	getWorkspaceRef(): string {
		return this.workspaceRef;
	}
}

export class OpenShellFilesystem implements Filesystem {
	readonly name = "OpenShellFilesystem";

	constructor(
		private readonly sandbox: OpenShellSandbox,
		private readonly basePath: string,
	) {}

	private resolvePath(userPath: string): string {
		if (!userPath || userPath === ".") return this.basePath;
		if (userPath.startsWith("/")) return pathPosix.normalize(userPath);
		return pathPosix.normalize(pathPosix.join(this.basePath, userPath));
	}

	async readFile(
		path: string,
		options?: { encoding?: string },
	): Promise<string | Buffer> {
		const absPath = this.resolvePath(path);
		const result = await this.sandbox.executeCommand(
			"sh",
			["-c", `cat -- ${shellEscape(absPath)}`],
			{ cwd: "/" },
		);
		if (!result.success || result.exitCode !== 0) {
			throw new Error(result.stderr || `Failed reading ${absPath}`);
		}
		if (options?.encoding) {
			return result.stdout;
		}
		return Buffer.from(result.stdout, "utf-8");
	}

	async writeFile(
		path: string,
		content: string | Buffer | Uint8Array,
		options?: { recursive?: boolean },
	): Promise<void> {
		const absPath = this.resolvePath(path);
		const payload = Buffer.isBuffer(content)
			? content
			: content instanceof Uint8Array
				? Buffer.from(content)
				: Buffer.from(content, "utf-8");
		if (options?.recursive) {
			const parent = pathPosix.dirname(absPath);
			await this.mkdir(parent, { recursive: true });
		}
		await postOpenShell("/api/workspaces/materialize-files", {
			workspaceRef: this.sandbox.getWorkspaceRef(),
			files: [
				{
					path: absPath,
					contentB64: payload.toString("base64"),
				},
			],
		});
	}

	async deleteFile(
		path: string,
		options?: { recursive?: boolean; force?: boolean },
	): Promise<void> {
		const absPath = this.resolvePath(path);
		const command =
			options?.recursive === true
				? `rm -rf -- ${shellEscape(absPath)}`
				: `rm ${options?.force ? "-f" : ""} -- ${shellEscape(absPath)}`.trim();
		const result = await this.sandbox.executeCommand("sh", ["-c", command], {
			cwd: "/",
		});
		if (!result.success && !(options?.force && result.exitCode === 1)) {
			throw new Error(result.stderr || `Failed deleting ${absPath}`);
		}
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		const absPath = this.resolvePath(path);
		const command =
			options?.recursive === false
				? `mkdir -- ${shellEscape(absPath)}`
				: `mkdir -p -- ${shellEscape(absPath)}`;
		const result = await this.sandbox.executeCommand("sh", ["-c", command], {
			cwd: "/",
		});
		if (!result.success || result.exitCode !== 0) {
			throw new Error(result.stderr || `Failed creating ${absPath}`);
		}
	}

	async readdir(path: string): Promise<FileEntry[]> {
		const absPath = this.resolvePath(path);
		const command = `find ${shellEscape(absPath)} -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\n'`;
		const result = await this.sandbox.executeCommand("sh", ["-c", command], {
			cwd: "/",
		});
		if (!result.success || result.exitCode !== 0) {
			throw new Error(result.stderr || `Failed listing ${absPath}`);
		}
		return result.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				const [name, type] = line.split("\t");
				return {
					name,
					type: type === "d" ? ("directory" as const) : ("file" as const),
				};
			});
	}

	async exists(path: string): Promise<boolean> {
		const absPath = this.resolvePath(path);
		const result = await this.sandbox.executeCommand(
			"sh",
			["-c", `test -e ${shellEscape(absPath)}`],
			{ cwd: "/" },
		);
		return result.success && result.exitCode === 0;
	}

	async stat(path: string): Promise<FileStat> {
		const absPath = this.resolvePath(path);
		const command = [
			`if [ -d ${shellEscape(absPath)} ]; then kind=directory;`,
			`elif [ -f ${shellEscape(absPath)} ]; then kind=file;`,
			"else exit 1; fi;",
			`stat_output=$(stat -c '%s\t%Y\t%W' ${shellEscape(absPath)});`,
			'printf "%s\\t%s\\n" "$kind" "$stat_output"',
		].join(" ");
		const result = await this.sandbox.executeCommand("sh", ["-c", command], {
			cwd: "/",
		});
		if (!result.success || result.exitCode !== 0) {
			throw new Error(result.stderr || `Failed stat for ${absPath}`);
		}
		const [kind = "file", sizeRaw = "0", modifiedRaw = "0", createdRaw = "0"] =
			result.stdout.trim().split("\t");
		const modifiedSeconds = Number.parseInt(modifiedRaw, 10) || 0;
		const createdSeconds = Number.parseInt(createdRaw, 10);
		return {
			name: pathPosix.basename(absPath),
			path: absPath,
			type: kind === "directory" ? "directory" : "file",
			size: Number.parseInt(sizeRaw, 10) || 0,
			createdAt: new Date(
				(createdSeconds > 0 ? createdSeconds : modifiedSeconds) * 1000,
			),
			modifiedAt: new Date(modifiedSeconds * 1000),
		};
	}

	shellEscape(value: string): string {
		return shellEscape(value);
	}
}

const sharedTimeoutMs = parseInt(process.env.SANDBOX_TIMEOUT_MS || "30000", 10);
const sharedWorkspaceRef =
	process.env.AGENT_SHARED_WORKSPACE_REF?.trim() || "durable-agent-shared";

export const sandbox: Sandbox = new OpenShellSandbox(
	sharedWorkspaceRef,
	WORKSPACE_PATH,
	sharedTimeoutMs,
	"shared",
);

export const filesystem: Filesystem = new OpenShellFilesystem(
	sandbox as OpenShellSandbox,
	WORKSPACE_PATH,
);

console.log(`[sandbox] Backend: ${SANDBOX_BACKEND}`);

export async function executeCommandViaSandbox(
	command: string,
	opts?: { timeout?: number; cwd?: string; env?: Record<string, string> },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const result = await sandbox.executeCommand("sh", ["-c", command], {
		timeout: opts?.timeout ?? sharedTimeoutMs,
		cwd: opts?.cwd ?? WORKSPACE_PATH,
		env: opts?.env,
	});
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
	};
}
