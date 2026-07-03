/**
 * GET /api/workflows/executions/[executionId]/workspace-content?path=<rel>
 *
 * Read one file from a CLI run's shared durable workspace. Path is relative to
 * the instance root; traversal is rejected by the workspace adapter.
 *
 * Workspace-scoped by the application service.
 */

import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const { executionId } = params;
	if (!executionId) return error(400, "executionId required");

	const relPath = url.searchParams.get("path");
	if (!relPath) return error(400, "path required");

	const result =
		await getApplicationAdapters().workflowExecutionWorkspace.readWorkspaceFile(
			{
				executionId,
				path: relPath,
				userId: locals.session.userId,
				projectId: locals.session.projectId ?? null,
			},
		);
	if (result.status === "error")
		return error(result.httpStatus, result.message);

	return new Response(toArrayBuffer(result.body.bytes), {
		headers: {
			"Content-Type": result.body.contentType,
			"Cache-Control": "no-store",
		},
	});
};

function toArrayBuffer(bytes: ArrayBuffer | Buffer): ArrayBuffer {
	if (bytes instanceof ArrayBuffer) return bytes;
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}
