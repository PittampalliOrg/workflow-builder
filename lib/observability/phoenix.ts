export const PHOENIX_BASE_URL = "https://phoenix-ryzen.tail286401.ts.net";

const DEFAULT_PHOENIX_PROJECT_ID = "UHJvamVjdDox";

const PHOENIX_PROJECT_IDS_BY_SERVICE = new Map<string, string>([
	["dapr-swe", "UHJvamVjdDoy"],
	["openshell-langgraph-observable", "UHJvamVjdDoz"],
]);

export function getPhoenixProjectId(serviceNames: string[]): string {
	for (const serviceName of serviceNames) {
		const projectId = PHOENIX_PROJECT_IDS_BY_SERVICE.get(serviceName);
		if (projectId) {
			return projectId;
		}
	}

	return DEFAULT_PHOENIX_PROJECT_ID;
}

export function getPhoenixTraceUrl(
	traceId: string,
	serviceNames: string[],
): string {
	const params = new URLSearchParams({
		traceId,
		projectId: getPhoenixProjectId(serviceNames),
	});
	return `/api/observability/phoenix-trace?${params.toString()}`;
}

export function getDirectPhoenixTraceUrl(input: {
	projectId: string;
	traceId: string;
	selectedSpanNodeId?: string | null;
}): string {
	const url = new URL(
		`${PHOENIX_BASE_URL}/projects/${input.projectId}/traces/${input.traceId}`,
	);
	if (input.selectedSpanNodeId) {
		url.searchParams.set("selectedSpanNodeId", input.selectedSpanNodeId);
	}
	return url.toString();
}
