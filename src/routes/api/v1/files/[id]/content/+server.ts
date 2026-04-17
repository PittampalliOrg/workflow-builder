import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getFileContent } from "$lib/server/files/registry";

/**
 * Download the raw bytes. Sets Content-Disposition so browsers prompt a
 * save dialog; drop `attachment;` to render inline if the caller is a
 * session resources mount (rare — mounts happen server-side, not via
 * the browser, so this is fine to keep strict).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await getFileContent(params.id);
	if (!result) return error(404, "File not found");
	const { summary, bytes } = result;
	return new Response(new Uint8Array(bytes), {
		status: 200,
		headers: {
			"Content-Type": summary.contentType || "application/octet-stream",
			"Content-Length": String(summary.sizeBytes),
			"Content-Disposition": `attachment; filename="${encodeURIComponent(summary.name)}"`,
			"Cache-Control": "private, max-age=3600",
		},
	});
};
