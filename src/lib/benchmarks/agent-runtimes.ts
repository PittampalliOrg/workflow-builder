export const BENCHMARK_AGENT_RUNTIMES = [
	"dapr-agent-py",
	"adk-agent-py",
	"claude-agent-py",
	"claude-code-cli",
	"codex-cli",
	"agy-cli",
] as const;

export type BenchmarkAgentRuntime = (typeof BENCHMARK_AGENT_RUNTIMES)[number];

export function isBenchmarkAgentRuntime(
	runtime: string | null | undefined,
): runtime is BenchmarkAgentRuntime {
	return BENCHMARK_AGENT_RUNTIMES.includes(
		runtime as BenchmarkAgentRuntime,
	);
}
