/**
 * POST /api/internal/workflows/executions/[executionId]/artifacts
 *
 * Internal-only endpoint used by the workflow-orchestrator's
 * `persist_workflow_artifact` activity (and any other in-cluster
 * service that wants to register a workflow artifact, e.g. an adapter
 * that emits per-fetch artifacts directly).
 *
 * Idempotent: a deterministic `id` (sha256(executionId|nodeId|kind|title))
 * supplied by the caller becomes the row PK. UPSERT on conflict so Dapr
 * activity retries don't double-write.
 *
 * Auth: requires INTERNAL_API_TOKEN.
 */

import { error, json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import { workflowArtifacts, workflowExecutions } from "$lib/server/db/schema";
import { requireInternal } from "$lib/server/internal-auth";

type IncomingArtifact = {
	id?: string;
	nodeId?: string | null;
	slot?: "primary" | "secondary" | "aux" | null;
	kind?: string;
	title?: string;
	description?: string | null;
	inlinePayload?: unknown;
	fileId?: string | null;
	contentType?: string | null;
	sizeBytes?: number | null;
	metadata?: Record<string, unknown> | null;
};

const VALID_SLOTS = new Set(["primary", "secondary", "aux"]);

export const POST: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	if (!db) return error(503, "Database not configured");

	const { executionId } = params;
	if (!executionId) return error(400, "executionId required");

	let body: IncomingArtifact;
	try {
		body = (await request.json()) as IncomingArtifact;
	} catch {
		return error(400, "invalid JSON body");
	}

	if (!body.id || typeof body.id !== "string") {
		return error(400, "id is required (deterministic — supplied by orchestrator)");
	}
	if (!body.kind || typeof body.kind !== "string") {
		return error(400, "kind is required");
	}
	if (!body.title || typeof body.title !== "string") {
		return error(400, "title is required");
	}
	if (body.slot && !VALID_SLOTS.has(body.slot)) {
		return error(400, `slot must be one of ${[...VALID_SLOTS].join(",")}`);
	}
	if (body.inlinePayload === undefined && !body.fileId) {
		return error(400, "either inlinePayload or fileId must be set");
	}

	// Verify the execution exists. Cascade-delete on the FK would otherwise
	// silently 404 the row later if the caller had the wrong id.
	const exec = await db
		.select({ id: workflowExecutions.id })
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);
	if (!exec[0]) return error(404, `execution ${executionId} not found`);

	// UPSERT by deterministic id. Activity retries become no-ops (or update
	// in-place if the producer recomputed the payload).
	await db
		.insert(workflowArtifacts)
		.values({
			id: body.id,
			workflowExecutionId: executionId,
			nodeId: body.nodeId ?? null,
			slot: body.slot ?? null,
			kind: body.kind,
			title: body.title,
			description: body.description ?? null,
			inlinePayload: body.inlinePayload ?? null,
			fileId: body.fileId ?? null,
			contentType: body.contentType ?? null,
			sizeBytes: body.sizeBytes ?? null,
			metadata: body.metadata ?? null,
		})
		.onConflictDoUpdate({
			target: workflowArtifacts.id,
			set: {
				nodeId: body.nodeId ?? null,
				slot: body.slot ?? null,
				kind: body.kind,
				title: body.title,
				description: body.description ?? null,
				inlinePayload: body.inlinePayload ?? null,
				fileId: body.fileId ?? null,
				contentType: body.contentType ?? null,
				sizeBytes: body.sizeBytes ?? null,
				metadata: body.metadata ?? null,
			},
		});

	return json({ ok: true, id: body.id });
};
