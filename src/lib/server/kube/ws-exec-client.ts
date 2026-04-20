import { WebSocket } from "ws";
import { getToken, getKubeCA, KUBE_HOST, KUBE_PORT } from "./client";

/**
 * Low-level WebSocket client for the Kubernetes `pods/exec` endpoint.
 *
 *   wss://<k8s>/api/v1/namespaces/<ns>/pods/<pod>/exec
 *        ?container=<c>&command=<cmd>&stdin=1&stdout=1&stderr=1&tty=<bool>
 *
 * Subprotocol `v4.channel.k8s.io` frames each payload with a one-byte
 * channel id prefix:
 *   0 stdin   (client -> server)
 *   1 stdout  (server -> client)
 *   2 stderr  (server -> client)
 *   3 error   (server -> client; JSON `{status, message, reason, code}`)
 *   4 resize  (client -> server; JSON `{Width, Height}`)
 *
 * The `src/lib/server/kube/client.ts` HTTPS client isn't usable here —
 * it speaks HTTP/1.1 only. We reuse its token + CA for auth.
 */

const V4_SUBPROTOCOL = "v4.channel.k8s.io";

const CHANNEL_STDIN = 0;
const CHANNEL_STDOUT = 1;
const CHANNEL_STDERR = 2;
const CHANNEL_ERROR = 3;
const CHANNEL_RESIZE = 4;

export type ExecBatchResult = {
	stdout: Buffer;
	stderr: Buffer;
	/** exit code as reported by the `error` channel (0 on clean exit). */
	exitCode: number;
};

export type InteractiveExecSession = {
	/** Receive raw stdout bytes (channel 1). */
	onStdout(fn: (chunk: Buffer) => void): void;
	/** Receive raw stderr bytes (channel 2). */
	onStderr(fn: (chunk: Buffer) => void): void;
	/** Receive an error channel frame (channel 3). */
	onError(fn: (err: { code?: number; message?: string; reason?: string }) => void): void;
	/** Receive a close event (clean or otherwise). */
	onClose(fn: (code: number, reason: string) => void): void;
	/** Send bytes on stdin. */
	writeStdin(chunk: Buffer): void;
	/** Send a terminal resize. */
	resize(cols: number, rows: number): void;
	/** Close the connection. */
	close(): void;
};

function buildExecPath(
	namespace: string,
	pod: string,
	container: string,
	command: string[],
	opts: { tty: boolean; stdin: boolean; stdout: boolean; stderr: boolean },
): string {
	const params = new URLSearchParams();
	params.set("container", container);
	if (opts.stdin) params.set("stdin", "true");
	if (opts.stdout) params.set("stdout", "true");
	if (opts.stderr) params.set("stderr", "true");
	if (opts.tty) params.set("tty", "true");
	for (const c of command) params.append("command", c);
	return `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/exec?${params.toString()}`;
}

async function openExecSocket(
	namespace: string,
	pod: string,
	container: string,
	command: string[],
	opts: { tty: boolean; stdin: boolean; stdout: boolean; stderr: boolean },
): Promise<WebSocket> {
	const [token, ca] = await Promise.all([getToken(), getKubeCA()]);
	const path = buildExecPath(namespace, pod, container, command, opts);
	const url = `wss://${KUBE_HOST}:${KUBE_PORT}${path}`;
	return new WebSocket(url, [V4_SUBPROTOCOL], {
		headers: { Authorization: `Bearer ${token}` },
		ca,
		// Keep default handshakeTimeout; pod exec is fast to negotiate.
	});
}

/**
 * Run a one-shot command, collect stdout/stderr, resolve with exit code.
 * Streams stdin up front if provided; does not accept TTY frames.
 */
export async function execBatch(
	namespace: string,
	pod: string,
	container: string,
	command: string[],
	opts: { stdin?: Buffer; timeoutMs?: number } = {},
): Promise<ExecBatchResult> {
	const ws = await openExecSocket(namespace, pod, container, command, {
		tty: false,
		stdin: !!opts.stdin,
		stdout: true,
		stderr: true,
	});
	const timeoutMs = opts.timeoutMs ?? 30_000;
	return new Promise((resolve, reject) => {
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let exitCode = 0;
		const timer = setTimeout(() => {
			try {
				ws.close(1000, "timeout");
			} catch {
				/* noop */
			}
			reject(new Error(`kube exec timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		ws.on("open", () => {
			if (opts.stdin && opts.stdin.length > 0) {
				ws.send(Buffer.concat([Buffer.from([CHANNEL_STDIN]), opts.stdin]));
			}
		});
		ws.on("message", (data) => {
			const buf = Buffer.isBuffer(data)
				? data
				: data instanceof ArrayBuffer
				? Buffer.from(new Uint8Array(data))
				: Buffer.concat(data as Buffer[]);
			if (buf.length < 1) return;
			const channel = buf[0];
			const payload = buf.subarray(1);
			if (channel === CHANNEL_STDOUT) stdout.push(payload);
			else if (channel === CHANNEL_STDERR) stderr.push(payload);
			else if (channel === CHANNEL_ERROR) {
				try {
					const msg = JSON.parse(payload.toString("utf8")) as {
						status?: string;
						code?: number;
						message?: string;
						details?: { causes?: Array<{ reason?: string; message?: string }> };
					};
					if (msg.status === "Success") {
						exitCode = 0;
					} else {
						const cause = msg.details?.causes?.find((c) => c.reason === "ExitCode");
						const parsed = cause?.message ? Number.parseInt(cause.message, 10) : NaN;
						exitCode = Number.isFinite(parsed) ? parsed : msg.code ?? 1;
					}
				} catch {
					exitCode = 1;
				}
			}
		});
		ws.on("close", () => {
			clearTimeout(timer);
			resolve({
				stdout: Buffer.concat(stdout),
				stderr: Buffer.concat(stderr),
				exitCode,
			});
		});
		ws.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/**
 * Open an interactive TTY session. Returns a handle the caller pumps bytes
 * through — intended for the /api/v1/sessions/<id>/shell WS proxy.
 */
export async function execInteractive(
	namespace: string,
	pod: string,
	container: string,
	command: string[],
): Promise<InteractiveExecSession> {
	const ws = await openExecSocket(namespace, pod, container, command, {
		tty: true,
		stdin: true,
		stdout: true,
		stderr: true,
	});

	const stdoutHandlers: Array<(c: Buffer) => void> = [];
	const stderrHandlers: Array<(c: Buffer) => void> = [];
	const errorHandlers: Array<(e: { code?: number; message?: string; reason?: string }) => void> = [];
	const closeHandlers: Array<(code: number, reason: string) => void> = [];

	await new Promise<void>((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", (err) => reject(err));
	});

	ws.on("message", (data) => {
		const buf = Buffer.isBuffer(data)
			? data
			: data instanceof ArrayBuffer
			? Buffer.from(new Uint8Array(data))
			: Buffer.concat(data as Buffer[]);
		if (buf.length < 1) return;
		const channel = buf[0];
		const payload = buf.subarray(1);
		if (channel === CHANNEL_STDOUT) for (const h of stdoutHandlers) h(payload);
		else if (channel === CHANNEL_STDERR) for (const h of stderrHandlers) h(payload);
		else if (channel === CHANNEL_ERROR) {
			try {
				const m = JSON.parse(payload.toString("utf8")) as {
					status?: string;
					message?: string;
					code?: number;
					reason?: string;
				};
				for (const h of errorHandlers) h({ message: m.message, code: m.code, reason: m.reason });
			} catch {
				for (const h of errorHandlers) h({ message: payload.toString("utf8") });
			}
		}
	});

	ws.on("close", (code, reason) => {
		const r = reason?.toString?.("utf8") ?? "";
		for (const h of closeHandlers) h(code, r);
	});

	return {
		onStdout(fn) {
			stdoutHandlers.push(fn);
		},
		onStderr(fn) {
			stderrHandlers.push(fn);
		},
		onError(fn) {
			errorHandlers.push(fn);
		},
		onClose(fn) {
			closeHandlers.push(fn);
		},
		writeStdin(chunk) {
			if (ws.readyState !== WebSocket.OPEN) return;
			ws.send(Buffer.concat([Buffer.from([CHANNEL_STDIN]), chunk]));
		},
		resize(cols, rows) {
			if (ws.readyState !== WebSocket.OPEN) return;
			const payload = Buffer.from(JSON.stringify({ Width: cols, Height: rows }), "utf8");
			ws.send(Buffer.concat([Buffer.from([CHANNEL_RESIZE]), payload]));
		},
		close() {
			try {
				ws.close(1000, "client close");
			} catch {
				/* noop */
			}
		},
	};
}
