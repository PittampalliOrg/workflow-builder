export type BenchmarkAgentCandidate = {
	id: string;
	name: string;
	slug: string | null;
	runtime: string | null;
	runtimeAppId: string | null;
	currentVersionId: string | null;
	registryStatus: string | null;
	isArchived?: boolean | null;
	version?: number | null;
	projectId?: string | null;
};

export type ValidBenchmarkAgent = BenchmarkAgentCandidate & {
	slug: string;
	runtime: "dapr-agent-py";
	runtimeAppId: string;
	currentVersionId: string;
	version: number;
};

/**
 * SWE-bench V1 intentionally runs inference only through published
 * dapr-agent-py agents using durable/run and agent-runtime-<slug> pods.
 * This guard is pure so the API and unit tests can share exactly the same
 * rejection behavior.
 */
export function assertDaprAgentPyBenchmarkAgent(
	agent: BenchmarkAgentCandidate | null | undefined,
): ValidBenchmarkAgent {
	if (!agent) throw new Error("Selected agent was not found");
	if (agent.isArchived) throw new Error("Selected agent is archived");
	if (agent.runtime !== "dapr-agent-py") {
		throw new Error(
			`SWE-bench runs require a dapr-agent-py runtime; got ${agent.runtime ?? "unknown"}`,
		);
	}
	if (!agent.slug) throw new Error("Selected agent is missing a slug");
	if (!agent.runtimeAppId?.startsWith("agent-runtime-")) {
		throw new Error(
			"Selected agent must be published to an agent-runtime-<slug> runtime",
		);
	}
	if (!agent.currentVersionId || !agent.version) {
		throw new Error("Selected agent must have a published version");
	}
	if (agent.registryStatus !== "registered") {
		throw new Error(
			`Selected agent must be registered before benchmarking; current status is ${agent.registryStatus ?? "unknown"}`,
		);
	}
	return agent as ValidBenchmarkAgent;
}
