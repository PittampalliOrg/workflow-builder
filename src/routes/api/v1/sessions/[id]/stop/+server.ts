import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	inspectDurableRun,
	stopDurableRun,
	type StopDurableRunMode,
} from "$lib/server/lifecycle";
import { ownsBenchmarkOrEvalRunForSession } from "$lib/server/lifecycle/ownership";
import { isResourceInScope } from "$lib/server/workflows/project-scope";
import { pauseGoal } from "$lib/server/goals/repo";

const MODES = new Set<StopDurableRunMode>([
	"interrupt",
	"terminate",
	"purge",
	"reset",
]);

/**
 * POST /api/v1/sessions/[id]/stop
 *
 * The vetted way to stop a session's durable run. Body: { mode, reason?, graceMs? }.
 * - interrupt: cooperative halt of the current turn (keeps the session).
 * - terminate: hard-stop the durable run.
 * - purge / reset: terminate + purge durable state + reap the Sandbox CR + flip DB terminal.
 * Fail-closed: returns 409 if the durable run did not confirm closure.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const mode: StopDurableRunMode =
		typeof body.mode === "string" && MODES.has(body.mode as StopDurableRunMode)
			? (body.mode as StopDurableRunMode)
			: "terminate";
	const reason = typeof body.reason === "string" ? body.reason : undefined;
	const graceMs = typeof body.graceMs === "number" ? body.graceMs : undefined;

	const target = { kind: "session" as const, id: params.id };
	const inspected = await inspectDurableRun(target);
	if (inspected.notFound) return error(404, "Session not found");
	if (inspected.scope && !isResourceInScope(inspected.scope, locals.session)) {
		return error(404, "Session not found");
	}

	// Single stop authority (parity with the per-execution stop route): a
	// benchmark/eval instance's agent runs as a session, and its coordinator
	// re-drives a non-terminal instance — so stopping it here is futile. Redirect
	// to the owning run's cancel surface.
	const owner = await ownsBenchmarkOrEvalRunForSession(params.id);
	if (owner) {
		return json(
			{
				ok: false,
				error: "coordinator_owned",
				ownedBy: owner.kind,
				runId: owner.runId,
				message:
					owner.kind === "benchmarkRun"
						? "This is a benchmark instance — cancel the benchmark run instead."
						: "This is an evaluation instance — cancel the evaluation run instead.",
			},
			{ status: 409 },
		);
	}

	// Pause any active goal so the autonomous goal-loop driver stops re-posting
	// continuations for this session. interrupt = cooperative pause; for
	// terminate/purge the session goes terminal and the driver's terminal-status
	// gate halts it anyway, but pausing keeps the goal row coherent.
	if (mode === "interrupt") {
		await pauseGoal(params.id).catch(() => {});
	}

	const result = await stopDurableRun(target, { mode, reason, graceMs });
	if (result.notFound) return error(404, "Session not found");
	// confirmed → 200; stopping (requested + converging async) → 202; else 409.
	const status =
		result.state === "confirmed" ? 200 : result.state === "stopping" ? 202 : 409;
	return json({ ok: result.confirmed, ...result }, { status });
};
