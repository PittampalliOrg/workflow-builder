const PHOENIX_BASE_URL = "https://phoenix-ryzen.tail286401.ts.net";

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
	return `${PHOENIX_BASE_URL}/projects/${getPhoenixProjectId(serviceNames)}/traces/${traceId}`;
}
