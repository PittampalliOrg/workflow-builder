/**
 * K8sRemoteFilesystem — Routes file operations through a K8s sandbox pod.
 *
 * Standalone implementation (no @mastra/core dependency). Ensures file reads/writes
 * and command execution share the same filesystem inside the sandbox pod.
 *
 * Uses the python-runtime-sandbox endpoints:
 * - POST /execute  — shell command execution
 * - POST /upload   — multipart file upload
 * - GET  /download/{path} — file download
 */

import type { K8sSandbox } from "./k8s-sandbox.js";

const SANDBOX_PORT = 8888;

// ── Types ─────────────────────────────────────────────────────

export interface FileEntry {
	name: string;
	type: "file" | "directory";
	size?: number;
}

export interface FileStat {
	name: string;
	path: string;
	type: "file" | "directory";
	size: number;
	createdAt: Date;
	modifiedAt: Date;
}

// ── Options ───────────────────────────────────────────────────

export interface K8sRemoteFilesystemOptions {
	sandbox: K8sSandbox;
	basePath?: string;
	timeout?: number;
}

// ── K8sRemoteFilesystem ───────────────────────────────────────

export class K8sRemoteFilesystem {
	readonly name = "K8sRemoteFilesystem";

	private readonly sandbox: K8sSandbox;
	private readonly _basePath: string;
	private readonly _timeout: number;

	get basePath(): string {
		return this._basePath;
	}

	constructor(options: K8sRemoteFilesystemOptions) {
		this.sandbox = options.sandbox;
		this._basePath = options.basePath || "/app";
		this._timeout = options.timeout || 30_000;
	}

	// ── Lifecycle ────────────────────────────────────────────

	private _basePathEnsured = false;
	private async ensureBasePath(): Promise<void> {
		if (this._basePathEnsured) return;
		await this.exec(`mkdir -p ${this.shellEscape(this._basePath)}`, true);
		this._basePathEnsured = true;
	}

	// ── File Operations ──────────────────────────────────────

	async readFile(
		inputPath: string,
		options?: { encoding?: string },
	): Promise<string | Buffer> {
		const absPath = this.resolvePath(inputPath);
		const podIp = this.requirePodIp();
		await this.ensureBasePath();

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this._timeout);

		try {
			const res = await fetch(
				`http://${podIp}:${SANDBOX_PORT}/download/${encodeURIComponent(absPath)}`,
				{ signal: controller.signal },
			);

			if (!res.ok) {
				return this.readFileViaExec(absPath, options);
			}

			if (options?.encoding) {
				return await res.text();
			}
			const arrayBuf = await res.arrayBuffer();
			return Buffer.from(arrayBuf);
		} finally {
			clearTimeout(timer);
		}
	}

	async writeFile(
		inputPath: string,
		content: string | Buffer | Uint8Array,
		options?: { recursive?: boolean },
	): Promise<void> {
		const absPath = this.resolvePath(inputPath);

		// Ensure parent directory exists if recursive
		if (options?.recursive !== false) {
			const dir = absPath.substring(0, absPath.lastIndexOf("/"));
			if (dir) {
				await this.exec(`mkdir -p ${this.shellEscape(dir)}`);
			}
		}

		const buf = this.toBuffer(content);

		// For large files (>1MB), use the /upload endpoint
		if (buf.length > 1_048_576) {
			await this.uploadFile(absPath, buf);
			return;
		}

		// For smaller files, use base64 via exec
		const b64 = buf.toString("base64");
		const result = await this.exec(
			`echo ${this.shellEscape(b64)} | base64 -d > ${this.shellEscape(absPath)}`,
		);
		if (result.exit_code !== 0) {
			this.throwMappedError(result.stderr, absPath);
		}
	}

	async deleteFile(
		inputPath: string,
		options?: { recursive?: boolean; force?: boolean },
	): Promise<void> {
		const absPath = this.resolvePath(inputPath);
		const flags = [];
		if (options?.recursive) flags.push("-r");
		if (options?.force) flags.push("-f");
		const flagStr = flags.length > 0 ? ` ${flags.join(" ")}` : "";

		const result = await this.exec(`rm${flagStr} ${this.shellEscape(absPath)}`);
		if (result.exit_code !== 0 && !options?.force) {
			this.throwMappedError(result.stderr, absPath);
		}
	}

	async mkdir(
		inputPath: string,
		options?: { recursive?: boolean },
	): Promise<void> {
		const absPath = this.resolvePath(inputPath);
		const flags = options?.recursive !== false ? "-p" : "";
		const flagStr = flags ? ` ${flags}` : "";

		const result = await this.exec(
			`mkdir${flagStr} ${this.shellEscape(absPath)}`,
		);
		if (result.exit_code !== 0) {
			this.throwMappedError(result.stderr, absPath);
		}
	}

	async readdir(inputPath: string): Promise<FileEntry[]> {
		const absPath = this.resolvePath(inputPath);

		const result = await this.exec(
			`find ${this.shellEscape(absPath)} -maxdepth 1 -mindepth 1 -exec stat --format='%n\t%F\t%s' {} \\;`,
		);

		if (result.exit_code !== 0) {
			this.throwMappedError(result.stderr, absPath);
		}

		const entries: FileEntry[] = [];
		const lines = result.stdout.trim().split("\n").filter(Boolean);

		for (const line of lines) {
			const [fullPath, fileType, sizeStr] = line.split("\t");
			if (!fullPath) continue;

			const name = fullPath.split("/").pop() || fullPath;
			const type =
				fileType === "directory" ? ("directory" as const) : ("file" as const);
			const size = parseInt(sizeStr || "0", 10);

			entries.push({ name, type, size });
		}

		return entries;
	}

	async exists(inputPath: string): Promise<boolean> {
		const absPath = this.resolvePath(inputPath);
		const result = await this.exec(
			`test -e ${this.shellEscape(absPath)} && echo true || echo false`,
		);
		return result.stdout.trim() === "true";
	}

	async stat(inputPath: string): Promise<FileStat> {
		const absPath = this.resolvePath(inputPath);

		const result = await this.exec(
			`stat --format='%n\t%F\t%s\t%W\t%Y' ${this.shellEscape(absPath)}`,
		);

		if (result.exit_code !== 0) {
			this.throwMappedError(result.stderr, absPath);
		}

		const parts = result.stdout.trim().split("\t");
		const [fullPath, fileType, sizeStr, birthStr, mtimeStr] = parts;

		const name = (fullPath || absPath).split("/").pop() || "";
		const type =
			fileType === "directory" ? ("directory" as const) : ("file" as const);
		const size = parseInt(sizeStr || "0", 10);

		const birthEpoch = parseInt(birthStr || "0", 10);
		const mtimeEpoch = parseInt(mtimeStr || "0", 10);

		return {
			name,
			path: absPath,
			type,
			size,
			createdAt:
				birthEpoch > 0
					? new Date(birthEpoch * 1000)
					: new Date(mtimeEpoch * 1000),
			modifiedAt: new Date(mtimeEpoch * 1000),
		};
	}

	// ── Private Helpers ──────────────────────────────────────

	/** Execute a shell command on the sandbox pod via POST /execute. */
	private async exec(
		shellCmd: string,
		skipBasePath = false,
	): Promise<{ stdout: string; stderr: string; exit_code: number }> {
		const podIp = this.requirePodIp();
		if (!skipBasePath) await this.ensureBasePath();

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this._timeout);

		try {
			const wrappedCmd = `/bin/sh -c ${this.shellEscape(shellCmd)}`;
			const res = await fetch(`http://${podIp}:${SANDBOX_PORT}/execute`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ command: wrappedCmd }),
				signal: controller.signal,
			});

			if (!res.ok) {
				const text = await res.text();
				throw new Error(`Sandbox /execute returned ${res.status}: ${text}`);
			}

			return (await res.json()) as {
				stdout: string;
				stderr: string;
				exit_code: number;
			};
		} finally {
			clearTimeout(timer);
		}
	}

	/** Upload a file via POST /upload (multipart/form-data). */
	private async uploadFile(absPath: string, buf: Buffer): Promise<void> {
		const podIp = this.requirePodIp();
		const fileName = absPath.split("/").pop() || "file";

		const dir = absPath.substring(0, absPath.lastIndexOf("/"));
		if (dir) {
			await this.exec(`mkdir -p ${this.shellEscape(dir)}`);
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this._timeout * 2);

		try {
			const formData = new FormData();
			const blob = new Blob([buf as unknown as BlobPart]);
			formData.append("file", blob, fileName);

			const res = await fetch(`http://${podIp}:${SANDBOX_PORT}/upload`, {
				method: "POST",
				body: formData,
				signal: controller.signal,
			});

			if (!res.ok) {
				const text = await res.text();
				throw new Error(`Sandbox /upload returned ${res.status}: ${text}`);
			}

			// Move to the desired path
			const uploadedPath = `/app/${fileName}`;
			if (uploadedPath !== absPath) {
				await this.exec(
					`mv ${this.shellEscape(uploadedPath)} ${this.shellEscape(absPath)}`,
				);
			}
		} finally {
			clearTimeout(timer);
		}
	}

	private requirePodIp(): string {
		const podIp = this.sandbox.getSandboxPodIp();
		if (!podIp) {
			throw new Error("K8sRemoteFilesystem: sandbox pod not ready");
		}
		return podIp;
	}

	/** Escape a string for safe use inside single-quoted shell arguments. */
	shellEscape(s: string): string {
		return `'${s.replace(/'/g, "'\\''")}'`;
	}

	private resolvePath(userPath: string): string {
		if (userPath.startsWith("/")) {
			const normalized = normalizePosixPath(userPath);
			if (
				!normalized.startsWith(this._basePath) &&
				normalized !== this._basePath
			) {
				throw new Error(
					`Path "${userPath}" escapes base path "${this._basePath}"`,
				);
			}
			return normalized;
		}

		const resolved = `${this._basePath}/${userPath}`;
		const normalized = normalizePosixPath(resolved);
		if (
			!normalized.startsWith(this._basePath) &&
			normalized !== this._basePath
		) {
			throw new Error(
				`Path "${userPath}" escapes base path "${this._basePath}"`,
			);
		}
		return normalized;
	}

	private toBuffer(content: string | Buffer | Uint8Array): Buffer {
		if (Buffer.isBuffer(content)) return content;
		if (content instanceof Uint8Array) return Buffer.from(content);
		return Buffer.from(content, "utf-8");
	}

	/**
	 * Fallback file read path using /execute when /download is not implemented by
	 * the sandbox runtime. Returns base64 to keep binary-safe transport.
	 */
	private async readFileViaExec(
		absPath: string,
		options?: { encoding?: string },
	): Promise<string | Buffer> {
		const cmd = [
			`if [ ! -e ${this.shellEscape(absPath)} ]; then`,
			`  echo "No such file or directory" 1>&2;`,
			"  exit 2;",
			"fi;",
			`if [ -d ${this.shellEscape(absPath)} ]; then`,
			`  echo "Is a directory" 1>&2;`,
			"  exit 21;",
			"fi;",
			`base64 ${this.shellEscape(absPath)} | tr -d '\\n'`,
		].join(" ");

		const result = await this.exec(cmd);
		if (result.exit_code !== 0) {
			this.throwMappedError(result.stderr || result.stdout, absPath);
		}

		const bytes = Buffer.from(result.stdout.trim(), "base64");
		if (options?.encoding) {
			const encoding = options.encoding as BufferEncoding;
			return bytes.toString(encoding);
		}
		return bytes;
	}

	private throwMappedError(stderr: string, path: string): never {
		const msg = stderr.trim().toLowerCase();
		if (msg.includes("no such file")) {
			throw new Error(`ENOENT: no such file or directory: ${path}`);
		}
		if (msg.includes("is a directory")) {
			throw new Error(`EISDIR: illegal operation on a directory: ${path}`);
		}
		if (msg.includes("file exists")) {
			throw new Error(`EEXIST: file already exists: ${path}`);
		}
		if (msg.includes("permission denied")) {
			throw new Error(`EACCES: permission denied: ${path}`);
		}
		if (msg.includes("directory not empty")) {
			throw new Error(`ENOTEMPTY: directory not empty: ${path}`);
		}
		if (msg.includes("not a directory")) {
			throw new Error(`ENOTDIR: not a directory: ${path}`);
		}
		throw new Error(`Filesystem error on "${path}": ${stderr.trim()}`);
	}
}

// ── Path Utilities ───────────────────────────────────────────

function normalizePosixPath(p: string): string {
	const parts = p.split("/");
	const resolved: string[] = [];

	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			resolved.pop();
		} else {
			resolved.push(part);
		}
	}

	return "/" + resolved.join("/");
}
