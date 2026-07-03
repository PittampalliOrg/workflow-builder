import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workflowDataMock = {
	getWorkflowExecutionSessionOwnerContext: vi.fn(),
};
const getAgentBySlugMock = vi.fn();
const createSessionMock = vi.fn();
const sendUserEventMock = vi.fn();
const spawnSessionWorkflowMock = vi.fn();

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: workflowDataMock,
	}),
}));

vi.mock("$lib/server/agents/registry", () => ({
	getAgentBySlug: (...args: unknown[]) => getAgentBySlugMock(...args),
}));

vi.mock("$lib/server/sessions/registry", () => ({
	createSession: (...args: unknown[]) => createSessionMock(...args),
}));

vi.mock("$lib/server/sessions/events", () => ({
	sendUserEvent: (...args: unknown[]) => sendUserEventMock(...args),
}));

vi.mock("$lib/server/sessions/spawn", () => ({
	spawnSessionWorkflow: (...args: unknown[]) => spawnSessionWorkflowMock(...args),
}));

import { spawnDevSession } from "./dev-session-handoff";

describe("spawnDevSession", () => {
	beforeEach(() => {
		workflowDataMock.getWorkflowExecutionSessionOwnerContext.mockReset();
		getAgentBySlugMock.mockReset();
		createSessionMock.mockReset();
		sendUserEventMock.mockReset();
		spawnSessionWorkflowMock.mockReset();

		workflowDataMock.getWorkflowExecutionSessionOwnerContext.mockResolvedValue({
			userId: "user-1",
			workflowId: "workflow-1",
			projectId: "project-1",
		});
		getAgentBySlugMock.mockResolvedValue({
			id: "agent-1",
			slug: "cli-dev-agent",
		});
		createSessionMock.mockResolvedValue({ id: "session-1" });
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

		expect(
			workflowDataMock.getWorkflowExecutionSessionOwnerContext,
		).toHaveBeenCalledWith("exec-1");
		expect(createSessionMock).toHaveBeenCalledWith({
			agentId: "agent-1",
			userId: "user-1",
			projectId: "project-1",
			workflowExecutionId: "exec-1",
			title: "Dev handoff",
		});
		expect(sendUserEventMock).toHaveBeenCalledWith("session-1", {
			type: "user.message",
			content: [{ type: "text", text: "open the repo and run ./sync.sh" }],
		});
		expect(spawnSessionWorkflowMock).toHaveBeenCalledWith("session-1");
	});

	it("rejects executions that workflow-data cannot resolve", async () => {
		workflowDataMock.getWorkflowExecutionSessionOwnerContext.mockResolvedValueOnce(
			null,
		);

		await expect(
			spawnDevSession({
				executionId: "missing-exec",
				instructions: "start",
			}),
		).rejects.toThrow("missing-exec");
		expect(createSessionMock).not.toHaveBeenCalled();
	});
});
