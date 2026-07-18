import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import {
	KNOWLEDGE_MAX_BODY_BYTES,
	renderConcept,
	sanitizeKnowledgePath,
} from "$lib/server/teams/team-okf";
import { authorizeTeamActionRequest } from "../../team-action-principal";

/**
 * Team knowledge (OKF-shaped content layer).
 *
 * POST /api/internal/team/[teamId]/knowledge
 *   { sessionId, path, type, title?, description?, tags?, body }
 *   Publish/revise ONE concept document. sessionId must be a member of the
 *   team (lead included) — knowledge is team-scoped provenance, not a public
 *   drop box. Upsert on (team, path) so re-publishing is a revision.
 *
 * GET  /api/internal/team/[teamId]/knowledge            → { entries } (index)
 * GET  /api/internal/team/[teamId]/knowledge?type=X     → filtered index
 * GET  /api/internal/team/[teamId]/knowledge?path=a/b.md → { entry, okf }
 *   `okf` is the rendered OKF markdown — agents see the exact wire format.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const body = (await request.json().catch(() => ({}))) as {
		sessionId?: string;
		path?: string;
		type?: string;
		title?: string;
		description?: string;
		resource?: string;
		tags?: string[];
		body?: string;
	};
  const authorization = await authorizeTeamActionRequest(
    request,
    params.teamId,
    {
      bodySessionId: body.sessionId,
    },
  );
  if (!authorization.ok)
    return error(authorization.status, authorization.error);
  const sessionId = authorization.principal.sessionId;
  if (!body.type || !body.type.trim())
    return error(400, "type is required (OKF's one required field)");
	const sanitized = sanitizeKnowledgePath(body.path ?? "");
	if ("error" in sanitized) return error(400, sanitized.error);
	const content = String(body.body ?? "");
	if (Buffer.byteLength(content, "utf8") > KNOWLEDGE_MAX_BODY_BYTES) {
    return error(
      400,
      `body exceeds ${KNOWLEDGE_MAX_BODY_BYTES} bytes — split the concept`,
    );
	}

	const store = getApplicationAdapters().teamStore;
  const member = await store.getMemberBySession(sessionId);
	if (!member || member.team_id !== params.teamId) {
		return error(403, "only members of this team can publish knowledge");
	}

	const row = await store.upsertKnowledge({
		teamId: params.teamId,
		path: sanitized.path,
		type: body.type.trim(),
		title: body.title?.trim() || null,
		description: body.description?.trim() || null,
		resource: body.resource?.trim() || null,
		tags: Array.isArray(body.tags) ? body.tags.map(String).slice(0, 20) : [],
		body: content,
    createdBySessionId: sessionId,
  });
  return json({
    ok: true,
    path: row.path,
    type: row.type,
    updatedAt: row.updated_at,
	});
};

export const GET: RequestHandler = async ({ params, request, url }) => {
  const authorization = await authorizeTeamActionRequest(
    request,
    params.teamId,
  );
  if (!authorization.ok)
    return error(authorization.status, authorization.error);
	const store = getApplicationAdapters().teamStore;
	const path = url.searchParams.get("path");
	if (path) {
		const sanitized = sanitizeKnowledgePath(path);
		if ("error" in sanitized) return error(400, sanitized.error);
		const entry = await store.getKnowledge(params.teamId, sanitized.path);
		if (!entry) return error(404, `no concept at ${sanitized.path}`);
		return json({ entry, okf: renderConcept(entry) });
	}
	const type = url.searchParams.get("type") ?? undefined;
  const entries = await store.listKnowledge(
    params.teamId,
    type ? { type } : undefined,
  );
	return json({ entries });
};
