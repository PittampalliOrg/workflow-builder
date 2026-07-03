import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params }) => {
	try {
		const checkpoints =
			await getApplicationAdapters().workflowCodeCheckpoints.listForExecution({
				executionId: params.executionId,
			});
		return json({ checkpoints });
	} catch (err) {
		console.error("[code-checkpoints] list failed:", err);
		return json({ message: "Failed to load code checkpoints" }, { status: 500 });
	}
};
