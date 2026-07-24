import { json } from "@sveltejs/kit";
import { validateInternalToken } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";
import { resolveInternalWorkflowPrincipal } from "../../workflow-mcp-principal";

/**
 * Shared guard for the internal execution-control routes behind the Workflow
 * MCP checkpoint/replay/promotion tools. The service token authenticates the
 * MCP server; the signed workflow principal authorizes the caller's workspace
 * and required scope; getScopedExecutionById confirms the execution belongs to
 * that workspace (so the tools never leak or act on cross-workspace runs).
 *
 * Read tools pass "workflow:read"; mutating tools (restore, resume, promote)
 * pass "workflow:execute".
 */
type GuardExecution = NonNullable<
	Awaited<
		ReturnType<
			ReturnType<typeof getApplicationAdapters>["workflowData"]["getScopedExecutionById"]
		>
	>
>;

type GuardResult =
	| { ok: false; res: Response }
	| { ok: true; execution: GuardExecution };

export async function guardInternalExecutionAccess(
	request: Request,
	executionId: string,
	requiredScope: "workflow:read" | "workflow:execute",
): Promise<GuardResult> {
	if (!validateInternalToken(request)) {
		return { ok: false, res: json({ error: "unauthorized" }, { status: 401 }) };
	}

	const app = getApplicationAdapters();
	const principalResult = await resolveInternalWorkflowPrincipal(
		request,
		app.internalWorkflowPrincipal,
		{ requiredScope },
	);
	if (!principalResult.ok) {
		return {
			ok: false,
			res: json({ error: principalResult.error }, { status: principalResult.status }),
		};
	}

	const execution = await app.workflowData.getScopedExecutionById({
		executionId,
		userId: principalResult.principal.userId,
		projectId: principalResult.principal.projectId,
	});
	if (!execution) {
		return {
			ok: false,
			res: json(
				{ error: `Execution ${executionId} not found in this workspace` },
				{ status: 404 },
			),
		};
	}
	return { ok: true, execution };
}
