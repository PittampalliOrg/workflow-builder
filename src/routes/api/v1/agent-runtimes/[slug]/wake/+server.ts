import type { RequestHandler } from "./$types";
import { error, json } from "@sveltejs/kit";

import { getApplicationAdapters } from "$lib/server/application";
import type { AgentRuntimeWakeResult } from "$lib/server/application/ports";

export const POST: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	const slug = params.slug!;
	const rawTimeout = Number.parseInt(url.searchParams.get("timeoutMs") ?? "", 10);
	const timeoutMs = Number.isFinite(rawTimeout)
		? Math.min(60_000, Math.max(5_000, rawTimeout))
		: 30_000;

	try {
		const status = await getApplicationAdapters().agentRuntimeControl.wakeRuntime({
			slug,
			projectId: locals.session.projectId ?? null,
			timeoutMs,
		});
		if ("status" in status && status.status === "not_found") {
			return error(404, status.message);
		}
		const ok = status as AgentRuntimeWakeResult;
		return json({
			phase: ok.phase,
			replicas: ok.replicas,
			readyReplicas: ok.readyReplicas,
			source: ok.source,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return json({ error: message }, { status: message.includes("timeout") ? 504 : 500 });
	}
};
