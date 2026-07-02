import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

const EMPTY_STATS = {
	total: 0,
	byPhase: {},
	executions24h: 0,
	avgAgeMinutes: 0,
};

export const GET: RequestHandler = async () => {
	try {
		return json(await getApplicationAdapters().workflowData.getSandboxStats());
	} catch (err) {
		if (err instanceof Error && err.message === "Database not configured") {
			return json(EMPTY_STATS);
		}
		throw err;
	}
};
