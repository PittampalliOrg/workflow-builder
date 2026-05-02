import type { RequestHandler } from "./$types";
import { error, json } from "@sveltejs/kit";

import { wakeAgentRuntime } from "$lib/server/kube/client";
import { db } from "$lib/server/db";
import { agents } from "$lib/server/db/schema";
import { and, eq } from "drizzle-orm";
import {
	agentRuntimeDedicatedAppId,
	agentRuntimeSlugFromAppId,
} from "$lib/server/agents/runtime-routing";

export const POST: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!db) return error(500, "Database not configured");

	const slug = params.slug!;
	const rows = await db
		.select({ id: agents.id, runtimeAppId: agents.runtimeAppId })
		.from(agents)
		.where(
			and(
				eq(agents.slug, slug),
				locals.session.projectId
					? eq(agents.projectId, locals.session.projectId)
					: undefined,
			),
		)
		.limit(1);
	if (rows.length === 0) return error(404, `Agent ${slug} not found in workspace`);

	const rawTimeout = Number.parseInt(url.searchParams.get("timeoutMs") ?? "", 10);
	const timeoutMs = Number.isFinite(rawTimeout)
		? Math.min(60_000, Math.max(5_000, rawTimeout))
		: 30_000;
	const runtimeAppId = rows[0].runtimeAppId ?? agentRuntimeDedicatedAppId(slug);
	const runtimeSlug = agentRuntimeSlugFromAppId(runtimeAppId) ?? slug;

	try {
		const cr = await wakeAgentRuntime(runtimeSlug, timeoutMs);
		return json({
			phase: cr.status?.phase ?? "Unknown",
			replicas: cr.status?.replicas ?? 0,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return json({ error: message }, { status: message.includes("timeout") ? 504 : 500 });
	}
};
