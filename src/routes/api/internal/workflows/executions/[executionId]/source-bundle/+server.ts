/**
 * POST /api/internal/workflows/executions/[executionId]/source-bundle
 *
 * Internal-only ingest for a durable per-node SOURCE bundle. A code-producing
 * agent node (dapr-agent-py / cli-agent-py) creates a git bundle of the produced
 * source in-pod at session end and POSTs the base64 bytes here; the BFF stores them
 * in the Files API and records a `source-bundle` workflow_artifact, so the version
 * survives sandbox reap and can be previewed + applied (Promote → PR). Mirrors the
 * run-diff ingest pattern. Auth: requires INTERNAL_API_TOKEN. Best-effort caller.
 */

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requireInternal } from "$lib/server/internal-auth";

const MAX_BUNDLE_BYTES = 25 * 1024 * 1024; // Files API cap

type IncomingBundle = {
	bundleBase64?: string;
	nodeId?: string | null;
	fileName?: string | null;
	base?: string | null;
	head?: string | null;
	tier?: string | null;
	clonePath?: string | null;
	fileCount?: number | null;
};

export const POST: RequestHandler = async ({ params, request }) => {
	requireInternal(request);

	const { executionId } = params;
	if (!executionId) return error(400, "executionId required");

	let body: IncomingBundle;
	try {
		body = (await request.json()) as IncomingBundle;
	} catch {
		return error(400, "invalid JSON body");
	}
	if (typeof body.bundleBase64 !== "string" || !body.bundleBase64.trim()) {
		return error(400, "bundleBase64 (string) is required");
	}

	let bytes: Buffer;
	try {
		bytes = Buffer.from(body.bundleBase64, "base64");
	} catch {
		return error(400, "bundleBase64 is not valid base64");
	}
	if (bytes.byteLength === 0) return json({ ok: true, empty: true });
	if (bytes.byteLength > MAX_BUNDLE_BYTES) {
		return json({ ok: true, skipped: "too_large", bytes: bytes.byteLength });
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

	const result = await workflowData.persistSourceBundleArtifact({
		executionId,
		userId: exec.userId,
		projectId: exec.projectId ?? null,
		nodeId: body.nodeId ?? null,
		fileName: body.fileName ?? undefined,
		bytes,
		meta: {
			base: body.base ?? null,
			head: body.head ?? null,
			tier: body.tier ?? null,
			clonePath: body.clonePath ?? null,
			fileCount: typeof body.fileCount === "number" ? body.fileCount : null,
		},
	});

	return json({ ok: true, ...result });
};
