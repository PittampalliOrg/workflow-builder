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
			agentSlug: "kimi-k3-juicefs-builder-agent",
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
			status: "created",
			sessionId: "session-1",
			url: "/sessions/session-1",
			agentSlug: "kimi-k3-juicefs-builder-agent",
		});

		expect(workflowDataMock.createWorkflowDevSession).toHaveBeenCalledWith({
			executionId: "exec-1",
				agentPolicy: {
					slug: "kimi-k3-juicefs-builder-agent",
					runtime: "dapr-agent-py-juicefs",
					modelSpec: "kimi/kimi-k3",
					reasoningEffort: "max",
					contextWindowTokens: 1_048_576,
					runtimeIsolation: "dedicated",
				},
				replayAgentPolicies: [
					{
						slug: "glm-juicefs-builder-agent",
						runtime: "dapr-agent-py-juicefs",
						modelSpec: "kimi/kimi-k3",
					},
				],
			instructions: "open the repo and run ./sync.sh",
			title: "Dev handoff",
		});
		expect(spawnSessionWorkflowMock).toHaveBeenCalledWith("session-1", {
			persistentHost: true,
			requireWorkflowHost: true,
		});
	});

	it("reuses and idempotently starts the same durable dev session on replay", async () => {
		workflowDataMock.createWorkflowDevSession.mockResolvedValueOnce({
			status: "reused",
			sessionId: "session-1",
			agentSlug: "kimi-k3-juicefs-builder-agent",
		});

		await expect(
			spawnDevSession({
				executionId: "exec-1",
				instructions: "open the repo and run ./sync.sh",
			}),
		).resolves.toMatchObject({ status: "reused", sessionId: "session-1" });
		expect(spawnSessionWorkflowMock).toHaveBeenCalledTimes(1);
		expect(spawnSessionWorkflowMock).toHaveBeenCalledWith("session-1", {
			persistentHost: true,
			requireWorkflowHost: true,
		});
	});

	it("can opt into the bounded workflow-host behavior", async () => {
		await spawnDevSession({
			executionId: "exec-1",
			instructions: "open the repo and run ./sync.sh",
			persistent: false,
		});

		expect(spawnSessionWorkflowMock).toHaveBeenCalledWith("session-1", {
			persistentHost: false,
			requireWorkflowHost: true,
		});
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
			}),
		).rejects.toThrow('dev-session agent "kimi-k3-juicefs-builder-agent" not found');
		expect(spawnSessionWorkflowMock).not.toHaveBeenCalled();
	});

	it("rejects a seeded agent that drifts from the preview runtime policy", async () => {
		workflowDataMock.createWorkflowDevSession.mockResolvedValueOnce({
			status: "agent_policy_mismatch",
			agentSlug: "kimi-k3-juicefs-builder-agent",
		});

		await expect(
			spawnDevSession({
				executionId: "exec-1",
				instructions: "start",
			}),
		).rejects.toThrow("does not match the required preview runtime policy");
		expect(spawnSessionWorkflowMock).not.toHaveBeenCalled();
	});

	it("rejects conflicting durable replay provenance before workflow startup", async () => {
		workflowDataMock.createWorkflowDevSession.mockResolvedValueOnce({
			status: "session_conflict",
			reason: "instructions_mismatch",
		});

		await expect(
			spawnDevSession({
				executionId: "exec-1",
				instructions: "different task",
			}),
		).rejects.toThrow("durable instructions_mismatch contract");
		expect(spawnSessionWorkflowMock).not.toHaveBeenCalled();
	});
});
