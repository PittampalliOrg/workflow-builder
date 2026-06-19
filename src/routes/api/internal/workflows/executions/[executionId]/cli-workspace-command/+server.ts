/**
 * POST /api/internal/workflows/executions/[executionId]/cli-workspace-command
 *
 * Run a deterministic shell command in the SHARED workspace of an interactive-cli
 * workflow run. The SW 1.0 `workspace/command` gate node can't reach a CLI agent's
 * files via openshell-agent-runtime (CLI agents write to a per-pod /sandbox, and
 * the shared build lives on the per-execution JuiceFS mount at /sandbox/work that
 * only CLI pods see). This endpoint runs the FIXED gate command inside the
 * execution's live CLI pod via cli-agent-py `/internal/workspace/command`
 * (pod-IP:8002) — the same cli-direct mechanism the goal evaluator uses
 * (`src/lib/server/goals/evaluator.ts`). The command is caller-supplied and fixed
 * by the workflow spec (not LLM-decided), so the gate stays deterministic and
 * independent of the generator agent.
 *
 * Auth: requires INTERNAL_API_TOKEN.
 * Returns the same envelope shape as a `workspace/command` runtime call so the
 * loop's `${ .loop.last.gate.result.stdout }` refs resolve unchanged:
 *   { success, result: { exitCode, stdout, stderr } }
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
import { waitForAgentWorkflowHostAppReady } from "$lib/server/sessions/agent-workflow-host";
import { env } from "$env/dynamic/private";

const DEFAULT_CWD = "/sandbox/work";
const MAX_OUTPUT_CHARS = 16_000;

export const POST: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	if (!db) return error(503, "Database not configured");
	const executionId = params.executionId;

	let body: { command?: unknown; cwd?: unknown } = {};
	try {
		body = await request.json();
	} catch {
		/* empty body → error below */
	}
	const command = typeof body.command === "string" ? body.command : "";
	if (!command.trim()) return error(400, "command is required");
	const cwd =
		typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : DEFAULT_CWD;

	// Find the execution's most-recent interactive-cli session that has a live
	// runtime pod (the generator that just ran — its pod stays up for the idle
	// TTL and mounts the shared /sandbox/work). Every CLI pod of the execution
	// sees the same JuiceFS subtree, so any live one can run the gate.
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
	if (!baseUrl) {
		return error(
			409,
			`No live interactive-cli pod for execution ${executionId}; cannot run the gate command`,
		);
	}

	const token = env.INTERNAL_API_TOKEN ?? process.env.INTERNAL_API_TOKEN ?? "";
	const res = await daprFetch(`${baseUrl}/internal/workspace/command`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { "X-Internal-Token": token } : {}),
		},
		body: JSON.stringify({ command, cwd }),
		maxRetries: 0,
	});
	if (!res.ok) {
		const detail = (await res.text().catch(() => "")).slice(0, MAX_OUTPUT_CHARS);
		return error(502, `cli runtime error ${res.status}: ${detail}`);
	}
	// cli-agent-py returns { ok, exit_code, stdout_tail, stderr_tail }.
	const raw = (await res.json().catch(() => ({}))) as {
		exit_code?: number | null;
		stdout_tail?: string;
		stderr_tail?: string;
	};
	const exitCode = typeof raw.exit_code === "number" ? raw.exit_code : 1;
	return json({
		success: true,
		result: {
			exitCode,
			stdout: (raw.stdout_tail ?? "").slice(0, MAX_OUTPUT_CHARS),
			stderr: (raw.stderr_tail ?? "").slice(0, MAX_OUTPUT_CHARS),
		},
	});
};
