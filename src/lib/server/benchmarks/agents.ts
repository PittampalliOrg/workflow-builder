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

export class BenchmarkAgentValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BenchmarkAgentValidationError";
	}
}

function validationError(message: string): never {
	throw new BenchmarkAgentValidationError(message);
}

function resolveRuntimeAppId(agent: BenchmarkAgentCandidate): string | null {
	if (agent.runtimeAppId?.startsWith("agent-runtime-")) return agent.runtimeAppId;
	if (agent.slug && agent.runtime === "dapr-agent-py") return `agent-runtime-${agent.slug}`;
	return agent.runtimeAppId ?? null;
}

/**
 * SWE-bench V1 intentionally runs inference only through published
 * dapr-agent-py agents using durable/run and agent-runtime-<slug> pods.
 * This guard is pure so the API and unit tests can share exactly the same
 * rejection behavior.
 */
export function assertDaprAgentPyBenchmarkAgent(
	agent: BenchmarkAgentCandidate | null | undefined,
): ValidBenchmarkAgent {
	if (!agent) validationError("Selected agent was not found");
	if (agent.isArchived) validationError("Selected agent is archived");
	if (agent.runtime !== "dapr-agent-py") {
		validationError(
			`SWE-bench runs require a dapr-agent-py runtime; got ${agent.runtime ?? "unknown"}`,
		);
	}
	if (!agent.slug) validationError("Selected agent is missing a slug");
	const runtimeAppId = resolveRuntimeAppId(agent);
	if (!runtimeAppId?.startsWith("agent-runtime-")) {
		validationError(
			"Selected agent must be published to an agent-runtime-<slug> runtime",
		);
	}
	if (!agent.currentVersionId || !agent.version) {
		validationError("Selected agent must have a published version");
	}
	if (agent.registryStatus !== "registered") {
		validationError(
			`Selected agent must be registered before benchmarking; current status is ${agent.registryStatus ?? "unknown"}`,
		);
	}
	return { ...agent, runtimeAppId } as ValidBenchmarkAgent;
}
