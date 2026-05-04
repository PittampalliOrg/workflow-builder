import {
	agentModelOptionFor,
	canonicalAgentModelSpec,
} from "$lib/agents/model-options";

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
	modelSpec?: string | null;
};

export type ValidBenchmarkAgent = BenchmarkAgentCandidate & {
	slug: string;
	runtime: "dapr-agent-py";
	runtimeAppId: string;
	currentVersionId: string;
	version: number;
	modelSpec: string;
	effectiveLlmComponent: string;
	effectiveProvider: string;
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

const TOOL_CAPABLE_BENCHMARK_PROVIDERS = new Set([
	"anthropic",
	"openai",
	"foundry",
	"together",
	"nvidia",
	"deepseek",
]);

export function assertBenchmarkModelMatchesRuntime(params: {
	agentModelSpec?: string | null;
	requestedModelNameOrPath?: string | null;
}): { modelSpec: string; component: string; provider: string } {
	const modelSpec = canonicalAgentModelSpec(params.agentModelSpec);
	if (!modelSpec) {
		validationError(
			`SWE-bench agents must use a supported durable coding model; got ${params.agentModelSpec ?? "unknown"}`,
		);
	}
	const option = agentModelOptionFor(modelSpec);
	if (!option) {
		validationError(`SWE-bench model ${modelSpec} is not configured`);
	}
	if (
		option.sweBenchCapable === false ||
		!TOOL_CAPABLE_BENCHMARK_PROVIDERS.has(option.provider)
	) {
		validationError(
			`SWE-bench model ${modelSpec} is not tool-capable for durable coding agents`,
		);
	}

	const requested = canonicalAgentModelSpec(params.requestedModelNameOrPath);
	if (requested && requested !== modelSpec) {
		validationError(
			`Requested SWE-bench model ${requested} does not match the selected agent runtime model ${modelSpec}`,
		);
	}

	return {
		modelSpec,
		component: option.component,
		provider: option.provider,
	};
}

/**
 * SWE-bench V1 intentionally runs inference only through published
 * dapr-agent-py agents using durable/run and an agent-runtime Dapr app id
 * (either a dedicated agent-runtime-<slug> pod or a shared runtime pool).
 * This guard is pure so the API and unit tests can share exactly the same
 * rejection behavior.
 */
export function assertDaprAgentPyBenchmarkAgent(
	agent: BenchmarkAgentCandidate | null | undefined,
	options: { requestedModelNameOrPath?: string | null } = {},
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
			"Selected agent must be published to an agent-runtime app id",
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
	const model = assertBenchmarkModelMatchesRuntime({
		agentModelSpec: agent.modelSpec,
		requestedModelNameOrPath: options.requestedModelNameOrPath,
	});
	return {
		...agent,
		runtimeAppId,
		modelSpec: model.modelSpec,
		effectiveLlmComponent: model.component,
		effectiveProvider: model.provider,
	} as ValidBenchmarkAgent;
}
