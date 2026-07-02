/**
 * POST /api/internal/workflows/executions/[executionId]/run-diff
 *
 * Internal-only ingest for a durable per-run workspace diff. The capture side
 * (cli-agent-py / dapr-agent-py) computes `git diff <baseline>..<head>` in-pod
 * at session end and POSTs the unified patch here; the BFF owns storage (inline
 * ≤256 KB else gzip → files) via `persistRunDiff`, so the diff survives sandbox
 * reap. Mirrors the browser_video_sync → browser-artifacts ingest pattern.
 *
 * Auth: requires INTERNAL_API_TOKEN. Best-effort on the caller's side.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requireInternal } from "$lib/server/internal-auth";
import type { RunDiffStats } from "$lib/server/workflows/run-diff";

type IncomingRunDiff = {
	patch?: string;
	baseRef?: string | null;
	headRef?: string | null;
	stats?: Partial<RunDiffStats> | null;
	nodeId?: string | null;
	title?: string | null;
};

export const POST: RequestHandler = async ({ params, request }) => {
	requireInternal(request);

	const { executionId } = params;
	if (!executionId) return error(400, "executionId required");

	let body: IncomingRunDiff;
	try {
		body = (await request.json()) as IncomingRunDiff;
	} catch {
		return error(400, "invalid JSON body");
	}
	if (typeof body.patch !== "string") {
		return error(400, "patch (string) is required");
	}

	const workflowData = getApplicationAdapters().workflowData;
	let exec: Awaited<ReturnType<typeof workflowData.getExecutionById>>;
	try {
		exec = await workflowData.getExecutionById(executionId);
	} catch (err) {
		if (err instanceof Error && err.message === "Database not configured") {
			return error(503, "Database not configured");
		}
		throw err;
	}
	if (!exec) return error(404, `execution ${executionId} not found`);

	// Empty patch = no changes; record nothing (keeps the UI clean).
	if (!body.patch.trim()) {
		return json({ ok: true, empty: true });
	}

	const result = await workflowData.persistRunDiffArtifact({
		executionId,
		userId: exec.userId,
		projectId: exec.projectId ?? null,
		nodeId: body.nodeId ?? null,
		title: body.title ?? undefined,
		patch: body.patch,
		baseRef: body.baseRef ?? null,
		headRef: body.headRef ?? null,
		stats: body.stats ?? null,
	});

	return json({ ok: true, ...result });
};
