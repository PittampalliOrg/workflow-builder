#!/usr/bin/env npx tsx
/**
 * Verifies Dapr 1.17 workflow API features on workflow-orchestrator:
 * - start (versioned)
 * - status
 * - list
 * - history
 * - pause
 * - resume
 * - rerun from event
 * - terminate
 * - purge
 *
 * Usage:
 *   ORCHESTRATOR_URL=http://127.0.0.1:8080 pnpm tsx scripts/verify-dapr-117-workflow-apis.ts
 */

const ORCHESTRATOR_URL =
	process.env.ORCHESTRATOR_URL?.trim() || "http://127.0.0.1:8080";
const WORKFLOW_VERSION = process.env.WORKFLOW_VERSION?.trim() || "v1";
const POLL_TIMEOUT_SECONDS = Number.parseInt(
	process.env.VERIFY_TIMEOUT_SECONDS?.trim() || "60",
	10,
);

type StartResponse = {
	instanceId: string;
	workflowId: string;
	status: string;
	workflowVersion?: string | null;
};

type StatusResponse = {
	instanceId: string;
	workflowId: string;
	runtimeStatus: string;
	workflowVersion?: string | null;
	workflowNameVersioned?: string | null;
	message?: string | null;
	error?: string | null;
};

type HistoryResponse = {
	instanceId: string;
	events: Array<{ eventId?: number | null; eventType?: string | null }>;
};

type ListResponse = {
	workflows: Array<{
		instanceId: string;
		workflowId: string;
		runtimeStatus: string;
		workflowVersion?: string | null;
		workflowNameVersioned?: string | null;
	}>;
	total: number;
};

type RerunResponse = {
	success: boolean;
	sourceInstanceId: string;
	fromEventId: number;
	newInstanceId: string;
};

function log(message: string): void {
	console.log(`[verify-dapr-117] ${message}`);
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function httpJson<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, init);
	const body = await response.text();
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${url}: ${body.slice(0, 500)}`);
	}
	try {
		return JSON.parse(body) as T;
	} catch {
		throw new Error(`Invalid JSON from ${url}: ${body.slice(0, 500)}`);
	}
}

function isUnsupportedWorkflowQueryError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	const lowered = message.toLowerCase();
	return (
		lowered.includes("http 501") ||
		lowered.includes("workflow_query_unsupported") ||
		lowered.includes("unimplemented")
	);
}

async function pollUntil(
	instanceId: string,
	predicate: (status: string) => boolean,
	description: string,
): Promise<StatusResponse> {
	const deadline = Date.now() + POLL_TIMEOUT_SECONDS * 1000;
	let latest: StatusResponse | null = null;
	while (Date.now() < deadline) {
		latest = await httpJson<StatusResponse>(
			`${ORCHESTRATOR_URL}/api/v2/workflows/${encodeURIComponent(instanceId)}/status`,
		);
		const runtime = String(latest.runtimeStatus || "").toUpperCase();
		log(`instance=${instanceId} runtimeStatus=${runtime}`);
		if (predicate(runtime)) {
			return latest;
		}
		await sleep(1500);
	}
	throw new Error(
		`Timed out waiting for ${description} on ${instanceId}. Last status: ${JSON.stringify(latest)}`,
	);
}

async function pollUntilTerminal(instanceId: string): Promise<StatusResponse> {
	return pollUntil(
		instanceId,
		(runtime) =>
			runtime === "COMPLETED" ||
			runtime === "FAILED" ||
			runtime === "TERMINATED" ||
			runtime === "CANCELED",
		"terminal status",
	);
}

async function startWorkflow(
	definition: Record<string, unknown>,
): Promise<StartResponse> {
	return httpJson<StartResponse>(`${ORCHESTRATOR_URL}/api/v2/workflows`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			definition,
			triggerData: { smoke: true, startedAt: new Date().toISOString() },
			workflowVersion: WORKFLOW_VERSION,
		}),
	});
}

async function main(): Promise<void> {
	const suffix = Date.now();
	const instantWorkflowId = `dapr117-smoke-${suffix}`;
	const timerWorkflowId = `dapr117-control-${suffix}`;
	const now = new Date().toISOString();
	const instantDefinition = {
		id: instantWorkflowId,
		name: `Dapr 1.17 Smoke ${suffix}`,
		version: "1.0.0",
		nodes: [],
		edges: [],
		executionOrder: [],
		createdAt: now,
		updatedAt: now,
	};
	const timerDefinition = {
		id: timerWorkflowId,
		name: `Dapr 1.17 Control ${suffix}`,
		version: "1.0.0",
		nodes: [
			{
				id: "wait",
				type: "timer",
				label: "Wait",
				config: {
					durationSeconds: 120,
				},
			},
		],
		edges: [],
		executionOrder: ["wait"],
		createdAt: now,
		updatedAt: now,
	};

	log(`orchestrator=${ORCHESTRATOR_URL}`);
	log(
		`starting workflow ${instantWorkflowId} with workflowVersion=${WORKFLOW_VERSION}`,
	);
	const started = await startWorkflow(instantDefinition);
	const terminal = await pollUntilTerminal(started.instanceId);

	log("listing workflows");
	try {
		const listed = await httpJson<ListResponse>(
			`${ORCHESTRATOR_URL}/api/v2/workflows?search=${encodeURIComponent(instantWorkflowId)}&limit=10&offset=0`,
		);
		const listMatch = listed.workflows.find(
			(item) => item.instanceId === started.instanceId,
		);
		if (!listMatch) {
			throw new Error(
				`Started instance ${started.instanceId} was not returned by list API`,
			);
		}
	} catch (error) {
		if (!isUnsupportedWorkflowQueryError(error)) {
			throw error;
		}
		log("list API unsupported by current Dapr runtime; continuing");
	}

	log("fetching history");
	const history = await httpJson<HistoryResponse>(
		`${ORCHESTRATOR_URL}/api/v2/workflows/${encodeURIComponent(started.instanceId)}/history`,
	);
	if (!Array.isArray(history.events) || history.events.length === 0) {
		throw new Error("History API returned no events");
	}

	log("rerunning from event 0");
	const rerun = await httpJson<RerunResponse>(
		`${ORCHESTRATOR_URL}/api/v2/workflows/${encodeURIComponent(started.instanceId)}/rerun`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				fromEventId: 0,
				reason: "dapr-1.17-verification",
			}),
		},
	);
	if (!rerun.success || !rerun.newInstanceId) {
		throw new Error(`Rerun failed: ${JSON.stringify(rerun)}`);
	}
	const rerunTerminal = await pollUntilTerminal(rerun.newInstanceId);

	log(`starting control workflow ${timerWorkflowId}`);
	const controlStarted = await startWorkflow(timerDefinition);
	await pollUntil(
		controlStarted.instanceId,
		(runtime) => runtime === "RUNNING" || runtime === "PENDING",
		"active status",
	);

	log("pausing control workflow");
	await httpJson<{ success: boolean }>(
		`${ORCHESTRATOR_URL}/api/v2/workflows/${encodeURIComponent(controlStarted.instanceId)}/pause`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
		},
	);
	const paused = await pollUntil(
		controlStarted.instanceId,
		(runtime) => runtime === "SUSPENDED",
		"suspended status",
	);

	log("resuming control workflow");
	await httpJson<{ success: boolean }>(
		`${ORCHESTRATOR_URL}/api/v2/workflows/${encodeURIComponent(controlStarted.instanceId)}/resume`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
		},
	);
	const resumed = await pollUntil(
		controlStarted.instanceId,
		(runtime) => runtime === "RUNNING" || runtime === "PENDING",
		"resumed status",
	);

	log("terminating control workflow");
	await httpJson<{ success: boolean }>(
		`${ORCHESTRATOR_URL}/api/v2/workflows/${encodeURIComponent(controlStarted.instanceId)}/terminate`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason: "dapr-1.17-verification" }),
		},
	);
	const terminated = await pollUntil(
		controlStarted.instanceId,
		(runtime) => runtime === "TERMINATED" || runtime === "CANCELED",
		"terminated status",
	);

	log("purging terminated workflow");
	await httpJson<{ success: boolean }>(
		`${ORCHESTRATOR_URL}/api/v2/workflows/${encodeURIComponent(controlStarted.instanceId)}`,
		{
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
		},
	);

	console.log(
		JSON.stringify(
			{
				ok: true,
				orchestratorUrl: ORCHESTRATOR_URL,
				workflowVersion: WORKFLOW_VERSION,
				started: {
					instanceId: started.instanceId,
					workflowId: started.workflowId,
					runtimeStatus: terminal.runtimeStatus,
					workflowVersion: terminal.workflowVersion ?? null,
					workflowNameVersioned: terminal.workflowNameVersioned ?? null,
				},
				list: {
					total: listed.total,
					matchedInstanceId: listMatch.instanceId,
				},
				history: {
					events: history.events.length,
					firstEventType: history.events[0]?.eventType ?? null,
				},
				rerun: {
					sourceInstanceId: rerun.sourceInstanceId,
					newInstanceId: rerun.newInstanceId,
					runtimeStatus: rerunTerminal.runtimeStatus,
					workflowVersion: rerunTerminal.workflowVersion ?? null,
					workflowNameVersioned: rerunTerminal.workflowNameVersioned ?? null,
				},
				control: {
					instanceId: controlStarted.instanceId,
					pausedRuntimeStatus: paused.runtimeStatus,
					resumedRuntimeStatus: resumed.runtimeStatus,
					terminatedRuntimeStatus: terminated.runtimeStatus,
				},
			},
			null,
			2,
		),
	);
}

main().catch((error) => {
	console.error(
		`[verify-dapr-117] FAILED: ${
			error instanceof Error ? error.message : String(error)
		}`,
	);
	process.exit(1);
});
