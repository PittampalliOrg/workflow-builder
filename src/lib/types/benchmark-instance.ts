// Shared types for the SWE-bench instance browser. Mirrors the projection
// returned by `src/routes/workspaces/[slug]/benchmarks/+page.server.ts`.

export type BenchmarkInstanceRow = {
	id: string;
	instanceId: string;
	suiteSlug: string;
	suiteName: string;
	repo: string | null;
	baseCommit: string | null;
	version: string | null;
	environmentStatus: "validated" | "building" | "failed" | "not_built";
	environmentKey: string | null;
	problemPreview: string;
	hasHints: boolean;
	hintsLen: number;
};

export type SuiteFacet = {
	slug: string;
	name: string;
	instanceCount: number;
};

export type RepoFacet = {
	value: string;
	label: string;
	count: number;
};

export type RunnableAgent = {
	id: string;
	slug: string;
	name: string;
	avatar: string | null;
	runtime: string;
	currentVersion: number;
	registryStatus: string;
	modelSpec: string | null;
	benchmarkCapacity?: {
		runtimeClass: string;
		runtimeAppId: string;
		runtimeReplicas: number;
		perSidecarWorkflowLimit: number;
		slotsPerReplica: number;
		maxActiveSessions: number;
		maxActiveSandboxes: number | null;
	};
};
