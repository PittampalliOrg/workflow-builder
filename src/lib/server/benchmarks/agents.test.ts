import { describe, expect, it } from "vitest";
import { assertDaprAgentPyBenchmarkAgent } from "./agents";

const baseAgent = {
	id: "agent_1",
	name: "Solver",
	slug: "solver",
	runtime: "dapr-agent-py",
	runtimeAppId: "agent-runtime-solver",
	currentVersionId: "ver_1",
	registryStatus: "registered",
	version: 1,
};

describe("benchmark agent validation", () => {
	it("accepts a published dapr-agent-py agent runtime", () => {
		expect(assertDaprAgentPyBenchmarkAgent(baseAgent).runtimeAppId).toBe(
			"agent-runtime-solver",
		);
	});

	it("derives the per-agent runtime app id for legacy registered rows", () => {
		expect(
			assertDaprAgentPyBenchmarkAgent({
				...baseAgent,
				runtimeAppId: "dapr-agent-py",
			}).runtimeAppId,
		).toBe("agent-runtime-solver");
		expect(
			assertDaprAgentPyBenchmarkAgent({
				...baseAgent,
				runtimeAppId: null,
			}).runtimeAppId,
		).toBe("agent-runtime-solver");
	});

	it("rejects non-dapr-agent-py runtimes", () => {
		expect(() =>
			assertDaprAgentPyBenchmarkAgent({
				...baseAgent,
				runtime: "browser-use-agent",
			}),
		).toThrow(/dapr-agent-py/);
	});

	it("rejects unpublished or unregistered agents", () => {
		expect(() =>
			assertDaprAgentPyBenchmarkAgent({
				...baseAgent,
				currentVersionId: null,
			}),
		).toThrow(/published version/);
		expect(() =>
			assertDaprAgentPyBenchmarkAgent({
				...baseAgent,
				registryStatus: "failed",
			}),
		).toThrow(/registered/);
	});
});
