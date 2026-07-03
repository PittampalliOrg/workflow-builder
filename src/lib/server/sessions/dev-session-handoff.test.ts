import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workflowDataMock = {
	createWorkflowDevSession: vi.fn(),
};
const spawnSessionWorkflowMock = vi.fn();

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: workflowDataMock,
	}),
}));

vi.mock("$lib/server/sessions/spawn", () => ({
	spawnSessionWorkflow: (...args: unknown[]) => spawnSessionWorkflowMock(...args),
}));

import { spawnDevSession } from "./dev-session-handoff";

describe("spawnDevSession", () => {
	beforeEach(() => {
		workflowDataMock.createWorkflowDevSession.mockReset();
		spawnSessionWorkflowMock.mockReset();

		workflowDataMock.createWorkflowDevSession.mockResolvedValue({
			status: "created",
			sessionId: "session-1",
			agentSlug: "cli-dev-agent",
		});
		spawnSessionWorkflowMock.mockResolvedValue({
			instanceId: "session-1",
			natsSubject: "session.events.session-1",
		});
	});

	it("keeps direct database access outside the handoff helper", () => {
		const source = readFileSync(
			new URL("./dev-session-handoff.ts", import.meta.url),
			"utf8",
		);

		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/agents/registry");
		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toContain("$lib/server/sessions/events");
		expect(source).toContain("workflowData.createWorkflowDevSession");
	});

	it("creates and starts a dev session from workflow-data execution ownership", async () => {
		await expect(
			spawnDevSession({
				executionId: "exec-1",
				instructions: "open the repo and run ./sync.sh",
				title: "Dev handoff",
			}),
		).resolves.toEqual({
			sessionId: "session-1",
			url: "/sessions/session-1",
			agentSlug: "cli-dev-agent",
		});

		expect(workflowDataMock.createWorkflowDevSession).toHaveBeenCalledWith({
			executionId: "exec-1",
			agentSlug: "cli-dev-agent",
			instructions: "open the repo and run ./sync.sh",
			title: "Dev handoff",
		});
		expect(spawnSessionWorkflowMock).toHaveBeenCalledWith("session-1");
	});

	it("rejects executions that workflow-data cannot resolve", async () => {
		workflowDataMock.createWorkflowDevSession.mockResolvedValueOnce({
			status: "execution_not_found",
		});

		await expect(
			spawnDevSession({
				executionId: "missing-exec",
				instructions: "start",
			}),
		).rejects.toThrow("missing-exec");
		expect(spawnSessionWorkflowMock).not.toHaveBeenCalled();
	});

	it("rejects missing dev-session agents", async () => {
		workflowDataMock.createWorkflowDevSession.mockResolvedValueOnce({
			status: "agent_not_found",
			agentSlug: "missing-agent",
		});

		await expect(
			spawnDevSession({
				executionId: "exec-1",
				instructions: "start",
				agentSlug: "missing-agent",
			}),
		).rejects.toThrow('dev-session agent "missing-agent" not found');
		expect(spawnSessionWorkflowMock).not.toHaveBeenCalled();
	});
});
