export type DevExecutionLifecycleState = "complete" | "active" | "pending" | "failed";

export type DevExecutionLifecycleStage = {
	label: string;
	detail: string;
	state: DevExecutionLifecycleState;
};

export type DevExecutionLifecycleInput = {
	executionId: string;
	runStatus: string | null;
	sessionId: string | null;
	services: readonly {
		ready: boolean;
		syncUrl: string | null;
	}[];
};

export type DevExecutionLifecycle = {
	runStatus: string;
	runTerminal: boolean;
	effectiveStatus: string;
	stages: DevExecutionLifecycleStage[];
	summary: string;
};

const TERMINAL_RUN_STATUSES = new Set([
	"success",
	"error",
	"cancelled",
	"completed",
	"failed",
	"terminated",
]);

/**
 * Project existing dev-environment read data into UI lifecycle state. A sync URL
 * proves only that an endpoint is available, so this deliberately never claims
 * that a file sync or HMR update has occurred.
 */
export function deriveDevExecutionLifecycle(
	input: DevExecutionLifecycleInput,
): DevExecutionLifecycle {
	const runStatus = (input.runStatus ?? "provisioning").toLowerCase();
	const runFailed = runStatus === "error" || runStatus === "failed";
	const runTerminal = TERMINAL_RUN_STATUSES.has(runStatus);
	const readyServices = input.services.filter((service) => service.ready).length;
	const allServicesReady = input.services.length > 0 && readyServices === input.services.length;
	const syncEndpoints = input.services.filter((service) => Boolean(service.syncUrl)).length;
	const allSyncEndpoints =
		input.services.length > 0 && syncEndpoints === input.services.length;

	const stages: DevExecutionLifecycleStage[] = [
		{
			label: "Requested",
			detail: `Run ${input.executionId.slice(0, 8)}`,
			state: "complete",
		},
		{
			label: "Services",
			detail: `${readyServices}/${input.services.length} ready`,
			state: allServicesReady
				? "complete"
				: runFailed
					? "failed"
					: runTerminal
						? "pending"
						: "active",
		},
		{
			label: "Live-sync endpoint",
			detail:
				syncEndpoints > 0
					? `${syncEndpoints}/${input.services.length} endpoint${syncEndpoints === 1 ? "" : "s"} available`
					: "Endpoint pending",
			state:
				allSyncEndpoints && allServicesReady
					? "complete"
					: runFailed
						? "failed"
						: allServicesReady && !runTerminal
							? "active"
							: "pending",
		},
		{
			label: "Agent session",
			detail: input.sessionId
				? "Attached"
				: runTerminal
					? "No session attached"
					: "Waiting for handoff",
			state: input.sessionId
				? "complete"
				: runFailed
					? "failed"
					: allServicesReady && !runTerminal
						? "active"
						: "pending",
		},
	];

	let summary: string;
	if (runFailed) {
		summary = `Environment workflow failed with status ${runStatus}.`;
	} else if (allServicesReady && allSyncEndpoints && input.sessionId) {
		summary =
			"Services and live-sync endpoints are ready, and a coding-agent session is attached.";
	} else if (runTerminal && !allServicesReady) {
		summary = `Run ${runStatus}; ${readyServices} of ${input.services.length} services reported ready.`;
	} else if (runTerminal && !input.sessionId) {
		summary = `Run ${runStatus}; no coding-agent session is attached.`;
	} else if (!allServicesReady) {
		summary = `Provisioning services: ${readyServices} of ${input.services.length} ready.`;
	} else if (syncEndpoints === 0) {
		summary = "Services are ready; waiting for a live-sync endpoint.";
	} else if (!allSyncEndpoints) {
		summary = `Live-sync endpoints: ${syncEndpoints} of ${input.services.length} available.`;
	} else {
		summary = "Live sync is available; waiting for the coding-agent session.";
	}

	return {
		runStatus,
		runTerminal,
		effectiveStatus: runFailed ? runStatus : allServicesReady ? "ready" : runStatus,
		stages,
		summary,
	};
}
