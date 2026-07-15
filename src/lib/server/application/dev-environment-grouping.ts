import type {
	DevEnvironmentGroupReadModel,
	DevEnvironmentSummaryReadModel,
} from "$lib/server/application/ports";

/**
 * B5: group flat per-(execution, service) dev-environment rows into one
 * environment per execution. Pure read-model transform — usable from the
 * repository adapter and from routes that already hold the flat list. Input
 * rows arrive newest first (the list query orders by createdAt desc); group
 * order preserves that, while services inside a group sort by name for a
 * stable card grid.
 */
export function groupDevEnvironmentSummaries(
	rows: DevEnvironmentSummaryReadModel[],
): DevEnvironmentGroupReadModel[] {
	const order: string[] = [];
	const byExecution = new Map<string, DevEnvironmentSummaryReadModel[]>();
	for (const row of rows) {
		const bucket = byExecution.get(row.executionId);
		if (bucket) {
			bucket.push(row);
		} else {
			byExecution.set(row.executionId, [row]);
			order.push(row.executionId);
		}
	}
	return order.map((executionId) => {
		const members = byExecution.get(executionId) as DevEnvironmentSummaryReadModel[];
		const primary = members[0];
		const services = [...members].sort((a, b) =>
			a.service.localeCompare(b.service),
		);
		const createdAt = members.reduce(
			(earliest, m) => (m.createdAt < earliest ? m.createdAt : earliest),
			primary.createdAt,
		);
		return {
			executionId,
			services,
			primary,
			ready: members.every((m) => m.ready),
			sessionId: members.find((m) => m.sessionId)?.sessionId ?? null,
			sessionUrl: members.find((m) => m.sessionUrl)?.sessionUrl ?? null,
			runStatus: members.find((m) => m.runStatus)?.runStatus ?? null,
			createdAt,
		};
	});
}

/**
 * Preserve the execution's requested service cardinality while workspace rows
 * arrive asynchronously. Observed rows always win; only absent services receive
 * an explicitly non-ready placeholder, in launch-request order.
 */
export function mergePendingDevEnvironmentServices(
	environment: DevEnvironmentSummaryReadModel,
	persisted: DevEnvironmentSummaryReadModel[],
): DevEnvironmentSummaryReadModel[] {
	const requested = [
		...new Set(
			(environment.requestedServices?.length
				? environment.requestedServices
				: [environment.service]
			).filter(Boolean),
		),
	];
	const observed = new Map<string, DevEnvironmentSummaryReadModel>();
	observed.set(environment.service, environment);
	for (const service of persisted) observed.set(service.service, service);

	const merged = requested.map((service) => {
		const actual = observed.get(service);
		if (actual) return actual;
		return {
			executionId: environment.executionId,
			workspaceRef: "",
			service,
			browseUrl: null,
			podIP: null,
			port: null,
			syncUrl: null,
			ready: false,
			needsDapr: false,
			daprAppId: null,
			sandboxName: null,
			sessionId: null,
			sessionUrl: null,
			runStatus: environment.runStatus,
			createdAt: environment.createdAt,
		};
	});

	const included = new Set(requested);
	for (const service of [environment, ...persisted]) {
		if (!included.has(service.service)) {
			included.add(service.service);
			merged.push(service);
		}
	}
	return merged;
}
