import { command, getRequestEvent, query } from "$app/server";
import { error } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import type {
	DevSidecarRunView,
	DevSidecarStatusView,
} from "$lib/server/application/dev-preview-sidecar";
import type { DevEnvironmentSummaryReadModel } from "$lib/server/application/ports";

function requireSession() {
	const event = getRequestEvent();
	const session = event.locals.session;
	if (!session?.userId) error(401, "Authentication required");
	return session;
}

/** The dev environment + its per-service previews for the detail page. */
export const getDevEnvironment = query(
	"unchecked",
	async (
		executionId: string,
	): Promise<{
		environment: DevEnvironmentSummaryReadModel;
		services: DevEnvironmentSummaryReadModel[];
	}> => {
		const session = requireSession();
		const workflowData = getApplicationAdapters().workflowData;
		const environment = await workflowData.getDevEnvironmentOrPending({
			executionId,
			projectId: session.projectId ?? null,
		});
		if (!environment) error(404, "Dev environment not found");
		const groups = await workflowData.listDevEnvironmentGroups({
			projectId: session.projectId ?? null,
		});
		const services =
			groups.find((g) => g.executionId === executionId)?.services ?? [environment];
		return { environment, services };
	},
);

/** One service's dev-sync-sidecar `/__status` (on demand — never blanket-polled). */
export const getSidecarStatus = query(
	"unchecked",
	async (input: { executionId: string; service: string }): Promise<DevSidecarStatusView> => {
		const session = requireSession();
		const result = await getApplicationAdapters().devPreviewSidecar.status({
			executionId: input.executionId,
			service: input.service,
			projectId: session.projectId ?? null,
		});
		if (!result) error(404, "Dev environment service not found");
		return result;
	},
);

/** Run one allowlisted named command on a service's dev pod (`/__run`). */
export const runSidecarCmd = command(
	"unchecked",
	async (input: {
		executionId: string;
		service: string;
		cmd: string;
	}): Promise<DevSidecarRunView> => {
		const session = requireSession();
		const cmd = input.cmd?.trim();
		if (!cmd) error(400, "cmd required");
		const result = await getApplicationAdapters().devPreviewSidecar.run({
			executionId: input.executionId,
			service: input.service,
			projectId: session.projectId ?? null,
			cmd,
		});
		if (!result) error(404, "Dev environment service not found");
		return result;
	},
);
