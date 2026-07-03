import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await getApplicationAdapters().agentImportExport.exportAgent({
		agentId: params.id,
	});
	if (result.status === "not_found") return error(404, result.message);

	return new Response(result.markdown, {
		headers: {
			"content-type": "text/markdown; charset=utf-8",
			"content-disposition": `attachment; filename="${result.filename}"`,
		},
	});
};
