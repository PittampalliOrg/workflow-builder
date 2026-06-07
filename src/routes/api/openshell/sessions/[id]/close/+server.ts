import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { openshellRuntimeFetch } from "$lib/server/openshell-runtime";
import { getOpenShellSession } from "$lib/server/openshell-sessions";

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const session = await getOpenShellSession(params.id, {
		userId: locals.session.userId,
		projectId: locals.session.projectId,
	});
	if (!session) return error(404, "OpenShell session not found");

	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const terminalId =
		typeof body.terminalId === "string" && body.terminalId.trim()
			? body.terminalId.trim()
			: null;
	const sandboxName = session.sandboxName;
	let terminalClosed = false;
	if (sandboxName && terminalId) {
		const res = await openshellRuntimeFetch(
			`/api/v1/sandboxes/${encodeURIComponent(sandboxName)}/terminal-sessions/${encodeURIComponent(terminalId)}`,
			{ method: "DELETE" },
		);
		if (!res.ok) {
			const message = await res.text().catch(() => "");
			return error(
				res.status,
				message.slice(0, 300) || "Failed to close terminal session",
			);
		}
		const result = (await res.json().catch(() => ({}))) as {
			closed?: boolean;
		};
		terminalClosed = result.closed === true;
	}

	// (A dead `stopSession` branch that raised a raw user.interrupt past the
	// lifecycle controller was removed — no caller set it, and stopping a session
	// must go through POST /api/v1/sessions/[id]/control/interrupt | /stop.)
	return json({ ok: true, terminalClosed });
};
