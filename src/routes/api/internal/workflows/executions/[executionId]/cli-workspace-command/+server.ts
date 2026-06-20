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
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "$lib/server/db";
import { sessions } from "$lib/server/db/schema";
import { requireInternal } from "$lib/server/internal-auth";
import { daprFetch } from "$lib/server/dapr-client";
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
import type { AgentConfig } from "$lib/types/agents";
import { env } from "$env/dynamic/private";

const DEFAULT_CWD = "/sandbox/work";
const MAX_OUTPUT_CHARS = 16_000;
// cli-agent-py tails stdout to 8 KiB; 6000 raw bytes → ~8000 base64 chars, which
// fits. Cap a chunked file read so a runaway file can't blow up the response.
const CHUNK_RAW_BYTES = 6000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

type CmdResult = { exitCode: number; stdout: string; stderr: string };

async function postCommand(
	baseUrl: string,
	token: string,
	command: string,
	cwd: string,
): Promise<CmdResult | null> {
	const res = await daprFetch(`${baseUrl}/internal/workspace/command`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { "X-Internal-Token": token } : {}),
		},
		body: JSON.stringify({ command, cwd }),
		maxRetries: 0,
	});
	if (!res.ok) return null;
	const raw = (await res.json().catch(() => ({}))) as {
		exit_code?: number | null;
		stdout_tail?: string;
		stderr_tail?: string;
	};
	return {
		exitCode: typeof raw.exit_code === "number" ? raw.exit_code : 1,
		stdout: raw.stdout_tail ?? "",
		stderr: raw.stderr_tail ?? "",
	};
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

export const POST: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	if (!db) return error(503, "Database not configured");
	const executionId = params.executionId;

	let body: { command?: unknown; cwd?: unknown; readFile?: unknown } = {};
	try {
		body = await request.json();
	} catch {
		/* empty body → error below */
	}
	const command = typeof body.command === "string" ? body.command : "";
	if (!command.trim()) return error(400, "command is required");
	const cwd =
		typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : DEFAULT_CWD;
	const readFile =
		typeof body.readFile === "string" && body.readFile.trim() ? body.readFile.trim() : null;

	// Resolve the execution's most-recent interactive-cli session with a live pod.
	const rows = await db
		.select({ id: sessions.id })
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
	for (const row of rows) {
		if (!(await isInteractiveCliSession(row.id))) continue;
		const rt = await resolveSessionRuntimeTarget(row.id);
		if (!rt?.appId) continue;
		try {
			const ready = await waitForAgentWorkflowHostAppReady({ agentAppId: rt.appId });
			if (ready?.baseUrl) {
				baseUrl = ready.baseUrl;
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
	// agent turn), mounts the SAME shared JuiceFS workspace (sharedWorkspaceKey =
	// executionId, matching durable/run), and carries GITHUB_TOKEN so git push /
	// PR-open authenticate. Adopted (not recreated) on repeat calls since the
	// instanceId is the executionId — so gate/read_verdict/pr reuse one pod.
	if (!baseUrl) {
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
					sharedWorkspaceKey: executionId,
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
	const cmd = await postCommand(baseUrl, token, command, cwd);
	if (!cmd) return error(502, "cli runtime error invoking workspace command");

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
