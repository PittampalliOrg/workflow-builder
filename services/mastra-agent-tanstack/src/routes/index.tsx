/**
 * SSR Dashboard — Server-rendered agent monitoring page
 */

import { createFileRoute } from "@tanstack/react-router";
import { getAgentStatus } from "~/server-functions/get-agent-status";
import { getEventHistory } from "~/server-functions/get-event-history";
import { getWorkflowContext } from "~/server-functions/get-workflow-context";
import { Dashboard } from "~/components/Dashboard";
import type { AgentState, AgentEvent, WorkflowContext as WfCtx } from "~/lib/types";

export const Route = createFileRoute("/")({
	loader: async () => {
		try {
			const [state, events, workflow] = await Promise.all([
				getAgentStatus(),
				getEventHistory(),
				getWorkflowContext(),
			]);
			return {
				state: state as AgentState,
				events: events as AgentEvent[],
				workflow: workflow as WfCtx,
			};
		} catch (err) {
			console.error("[mastra-tanstack] Loader error:", err);
			return { state: null, events: null, workflow: null };
		}
	},
	component: IndexPage,
});

function IndexPage() {
	const { state, events, workflow } = Route.useLoaderData();

	return (
		<Dashboard
			initialState={state}
			initialEvents={events}
			initialWorkflow={workflow}
		/>
	);
}
