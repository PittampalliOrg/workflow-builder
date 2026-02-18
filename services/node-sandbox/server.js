/**
 * Node.js Runtime Sandbox Server
 *
 * Drop-in replacement for python-runtime-sandbox that provides:
 *   - POST /execute  — run a shell command, return { stdout, stderr, exit_code }
 *   - POST /upload   — accept multipart file upload (saves to /app/)
 *   - GET  /download/{path} — return file bytes for remote filesystem reads
 *   - GET  /          — readiness probe
 *   - GET  /health    — health check
 *
 * Runs as UID 1000 (non-root) with git, Node.js, and common dev tools.
 */

const http = require("node:http");
const { execFile } = require("node:child_process");
const { writeFileSync, readFileSync, statSync } = require("node:fs");
const { basename, join, normalize, resolve } = require("node:path");

const PORT = parseInt(process.env.PORT || "8888", 10);
const WORK_DIR = process.env.WORKSPACE_DIR || "/app";
const SHELL = process.env.SANDBOX_SHELL || "/bin/bash";
const HOME_DIR = process.env.HOME || "/home/node";
const WORKSPACE_ALIASES = [
	"/workspace",
	"/home/node/workspace",
	"/home/user/workspace",
];

// ── Helpers ─────────────────────────────────────────────────

function parseJson(req) {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			try {
				resolve(JSON.parse(body));
			} catch {
				reject(new Error("Invalid JSON"));
			}
		});
		req.on("error", reject);
	});
}

function parseMultipart(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const buf = Buffer.concat(chunks);
			const contentType = req.headers["content-type"] || "";
			const boundaryMatch = contentType.match(/boundary=(.+)/);
			if (!boundaryMatch) {
				reject(new Error("No boundary in multipart request"));
				return;
			}
			const boundary = boundaryMatch[1];
			const parts = buf
				.toString("binary")
				.split(`--${boundary}`)
				.filter((p) => p.trim() && p.trim() !== "--");

			const files = [];
			for (const part of parts) {
				const headerEnd = part.indexOf("\r\n\r\n");
				if (headerEnd === -1) continue;
				const headers = part.slice(0, headerEnd);
				const content = part.slice(headerEnd + 4).replace(/\r\n$/, "");
				const nameMatch = headers.match(/filename="(.+?)"/);
				if (nameMatch) {
					files.push({
						filename: nameMatch[1],
						content: Buffer.from(content, "binary"),
					});
				}
			}
			resolve(files);
		});
		req.on("error", reject);
	});
}

function sendJson(res, status, data) {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
	res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
	res.end(text);
}

function resolveSafePath(inputPath) {
	const normalizedWorkDir = normalize(resolve(WORK_DIR));
	let requested = String(inputPath || "");
	if (!requested) {
		throw new Error("path is required");
	}
	for (const alias of WORKSPACE_ALIASES) {
		if (requested === alias) {
			requested = normalizedWorkDir;
			break;
		}
		const aliasPrefix = `${alias}/`;
		if (requested.startsWith(aliasPrefix)) {
			requested = resolve(
				normalizedWorkDir,
				requested.slice(aliasPrefix.length),
			);
			break;
		}
	}
	const resolvedPath = requested.startsWith("/")
		? normalize(requested)
		: normalize(resolve(normalizedWorkDir, requested));
	const withinWorkDir =
		resolvedPath === normalizedWorkDir ||
		resolvedPath.startsWith(`${normalizedWorkDir}/`);
	if (!withinWorkDir) {
		throw new Error(`Path escapes sandbox root: ${requested}`);
	}
	return resolvedPath;
}

// ── Execute Command ──────────────────────────────────────────

function executeCommand(command, timeoutMs = 120000) {
	return new Promise((resolve) => {
		execFile(
			SHELL,
			["-lc", command],
			{
				cwd: WORK_DIR,
				timeout: timeoutMs,
				maxBuffer: 10 * 1024 * 1024, // 10MB
				env: { ...process.env, HOME: HOME_DIR, WORKSPACE_DIR: WORK_DIR },
			},
			(error, stdout, stderr) => {
				let exitCode = 0;
				if (error) {
					exitCode = error.code ?? 1;
					if (error.killed) exitCode = 124; // timeout
					if (!stderr && error.message) {
						stderr = error.message;
					}
				}
				resolve({
					stdout: stdout || "",
					stderr: stderr || "",
					exit_code: exitCode,
				});
			},
		);
	});
}

// ── HTTP Server ──────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	const path = url.pathname;
	const method = req.method;

	// Readiness / Health
	if (path === "/" && method === "GET") {
		return sendJson(res, 200, { status: "ready" });
	}
	if (path === "/health" && method === "GET") {
		return sendJson(res, 200, {
			status: "healthy",
			runtime: "node",
			node_version: process.version,
			work_dir: WORK_DIR,
		});
	}

	// Execute command
	if (path === "/execute" && method === "POST") {
		try {
			const body = await parseJson(req);
			const command = body.command;
			if (!command || typeof command !== "string") {
				return sendJson(res, 400, { error: "command is required" });
			}
			const timeoutMs = Number(body.timeout) || 120000;
			const result = await executeCommand(command, timeoutMs);
			return sendJson(res, 200, result);
		} catch (err) {
			return sendJson(res, 400, { error: err.message });
		}
	}

	// File upload
	if (path === "/upload" && method === "POST") {
		try {
			const files = await parseMultipart(req);
			const saved = [];
			for (const file of files) {
				const safeName = basename(file.filename);
				const dest = join(WORK_DIR, safeName);
				writeFileSync(dest, file.content);
				saved.push({
					filename: safeName,
					path: dest,
					size: file.content.length,
				});
			}
			return sendJson(res, 200, { success: true, files: saved });
		} catch (err) {
			return sendJson(res, 400, { error: err.message });
		}
	}

	// File download
	if (path.startsWith("/download/") && method === "GET") {
		try {
			const raw = decodeURIComponent(path.replace("/download/", ""));
			const filePath = resolveSafePath(raw);
			const stat = statSync(filePath);
			if (stat.isDirectory()) {
				return sendText(res, 400, "Is a directory");
			}
			const content = readFileSync(filePath);
			res.writeHead(200, {
				"Content-Type": "application/octet-stream",
				"Content-Length": String(content.length),
			});
			return res.end(content);
		} catch (err) {
			const msg = String(err?.message || err);
			if (msg.includes("ENOENT")) {
				return sendText(res, 404, "No such file or directory");
			}
			return sendText(res, 400, msg);
		}
	}

	// Not found
	sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
	console.log(`[node-sandbox] Listening on port ${PORT} (workdir=${WORK_DIR})`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
	console.log("[node-sandbox] SIGTERM received, shutting down");
	server.close(() => process.exit(0));
});
