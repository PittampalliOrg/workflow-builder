import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import {
	AGENT_MODEL_OPTIONS,
	canonicalAgentModelSpec,
} from "$lib/agents/model-options";

/**
 * Change the model for subsequent turns. The session workflow merges the
 * canonical agent-config patch at the next turn boundary.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const requestedModelSpec =
		typeof body.modelSpec === "string" ? body.modelSpec.trim() : "";
	if (!requestedModelSpec) return error(400, "modelSpec is required");
	const modelSpec = canonicalAgentModelSpec(requestedModelSpec);
	if (!modelSpec) {
		return error(
			400,
			`Unsupported modelSpec. Allowed: ${AGENT_MODEL_OPTIONS.map((m) => m.value).join(", ")}`,
		);
	}
	const result = await getApplicationAdapters().workflowData.raiseSessionAgentConfigPatch({
		sessionId: params.id,
		patch: { modelSpec },
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
	});
	if (!result.ok) return error(result.status, result.error ?? "set-model failed");
	return json({ modelSpec });
};
