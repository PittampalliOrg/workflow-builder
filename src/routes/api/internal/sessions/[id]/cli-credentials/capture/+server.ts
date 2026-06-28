/**
 * Internal endpoint: the interactive-cli runtime POSTs a captured CLI login
 * bundle here (e.g. agy's base64 tar.gz of ~/.gemini) after a successful
 * in-terminal login or token refresh. We resolve the session's owning user and
 * store the bundle per-user (encrypted) so every FUTURE pod for that user boots
 * the CLI already signed in — no repeat device-code login.
 *
 * Auth: INTERNAL_API_TOKEN (the runtime↔BFF trust boundary). The bundle is
 * stored against the session OWNER (resolved from the sessionId), never the
 * caller — a runtime can only ever capture for its own session's user.
 */
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { eq } from "drizzle-orm";
import { validateInternalToken } from "$lib/server/internal-auth";
import { db } from "$lib/server/db";
import { sessions } from "$lib/server/db/schema";
import {
	upsertUserCliCredential,
	releaseCliBootLease,
} from "$lib/server/users/cli-credentials";

export const POST: RequestHandler = async ({ params, request }) => {
	if (!validateInternalToken(request)) return error(401, "Unauthorized");
	const sessionId = params.id;
	if (!sessionId) return error(400, "Missing session id");
	if (!db) return error(503, "Database not configured");

	let body: { provider?: unknown; bundle?: unknown };
	try {
		body = await request.json();
	} catch {
		return error(400, "Invalid JSON");
	}
	const provider = typeof body.provider === "string" ? body.provider.trim() : "";
	const bundle = typeof body.bundle === "string" ? body.bundle.trim() : "";
	if (!provider || !bundle) return error(400, "provider and bundle are required");

	const [row] = await db
		.select({ userId: sessions.userId })
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	const userId = row?.userId ?? null;
	if (!userId) return error(404, "Session owner not found");

	try {
		const summary = await upsertUserCliCredential(userId, provider, bundle);
		// The rotated single-use token is now persisted — release the boot lease so
		// the next concurrent codex session can seed the fresh token (no-op for
		// providers that don't need serialization).
		await releaseCliBootLease(userId, provider, sessionId);
		return json({ stored: true, provider: summary.provider });
	} catch (e) {
		// Bundle failed the format guard — log-and-reject (don't 500).
		return error(400, e instanceof Error ? e.message : "Invalid credential bundle");
	}
};
