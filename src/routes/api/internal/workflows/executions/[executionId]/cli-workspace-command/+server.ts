/**
 * POST /api/internal/workflows/executions/[executionId]/cli-workspace-command
 *
 * Run a deterministic shell command in the SHARED workspace of an interactive-cli
 * workflow run. The SW 1.0 `workspace/command` gate node can't reach a CLI agent's
 * files via openshell-agent-runtime (CLI agents write to a per-pod /sandbox, and
 * the shared build lives on the per-execution JuiceFS mount at /sandbox/work that
 * only CLI pods see). This endpoint runs the FIXED command inside the execution's
 * live CLI pod via cli-agent-py `/internal/workspace/command` (pod-IP:8002) — the
 * same cli-direct mechanism the goal evaluator uses
 * (`src/lib/server/goals/evaluator.ts`). The command is caller-supplied and fixed
 * by the workflow spec (not LLM-decided), so the gate stays deterministic and
 * independent of the generator agent.
 *
 * Optional `readFile`: cli-agent-py's command endpoint tails stdout to 8 KiB, so a
 * large `cat <file>` (e.g. the captured standalone.html, ~40 KiB) would clip. When
 * `readFile` is set the endpoint runs `command` (the build step) and then reads
 * that file in full via chunked base64 (each chunk fits the 8 KiB tail), returning
 * the complete contents as `result.stdout`. The endpoint runs plain `bash -lc`
 * (no OPA gating), so base64/dd are available.
 *
 * Auth: requires INTERNAL_API_TOKEN.
 * Returns the same envelope shape as a `workspace/command` runtime call so the
 * loop's `${ .loop.last.gate.result.stdout }` / capture `${ .data.result.stdout }`
 * refs resolve unchanged:  { success, result: { exitCode, stdout, stderr } }
 */
import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import http from "node:http";
import https from "node:https";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "$lib/server/db";
import { sessions, workflowExecutions } from "$lib/server/db/schema";
import { requireInternal } from "$lib/server/internal-auth";
import {
	isInteractiveCliSession,
	resolveSessionRuntimeTarget,
} from "$lib/server/sessions/runtime-target";
import {
	waitForAgentWorkflowHostAppReady,
	maybeProvisionAgentWorkflowHost,
	sessionHostAppId,
} from "$lib/server/sessions/agent-workflow-host";
import { resolveWorkflowGithubToken } from "$lib/server/workflows/github-token";
import { createFile } from "$lib/server/files/registry";
import { saveBrowserArtifact } from "$lib/server/browser-artifacts";
import type { AgentConfig } from "$lib/types/agents";
import { env } from "$env/dynamic/private";

const IMAGE_CONTENT_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
};

function imageContentType(path: string): string | null {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return IMAGE_CONTENT_TYPES[ext] ?? null;
}

const DEFAULT_CWD = "/sandbox/work";
const MAX_OUTPUT_CHARS = 16_000;
// cli-agent-py tails stdout to 8 KiB; 6000 raw bytes → ~8000 base64 chars, which
// fits. Cap a chunked file read so a runaway file can't blow up the response.
const CHUNK_RAW_BYTES = 6000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
// Cap a persisted browser video (base64-inlined into the artifact blob table).
const MAX_VIDEO_BYTES = 64 * 1024 * 1024;

type CmdResult = { exitCode: number; stdout: string; stderr: string };

// Default per-command budget when the caller doesn't thread a node `timeoutMs`
// (the fast file-read chunk ops). The main command call passes the node budget.
const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;
// Slack added to the socket idle timeout above the subprocess budget, so the
// cli-agent-py subprocess timeout (clean result) fires before the HTTP socket.
const HTTP_TIMEOUT_SLACK_MS = 60_000;

// POST to cli-agent-py over node http(s) with a long socket-idle timeout. We do
// NOT use the global undici fetch here: cli-agent-py holds the connection IDLE
// (sends no bytes) until the subprocess finishes, so undici's ~300s headers/body
// timeout would abort a slow `npm install`/build long before it completes. The
// `timeout` (seconds) is forwarded so the subprocess itself is bounded.
async function postCommand(
	baseUrl: string,
	token: string,
	command: string,
	cwd: string,
	timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<CmdResult | null> {
	const subprocessBudgetMs = Math.max(1_000, Math.floor(timeoutMs));
	const payload = JSON.stringify({
		command,
		cwd,
		timeout: Math.ceil(subprocessBudgetMs / 1000),
	});
	const u = new URL(`${baseUrl}/internal/workspace/command`);
	const transport = u.protocol === "https:" ? https : http;
	return new Promise<CmdResult | null>((resolve) => {
		const req = transport.request(
			{
				hostname: u.hostname,
				port: u.port || (u.protocol === "https:" ? 443 : 80),
				path: `${u.pathname}${u.search}`,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": String(Buffer.byteLength(payload)),
					...(token ? { "X-Internal-Token": token } : {}),
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(Buffer.from(c)));
				res.on("end", () => {
					if ((res.statusCode ?? 0) >= 400) return resolve(null);
					let raw: { exit_code?: number | null; stdout_tail?: string; stderr_tail?: string } = {};
					try {
						raw = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
					} catch {
						return resolve(null);
					}
					resolve({
						exitCode: typeof raw.exit_code === "number" ? raw.exit_code : 1,
						stdout: raw.stdout_tail ?? "",
						stderr: raw.stderr_tail ?? "",
					});
				});
				res.on("error", () => resolve(null));
			},
		);
		// Socket idle timeout, above the subprocess budget so the subprocess's own
		// clean timeout wins; if this fires the command genuinely overran.
		req.setTimeout(subprocessBudgetMs + HTTP_TIMEOUT_SLACK_MS, () => {
			req.destroy();
			resolve(null);
		});
		req.on("error", () => resolve(null));
		req.write(payload);
		req.end();
	});
}

// Read a file's full contents from the CLI pod despite the 8 KiB stdout tail, by
// fetching base64 chunks (`dd` block-skip) and reassembling.
async function readFileFull(
	baseUrl: string,
	token: string,
	path: string,
	cwd: string,
): Promise<{ ok: boolean; content: string; error?: string }> {
	const q = `'${path.replace(/'/g, "'\\''")}'`;
	const sizeRes = await postCommand(baseUrl, token, `wc -c < ${q}`, cwd);
	if (!sizeRes || sizeRes.exitCode !== 0) {
		return { ok: false, content: "", error: `cannot stat ${path}: ${sizeRes?.stderr ?? "no pod"}` };
	}
	const size = parseInt((sizeRes.stdout || "").trim(), 10);
	if (!Number.isFinite(size) || size < 0) return { ok: false, content: "", error: "bad size" };
	if (size > MAX_FILE_BYTES) return { ok: false, content: "", error: `file too large (${size} bytes)` };
	if (size === 0) return { ok: true, content: "" };
	const chunks = Math.ceil(size / CHUNK_RAW_BYTES);
	const parts: Buffer[] = [];
	for (let n = 0; n < chunks; n++) {
		const cmd = `dd if=${q} bs=${CHUNK_RAW_BYTES} skip=${n} count=1 2>/dev/null | base64 -w0`;
		const r = await postCommand(baseUrl, token, cmd, cwd);
		if (!r || r.exitCode !== 0) return { ok: false, content: "", error: `chunk ${n} read failed` };
		parts.push(Buffer.from((r.stdout || "").trim(), "base64"));
	}
	return { ok: true, content: Buffer.concat(parts).toString("utf-8") };
}

// Read a file's full bytes from the CLI pod as a Buffer (binary-safe — used for
// images, where the utf-8 decode in readFileFull would corrupt the payload).
async function readFileBytes(
	baseUrl: string,
	token: string,
	path: string,
	cwd: string,
	maxBytes: number = MAX_FILE_BYTES,
): Promise<{ ok: boolean; bytes: Buffer; error?: string }> {
	const q = `'${path.replace(/'/g, "'\\''")}'`;
	const sizeRes = await postCommand(baseUrl, token, `wc -c < ${q}`, cwd);
	if (!sizeRes || sizeRes.exitCode !== 0) {
		return { ok: false, bytes: Buffer.alloc(0), error: `cannot stat ${path}: ${sizeRes?.stderr ?? "no pod"}` };
	}
	const size = parseInt((sizeRes.stdout || "").trim(), 10);
	if (!Number.isFinite(size) || size < 0) return { ok: false, bytes: Buffer.alloc(0), error: "bad size" };
	if (size > maxBytes) return { ok: false, bytes: Buffer.alloc(0), error: `file too large (${size} bytes)` };
	if (size === 0) return { ok: false, bytes: Buffer.alloc(0), error: "empty file" };
	const chunks = Math.ceil(size / CHUNK_RAW_BYTES);
	const parts: Buffer[] = [];
	for (let n = 0; n < chunks; n++) {
		const cmd = `dd if=${q} bs=${CHUNK_RAW_BYTES} skip=${n} count=1 2>/dev/null | base64 -w0`;
		const r = await postCommand(baseUrl, token, cmd, cwd);
		if (!r || r.exitCode !== 0) return { ok: false, bytes: Buffer.alloc(0), error: `chunk ${n} read failed` };
		parts.push(Buffer.from((r.stdout || "").trim(), "base64"));
	}
	return { ok: true, bytes: Buffer.concat(parts) };
}

export const POST: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	if (!db) return error(503, "Database not configured");
	const executionId = params.executionId;

	let body: {
		command?: unknown;
		cwd?: unknown;
		readFile?: unknown;
		timeoutMs?: unknown;
		persistBrowserVideo?: unknown;
		nodeId?: unknown;
		workflowId?: unknown;
	} = {};
	try {
		body = await request.json();
	} catch {
		/* empty body → error below */
	}
	const command = typeof body.command === "string" ? body.command : "";
	if (!command.trim()) return error(400, "command is required");
	const cwd =
		typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : DEFAULT_CWD;
	// The node's `timeoutMs` (threaded from the orchestrator) governs the slow
	// command; bound to a sane window so a runaway can't pin a pod forever.
	const rawTimeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : NaN;
	const commandTimeoutMs = Number.isFinite(rawTimeoutMs)
		? Math.min(Math.max(rawTimeoutMs, 60_000), 1_800_000)
		: DEFAULT_COMMAND_TIMEOUT_MS;
	const readFile =
		typeof body.readFile === "string" && body.readFile.trim() ? body.readFile.trim() : null;
	// When readFile points at an image, upload its bytes to the files API and
	// return a top-level fileId (instead of stuffing binary into stdout) so a
	// workflow `image` artifact can reference it as a blob and render inline.
	const readFileImageType = readFile ? imageContentType(readFile) : null;
	// Optional `persistBrowserVideo`: an absolute path (on the CLI pod) to a .webm
	// the command produced (e.g. the dashboard walkthrough). After the command
	// runs we read the bytes and persist them as a `video` browser-artifact so the
	// run page's Browser tab renders an inline <video>. Best-effort, never fatal.
	const persistBrowserVideo =
		typeof body.persistBrowserVideo === "string" && body.persistBrowserVideo.trim()
			? body.persistBrowserVideo.trim()
			: null;
	const artifactNodeId =
		typeof body.nodeId === "string" && body.nodeId.trim() ? body.nodeId.trim() : "publish_shot";

	// Resolve the execution's most-recent interactive-cli session with a live pod.
	const rows = await db
		.select({ id: sessions.id, userId: sessions.userId })
		.from(sessions)
		.where(
			and(
				eq(sessions.workflowExecutionId, executionId),
				isNotNull(sessions.runtimeAppId),
			),
		)
		.orderBy(desc(sessions.createdAt))
		.limit(8);

	let baseUrl: string | null = null;
	let ownerUserId: string | null = null;
	for (const row of rows) {
		if (!(await isInteractiveCliSession(row.id))) continue;
		const rt = await resolveSessionRuntimeTarget(row.id);
		if (!rt?.appId) continue;
		try {
			const ready = await waitForAgentWorkflowHostAppReady({ agentAppId: rt.appId });
			if (ready?.baseUrl) {
				baseUrl = ready.baseUrl;
				ownerUserId = row.userId ?? null;
				break;
			}
		} catch {
			/* try the next candidate */
		}
	}
	// No live agent pod between turns. Some CLIs (codex, agy) reap their per-turn
	// pod on turn end — unlike claude-code, whose herdr TUI lingers — so the
	// deterministic cliWorkspace steps (gate / read_verdict / pr) that run BETWEEN
	// turns find nothing. Provision (idempotently) a dedicated short-lived CLI
	// "workspace helper" pod for this execution: it boots cli-agent-py :8002 (no
	// agent turn), mounts the SAME shared JuiceFS workspace (keyed below), and
	// carries GITHUB_TOKEN so git push / PR-open authenticate. Adopted (not
	// recreated) on repeat calls so gate/read_verdict/pr reuse one pod.
	if (!baseUrl) {
		// The shared JuiceFS subtree is keyed by the CANONICAL orchestrator
		// instance id (workflowExecutions.daprInstanceId = `sw-<name>-exec-<id>`) —
		// the SAME key durable/run agents (workspaceRef `${ .runtime.executionId }`)
		// and the Files-tab webdav reader use. Keying the helper by the bare
		// executionId would land it on a DIFFERENT subtree than the agents
		// (clone/gate/read_contract couldn't see agent files; the Files tab would be
		// empty). Fall back to the bare id only if the instance id isn't stamped.
		const [execRow] = await db
			.select({ daprInstanceId: workflowExecutions.daprInstanceId })
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, executionId))
			.limit(1);
		const sharedWorkspaceKey = execRow?.daprInstanceId ?? executionId;
		const helperSessionId = `${executionId}__cliws`;
		const helperAppId = sessionHostAppId(helperSessionId);
		// Fast path: a previously-provisioned helper is already up.
		try {
			const ready = await waitForAgentWorkflowHostAppReady({
				agentAppId: helperAppId,
			});
			if (ready?.baseUrl) baseUrl = ready.baseUrl;
		} catch {
			/* not up yet — provision below */
		}
		if (!baseUrl) {
			const ghToken = await resolveWorkflowGithubToken();
			try {
				const prov = await maybeProvisionAgentWorkflowHost({
					sessionId: helperSessionId,
					agentConfig: { runtime: "claude-code-cli" } as AgentConfig,
					workflowExecutionId: executionId,
					benchmarkRunId: null,
					benchmarkInstanceId: null,
					timeoutMinutes: 30,
					sessionSecretEnv: ghToken ? { GITHUB_TOKEN: ghToken } : null,
					sharedWorkspaceKey,
				});
				const appId = prov?.agentAppId ?? helperAppId;
				const ready = await waitForAgentWorkflowHostAppReady({ agentAppId: appId });
				if (ready?.baseUrl) baseUrl = ready.baseUrl;
			} catch (err) {
				console.warn(
					`[cli-workspace-command] helper-pod provision failed for ${executionId}:`,
					err instanceof Error ? err.message : err,
				);
			}
		}
	}
	if (!baseUrl) {
		return error(
			409,
			`No live interactive-cli pod for execution ${executionId}; cannot run the command`,
		);
	}

	const token = env.INTERNAL_API_TOKEN ?? process.env.INTERNAL_API_TOKEN ?? "";
	const cmd = await postCommand(baseUrl, token, command, cwd, commandTimeoutMs);
	if (!cmd) return error(502, "cli runtime error invoking workspace command");

	// Optional: persist a .webm the command produced as a `video` browser-artifact
	// so the run page's Browser tab renders it inline. Best-effort and isolated —
	// a missing/oversized/failed video must NEVER fail the workflow (mirrors the
	// screenshot's always-success contract below). Runs BEFORE the readFile return
	// branches so it works alongside the screenshot in the same step.
	if (persistBrowserVideo) {
		try {
			const vid = await readFileBytes(baseUrl, token, persistBrowserVideo, cwd, MAX_VIDEO_BYTES);
			if (vid.ok && vid.bytes.byteLength > 0) {
				let workflowId =
					typeof body.workflowId === "string" && body.workflowId.trim()
						? body.workflowId.trim()
						: "";
				if (!workflowId) {
					const row = await db
						.select({ workflowId: workflowExecutions.workflowId })
						.from(workflowExecutions)
						.where(eq(workflowExecutions.id, executionId))
						.limit(1);
					workflowId = row[0]?.workflowId ?? "";
				}
				if (workflowId) {
					await saveBrowserArtifact({
						workflowExecutionId: executionId,
						workflowId,
						nodeId: artifactNodeId,
						baseUrl: "",
						status: "completed",
						steps: [],
						metadata: { source: "publish_shot-recordVideo", fileName: persistBrowserVideo },
						assets: [
							{
								kind: "video",
								label: "Dashboard walkthrough",
								payloadBase64: vid.bytes.toString("base64"),
								contentType: "video/webm",
								fileName: persistBrowserVideo.split("/").pop() ?? "dashboard.webm",
							},
						],
					});
				}
			}
		} catch (err) {
			console.warn(
				`[cli-workspace-command] persistBrowserVideo failed for ${executionId}:`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	// readFile + image: read the bytes (binary), upload to the files API, and
	// return a top-level `fileId` so an `image` workflow artifact can reference
	// the blob and render inline. (Storing the pod path string as inline_payload
	// — the old behavior — produced an unrenderable 31-byte "PNG".)
	if (readFile && readFileImageType) {
		const img = await readFileBytes(baseUrl, token, readFile, cwd);
		let fileId: string | null = null;
		let uploadError: string | null = img.ok ? null : (img.error ?? "image read failed");
		if (img.ok) {
			try {
				const name = readFile.split("/").pop() || "screenshot.png";
				const created = await createFile({
					userId: ownerUserId ?? "system",
					purpose: "output",
					scopeId: executionId,
					name,
					contentType: readFileImageType,
					bytes: img.bytes,
				});
				fileId = created.file.id;
			} catch (err) {
				uploadError = err instanceof Error ? err.message : String(err);
			}
		}
		// Best-effort artifact generation: ALWAYS success. The screenshot command
		// often exits non-zero through no real fault (e.g. -15/SIGTERM when the
		// trailing pkill tears down the preview server, or a command timeout that
		// fires after the file was already written + uploaded). A missing/failed
		// screenshot must never fail the whole workflow — the cliWorkspace task
		// path doesn't honor allowFailure, and the image artifact's
		// `if: fileId != null` guard skips itself when there's no blob.
		return json({
			success: true,
			fileId,
			fileName: readFile.split("/").pop() ?? null,
			contentType: readFileImageType,
			result: {
				exitCode: cmd.exitCode,
				stdout: fileId
					? `uploaded ${readFile} (${img.bytes.byteLength} bytes) as file ${fileId}`
					: "",
				stderr: [cmd.stderr.slice(0, MAX_OUTPUT_CHARS), uploadError ?? ""]
					.filter(Boolean)
					.join("\n"),
			},
		});
	}

	// readFile mode: return the full file (chunked) instead of the tailed stdout.
	if (readFile) {
		const file = await readFileFull(baseUrl, token, readFile, cwd);
		return json({
			success: cmd.exitCode === 0 && file.ok,
			result: {
				exitCode: cmd.exitCode,
				stdout: file.ok ? file.content : "",
				stderr: [cmd.stderr.slice(0, MAX_OUTPUT_CHARS), file.error ?? ""]
					.filter(Boolean)
					.join("\n"),
			},
		});
	}

	return json({
		success: true,
		result: {
			exitCode: cmd.exitCode,
			stdout: cmd.stdout.slice(0, MAX_OUTPUT_CHARS),
			stderr: cmd.stderr.slice(0, MAX_OUTPUT_CHARS),
		},
	});
};
