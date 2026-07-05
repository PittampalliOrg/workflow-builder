import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import {
	classifySessionKind,
	DEV_SESSION_WORKFLOW_ID,
	type SessionKind,
} from "$lib/server/application/session-kind";
import type {
	DevEnvironmentGroupReadModel,
	DevEnvironmentSummaryReadModel,
} from "$lib/server/application/ports";

export type SessionDevContext = {
	executionId: string;
	/** Single-service anchor (or pending shell) for the session's execution. */
	environment: DevEnvironmentSummaryReadModel | null;
	/** All per-service previews for the execution (multi-service dev sessions). */
	group: DevEnvironmentGroupReadModel | null;
};

/**
 * SSR the session so the detail page paints without a blank flash and an
 * unauthorized / unknown id 404s pre-paint (the client monolith previously
 * discovered both only after mount). Seeds `session`, the server-computed
 * `kind` (replacing the client's slug-prefix guess), and — for dev sessions —
 * the dev topology for the right-rail card. The client refresh loop still owns
 * live updates; this is just the first, correct paint.
 */
export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.session?.userId) error(401, "Authentication required");
	const adapters = getApplicationAdapters();
	const projectId = locals.session.projectId ?? null;

	const session = await adapters.workflowData.getSessionDetail({
		sessionId: params.id,
		projectId,
		userId: locals.session.userId,
	});
	if (!session) error(404, "Session not found");

	let devWorkflowId: string | null = null;
	if (projectId) {
		devWorkflowId = await adapters.workflowData
			.findProjectWorkflowIdByIdOrNamePrefix({
				projectId,
				workflowId: DEV_SESSION_WORKFLOW_ID,
				namePrefix: "Microservice dev-session%",
			})
			.catch(() => null);
	}
	const kind: SessionKind = classifySessionKind(
		{
			workflowId: session.workflowId,
			workflowExecutionId: session.workflowExecutionId,
			agentSlug: session.agentSlug,
		},
		devWorkflowId,
	);

	let devContext: SessionDevContext | null = null;
	if (kind === "dev" && session.workflowExecutionId) {
		const executionId = session.workflowExecutionId;
		const [environment, groups] = await Promise.all([
			adapters.workflowData
				.getDevEnvironmentOrPending({ executionId, projectId })
				.catch(() => null),
			adapters.workflowData
				.listDevEnvironmentGroups({ projectId })
				.catch(() => [] as DevEnvironmentGroupReadModel[]),
		]);
		devContext = {
			executionId,
			environment,
			group: groups.find((g) => g.executionId === executionId) ?? null,
		};
	}

	return { session, kind, devContext };
};
