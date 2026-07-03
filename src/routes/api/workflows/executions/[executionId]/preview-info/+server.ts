import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { CliPreviewCommandResult } from "$lib/server/application/cli-preview";

/**
 * Which live-preview backend applies to this run, so the run-page Preview tab can
 * render ONE consistent control for both families:
 *   - `cli`       → JuiceFS execution-keyed preview (interactive-cli runtimes)
 *   - `openshell` → retained dapr/openshell sandbox preview
 *   - `null`      → nothing previewable
 * Detection only — provisions nothing.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	return cliPreviewResponse(
		await getApplicationAdapters().cliPreview.getExecutionPreviewInfo({
			executionId: params.executionId!,
		}),
	);
};

function cliPreviewResponse(result: CliPreviewCommandResult) {
	if (result.status === "error") return error(result.httpStatus, result.message);
	return json(result.body, { status: result.httpStatus ?? 200 });
}
