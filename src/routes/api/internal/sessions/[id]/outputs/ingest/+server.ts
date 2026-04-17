import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { eq } from "drizzle-orm";
import { validateInternalToken } from "$lib/server/internal-auth";
import { db } from "$lib/server/db";
import { sessions } from "$lib/server/db/schema";
import { createFile, MAX_UPLOAD_BYTES } from "$lib/server/files/registry";

/**
 * Internal ingestion endpoint for agent-written outputs. `dapr-agent-py`'s
 * session_workflow scans the sandbox's `/mnt/session/outputs/` directory at
 * session-terminate and POSTs each file's base64 bytes here so they land in
 * the Files API with `purpose=output` + `scopeId=<session_id>`.
 *
 * Wire shape:
 *   { files: [{ name: string, contentType?: string | null, base64: string }, ...] }
 *
 * Files larger than the global 10 MB cap are rejected individually; the
 * rest still land. Per-file errors come back in the `errors` array so the
 * caller can surface which artifacts failed without losing the ones that
 * worked.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	if (!validateInternalToken(request)) return error(401, "Unauthorized");
	if (!db) return error(503, "Database not configured");

	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const rawFiles = Array.isArray(body.files) ? body.files : [];
	if (rawFiles.length === 0) {
		return json({ created: [], errors: [] });
	}

	const [sessionRow] = await db
		.select({
			id: sessions.id,
			userId: sessions.userId,
			projectId: sessions.projectId,
		})
		.from(sessions)
		.where(eq(sessions.id, params.id))
		.limit(1);
	if (!sessionRow) return error(404, "Session not found");

	const created: string[] = [];
	const errors: Array<{ name: string; error: string }> = [];

	for (const entry of rawFiles) {
		if (!entry || typeof entry !== "object") continue;
		const f = entry as Record<string, unknown>;
		const name = typeof f.name === "string" ? f.name : "";
		const base64 = typeof f.base64 === "string" ? f.base64 : "";
		const contentType =
			typeof f.contentType === "string" ? f.contentType : null;
		if (!name || !base64) {
			errors.push({ name: name || "<unnamed>", error: "missing name or base64" });
			continue;
		}
		let bytes: Buffer;
		try {
			bytes = Buffer.from(base64, "base64");
		} catch (err) {
			errors.push({ name, error: `bad base64: ${String(err)}` });
			continue;
		}
		if (bytes.byteLength === 0) {
			errors.push({ name, error: "empty file" });
			continue;
		}
		if (bytes.byteLength > MAX_UPLOAD_BYTES) {
			errors.push({
				name,
				error: `exceeds ${MAX_UPLOAD_BYTES} byte limit (${bytes.byteLength})`,
			});
			continue;
		}
		try {
			const fileRow = await createFile({
				userId: sessionRow.userId,
				projectId: sessionRow.projectId ?? null,
				name,
				purpose: "output",
				scopeId: sessionRow.id,
				contentType,
				bytes,
			});
			created.push(fileRow.id);
		} catch (err) {
			errors.push({ name, error: err instanceof Error ? err.message : String(err) });
		}
	}

	return json({ created, errors });
};
