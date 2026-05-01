import { describe, expect, it } from "vitest";
import { normalizeAgentTaskConfig } from "./agent-graph";

describe("normalizeAgentTaskConfig", () => {
	it("strips persona and system overrides from durable/run nodes", () => {
		const normalized = normalizeAgentTaskConfig({
			call: "durable/run",
			systemPrompt: "top-level system",
			with: {
				role: "node role",
				body: {
					prompt: "run it",
					agentRef: { id: "a1" },
					systemPrompt: "body system",
					overrides: {
						maxTurns: 5,
						tools: ["read_file"],
						role: "bad role",
						systemPrompt: "bad system",
					},
				},
			},
		});

		expect(normalized.systemPrompt).toBeUndefined();
		const withBlock = normalized.with as Record<string, unknown>;
		expect(withBlock.role).toBeUndefined();
		const body = withBlock.body as Record<string, unknown>;
		expect(body.systemPrompt).toBeUndefined();
		expect(body.overrides).toEqual({
			maxTurns: 5,
			tools: ["read_file"],
		});
	});
});
