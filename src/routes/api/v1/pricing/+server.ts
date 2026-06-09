import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	FALLBACK_PRICING,
	MODEL_PRICING,
} from "$lib/server/pricing/model-pricing";

/**
 * GET /api/v1/pricing?model=<key> — per-million-token rates for a model.
 *
 * Lets client surfaces (Session Pulse cost tile) compute live cost from the
 * agent.llm_usage event stream without shipping the whole pricing table or
 * importing server-only modules. Resolution mirrors costFor(): exact
 * modelSpec key first, then the bare model id, then the conservative
 * fallback (flagged so the UI can mark the figure as approximate).
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const model = (url.searchParams.get("model") ?? "").trim();
	if (!model) return error(400, "model query param is required");
	const exact = MODEL_PRICING[model];
	const bare = MODEL_PRICING[model.split("/").pop() ?? ""];
	const pricing = exact ?? bare ?? FALLBACK_PRICING;
	return json({
		model,
		pricing,
		fallback: !exact && !bare,
	});
};
