/**
 * Live preview for interactive-cli sessions: reach the app a CLI agent built in
 * its sandbox (`/sandbox/work/repo`) from a browser, over the BFF's existing
 * tailnet hostname — no per-pod tailscale, no second sandbox.
 *
 * The BFF resolves the session's live cli-agent-py pod IP (the same path the
 * cli-terminal WS proxy uses), starts a dev/preview server bound to 0.0.0.0 in
 * the pod (so it's reachable cross-pod), and reverse-proxies HTTP to it,
 * rewriting root-relative asset URLs to stay under the proxy path (logic mirrors
 * the openshell sandbox-preview proxy).
 *
 * CLI pods live in the workflow-builder namespace and ARE reachable by pod-IP
 * from the BFF (cli-workspace-command + cli-terminal already rely on this); the
 * `openshell`-namespace NetworkPolicy does not apply here.
 */
import http from "node:http";
import { getAgentWorkflowHostPod } from "$lib/server/kube/client";
import { resolveSessionRuntimeDebugTarget } from "$lib/server/sessions/runtime-target";
import { getRuntimeDescriptor } from "$lib/server/agents/runtime-registry";
import { env } from "$env/dynamic/private";

export const CLI_PREVIEW_DEFAULT_PORT = 4321;
const CLI_AGENT_PORT = 8002;

export type CliPreviewTarget = { podIP: string; runtime: string };

/** Resolve the live cli pod IP for a session (interactive-cli only). */
export async function resolveCliPreviewTarget(
	sessionId: string,
	projectId: string | undefined,
): Promise<
	| { ok: true; target: CliPreviewTarget }
	| { ok: false; status: number; message: string }
> {
	const target = await resolveSessionRuntimeDebugTarget(sessionId, projectId);
	if (!target) return { ok: false, status: 404, message: "Session not found in workspace" };
	const descriptor = getRuntimeDescriptor(target.agentRuntime);
	if (descriptor?.capabilities?.interactiveTerminal !== true) {
		return {
			ok: false,
			status: 409,
			message: "Session runtime is not an interactive-cli runtime",
		};
	}
	const appId = target.appId;
	if (!appId) return { ok: false, status: 503, message: "Session has no runtime app-id" };
	const pod = await getAgentWorkflowHostPod(appId);
	if (!pod?.podIP) return { ok: false, status: 503, message: "Agent pod not running" };
	return { ok: true, target: { podIP: pod.podIP, runtime: target.agentRuntime ?? "" } };
}

function internalToken(): string {
	return env.INTERNAL_API_TOKEN ?? process.env.INTERNAL_API_TOKEN ?? "";
}

/** Low-level POST to cli-agent-py /internal/workspace/command (node http, long idle). */
function podCommand(
	podIP: string,
	command: string,
	cwd: string,
	timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string } | null> {
	const payload = JSON.stringify({ command, cwd, timeout: Math.ceil(timeoutMs / 1000) });
	return new Promise((resolve) => {
		const req = http.request(
			{
				host: podIP,
				port: CLI_AGENT_PORT,
				path: "/internal/workspace/command",
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": String(Buffer.byteLength(payload)),
					"X-Internal-Token": internalToken(),
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(Buffer.from(c)));
				res.on("end", () => {
					if ((res.statusCode ?? 0) >= 400) return resolve(null);
					try {
						const j = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
							exit_code?: number;
							stdout_tail?: string;
							stderr_tail?: string;
						};
						resolve({
							exitCode: typeof j.exit_code === "number" ? j.exit_code : 1,
							stdout: j.stdout_tail ?? "",
							stderr: j.stderr_tail ?? "",
						});
					} catch {
						resolve(null);
					}
				});
				res.on("error", () => resolve(null));
			},
		);
		req.setTimeout(timeoutMs + 5_000, () => {
			req.destroy();
			resolve(null);
		});
		req.on("error", () => resolve(null));
		req.write(payload);
		req.end();
	});
}

/**
 * Start (or restart) a preview server in the pod, bound to 0.0.0.0 so the BFF
 * can reach it cross-pod. Prefers the built `preview` server; falls back to the
 * dev server. Returns once the server answers locally (or the wait elapses).
 */
export async function startCliPreview(
	podIP: string,
	opts: { cwd: string; port: number; previewCommand?: string },
): Promise<{ ready: boolean; log: string }> {
	const port = opts.port;
	const override = (opts.previewCommand ?? "").trim();
	const overrideExport =
		override && override !== "auto" ? override.replace(/'/g, "'\\''") : "";
	// Shell: stop any prior server on the port, auto-detect the preview command
	// (override wins), start it backgrounded on 0.0.0.0, then poll readiness.
	const script = `
set -u
PORT=${port}
cd "${opts.cwd}" 2>/dev/null || cd /sandbox/work/repo 2>/dev/null || true
fuser -k ${port}/tcp 2>/dev/null || true
pkill -f "vite preview" 2>/dev/null || true
pkill -f "vite dev" 2>/dev/null || true
OVERRIDE='${overrideExport}'
if [ -n "$OVERRIDE" ]; then PREVIEW="$OVERRIDE";
elif [ -f pnpm-lock.yaml ]; then PREVIEW="pnpm preview";
elif [ -f package.json ]; then PREVIEW="npm run preview --";
else PREVIEW=""; fi
DEV="npm run dev --"
start() { ( nohup sh -c "$1 --host 0.0.0.0 --port $PORT --strictPort" >/tmp/wfb-preview.log 2>&1 & ) || true; }
wait_ready() { for i in $(seq 1 "$1"); do curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
if [ -n "$PREVIEW" ]; then start "$PREVIEW"; fi
if ! wait_ready 25; then
  pkill -f "vite preview" 2>/dev/null || true
  start "$DEV"
  wait_ready 40 || true
fi
if curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then echo "PREVIEW_READY port=$PORT"; else echo "PREVIEW_NOT_READY"; fi
tail -8 /tmp/wfb-preview.log 2>/dev/null || true
`.trim();
	const res = await podCommand(podIP, script, opts.cwd, 90_000);
	const log = res ? `${res.stdout}\n${res.stderr}`.trim() : "no response from cli pod";
	return { ready: !!res && /PREVIEW_READY/.test(res.stdout), log };
}

// --- HTTP reverse proxy to pod-IP:port (mirrors the openshell preview proxy) ---

const FORWARDED_HEADERS = ["accept", "accept-language", "content-type", "user-agent", "cache-control"];
const JS_CONTENT_TYPES = ["text/javascript", "application/javascript", "application/x-javascript"];

function rewriteHtml(body: string, base: string): string {
	const b = base.replace(/\/$/, "");
	let out = body
		.replace(
			/\b((?:href|src|action|poster|formaction|data-src|data-href)\s*=\s*["'])\/(?!\/)/gi,
			(_m, p: string) => `${p}${b}/`,
		)
		.replace(/(url\((?:['"]?)?)\/(?!\/)/g, (_m, p: string) => `${p}${b}/`);
	const baseTag = `<base href="${b}/">`;
	if (/<base\b/i.test(out)) out = out.replace(/<base\b[^>]*>/i, baseTag);
	else if (/<head\b[^>]*>/i.test(out)) out = out.replace(/<head\b[^>]*>/i, (m) => `${m}\n  ${baseTag}`);
	return out;
}
function rewriteJs(body: string, base: string): string {
	const b = base.replace(/\/$/, "");
	return body
		.replace(/\b(import\s*\(\s*["'])\/(?!\/)/g, `$1${b}/`)
		.replace(/\b(import\s+["'])\/(?!\/)/g, `$1${b}/`)
		.replace(/\b(from\s+["'])\/(?!\/)/g, `$1${b}/`);
}
function rewriteLocation(loc: string, base: string): string {
	if (loc.startsWith("http://") || loc.startsWith("https://") || loc.startsWith(base)) return loc;
	if (loc.startsWith("/")) return `${base}${loc}`;
	return `${base}/${loc.replace(/^\.?\//, "")}`;
}

/** Proxy one browser request to the pod's preview server, rewriting URLs. */
export async function proxyCliPreview(
	podIP: string,
	port: number,
	request: Request,
	restPath: string,
	search: string,
	proxyBasePath: string,
): Promise<Response> {
	const headers: Record<string, string> = {};
	for (const h of FORWARDED_HEADERS) {
		const v = request.headers.get(h);
		if (v) headers[h] = v;
	}
	const method = request.method;
	const bodyBuf =
		method === "GET" || method === "HEAD" ? undefined : Buffer.from(await request.arrayBuffer());

	const upstream = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer } | null>(
		(resolve) => {
			const req = http.request(
				{ host: podIP, port, path: `${restPath}${search}`, method, headers },
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c) => chunks.push(Buffer.from(c)));
					res.on("end", () =>
						resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }),
					);
					res.on("error", () => resolve(null));
				},
			);
			req.setTimeout(30_000, () => {
				req.destroy();
				resolve(null);
			});
			req.on("error", () => resolve(null));
			if (bodyBuf) req.write(bodyBuf);
			req.end();
		},
	);
	if (!upstream) {
		return new Response("Preview server not reachable. Start it first (POST …/cli-preview).", {
			status: 502,
		});
	}

	const ct = (upstream.headers["content-type"] as string | undefined) ?? "";
	const out = new Headers();
	if (ct) out.set("content-type", ct);
	const cc = upstream.headers["cache-control"] as string | undefined;
	if (cc) out.set("cache-control", cc);
	const loc = upstream.headers["location"] as string | undefined;
	if (loc) out.set("location", rewriteLocation(loc, proxyBasePath));

	if (ct.includes("text/html")) {
		return new Response(rewriteHtml(upstream.body.toString("utf-8"), proxyBasePath), {
			status: upstream.status,
			headers: out,
		});
	}
	if (JS_CONTENT_TYPES.some((t) => ct.includes(t))) {
		return new Response(rewriteJs(upstream.body.toString("utf-8"), proxyBasePath), {
			status: upstream.status,
			headers: out,
		});
	}
	if (ct.includes("text/css")) {
		return new Response(rewriteHtml(upstream.body.toString("utf-8"), proxyBasePath), {
			status: upstream.status,
			headers: out,
		});
	}
	return new Response(new Uint8Array(upstream.body), { status: upstream.status, headers: out });
}
