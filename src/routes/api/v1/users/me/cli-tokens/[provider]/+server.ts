import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

import {
	deleteUserCliCredential,
	getUserCliCredentialSummary,
	upsertUserCliCredential,
} from "$lib/server/users/cli-credentials";

/**
 * Per-user CLI subscription-token enrollment for `interactive-cli` runtimes
 * (Settings → CLI tokens). The token itself is NEVER returned — GET exposes
 * presence/expiry/status metadata only.
 *
 *   GET    → { provider, linked, expiresAt, lastValidatedAt, status }
 *   PUT    → body { token, expiresAt? } — upsert (replaces any existing token)
 *   DELETE → { ok: true, deleted }
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const provider = params.provider!;
	const summary = await getUserCliCredentialSummary(
		locals.session.userId,
		provider,
	);
	return json(summary);
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const provider = params.provider!;
	const body = (await request.json().catch(() => ({}))) as {
		token?: unknown;
		expiresAt?: unknown;
	};
	const token = typeof body.token === "string" ? body.token : "";
	if (!token.trim()) return error(400, "token is required");
	let expiresAt: Date | null = null;
	if (typeof body.expiresAt === "string" && body.expiresAt.trim()) {
		const parsed = new Date(body.expiresAt);
		if (Number.isNaN(parsed.getTime())) {
			return error(400, "expiresAt must be an ISO timestamp");
		}
		expiresAt = parsed;
	}
	try {
		const summary = await upsertUserCliCredential(
			locals.session.userId,
			provider,
			token,
			expiresAt,
		);
		return json(summary);
	} catch (err) {
		return error(400, err instanceof Error ? err.message : "Token rejected");
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const provider = params.provider!;
	const deleted = await deleteUserCliCredential(
		locals.session.userId,
		provider,
	);
	return json({ ok: true, deleted });
};
