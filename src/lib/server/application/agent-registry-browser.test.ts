import { describe, expect, it, vi } from "vitest";
import { ApplicationAgentRegistryBrowserService } from "$lib/server/application/agent-registry-browser";
import type { DaprAgentRegistryStateReader } from "$lib/server/application/ports";

describe("ApplicationAgentRegistryBrowserService", () => {
	it("loads and normalizes agents from configured registry teams", async () => {
		const state = fakeRegistryState({
			"agents:team-a:_index": { agents: ["writer", "writer"] },
			"agents:team-a:writer": {
				version: "0.12.0",
				name: "writer",
				registered_at: "2026-05-15T12:00:00.000Z",
				agent: {
					appid: "agent-runtime-writer",
					type: "durable",
					framework: "Dapr Agents",
					system_prompt: "Write clearly",
					max_iterations: 120,
					tool_choice: "auto",
					orchestrator: false,
				},
				pubsub: null,
				memory: null,
				llm: { provider: "dapr" },
				tools: [{ name: "search" }],
			},
		});
		const service = new ApplicationAgentRegistryBrowserService({
			registryState: state,
		});

		const model = await service.listRegistryAgents();

		expect(model).toMatchObject({
			source: "dapr-agent-registry",
			storeName: "agent-registry",
			teams: ["team-a"],
			diagnostics: [],
		});
		expect(model.agents).toEqual([
			expect.objectContaining({
				id: "team-a:writer",
				name: "writer",
				team: "team-a",
				registryKey: "agents:team-a:writer",
				appId: "agent-runtime-writer",
				systemPrompt: "Write clearly",
				maxIterations: 120,
				tools: [{ name: "search" }],
			}),
		]);
		expect(state.readState).toHaveBeenCalledWith({
			store: "agent-registry",
			key: "agents:team-a:_index",
			team: "team-a",
			partitionKey: "agents:team-a",
		});
	});

	it("reports missing index and missing agent diagnostics", async () => {
		const service = new ApplicationAgentRegistryBrowserService({
			registryState: fakeRegistryState({
				"agents:team-a:_index": { agents: ["missing"] },
			}),
		});

		const model = await service.listRegistryAgents();

		expect(model.agents).toEqual([]);
		expect(model.diagnostics).toEqual([
			"Registry index references missing agent key agent-registry/agents:team-a:missing",
		]);
	});
});

function fakeRegistryState(
	values: Record<string, unknown>,
): DaprAgentRegistryStateReader {
	return {
		getRegistryStoreName: vi.fn(() => "agent-registry"),
		getRegistryTeams: vi.fn(() => ["team-a"]),
		readState: vi.fn(async ({ key }) => {
			if (!(key in values)) return { found: false, status: 204 };
			return { found: true, status: 200, value: values[key] };
		}),
	};
}
