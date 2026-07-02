import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params }) => {
	try {
		const executions = await getApplicationAdapters().workflowData.listSandboxExecutions(
			params.name,
		);
		return json(executions);
	} catch (err) {
		if (err instanceof Error && err.message === "Database not configured") {
			return json([]);
		}
		throw err;
	}
};
