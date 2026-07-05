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
