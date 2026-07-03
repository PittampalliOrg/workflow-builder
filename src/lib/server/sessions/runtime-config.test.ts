import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail } from "$lib/types/sessions";

const getSessionMock = vi.fn();
const resolveSessionRuntimeTargetMock = vi.fn();
const daprFetchMock = vi.fn();
const resolveAgentRefMock = vi.fn();
const waitForAgentWorkflowHostAppReadyMock = vi.fn();

vi.mock("$env/dynamic/private", () => ({
	env: {},
}));

vi.mock("$lib/server/sessions/registry", () => ({
	getSession: (...args: unknown[]) => getSessionMock(...args),
}));

vi.mock("$lib/server/sessions/runtime-target", () => ({
	resolveSessionRuntimeTarget: (...args: unknown[]) =>
		resolveSessionRuntimeTargetMock(...args),
}));

vi.mock("$lib/server/dapr-client", () => ({
	daprFetch: (...args: unknown[]) => daprFetchMock(...args),
	getDaprSidecarUrl: () => "http://localhost:3500",
}));

vi.mock("$lib/server/agents/registry", () => ({
	resolveAgentRef: (...args: unknown[]) => resolveAgentRefMock(...args),
}));

vi.mock("$lib/server/sessions/agent-workflow-host", () => ({
	waitForAgentWorkflowHostAppReady: (...args: unknown[]) =>
		waitForAgentWorkflowHostAppReadyMock(...args),
}));

import { getSessionRuntimeConfig } from "./runtime-config";

describe("getSessionRuntimeConfig", () => {
	beforeEach(() => {
		getSessionMock.mockReset();
		resolveSessionRuntimeTargetMock.mockReset();
		daprFetchMock.mockReset();
		resolveAgentRefMock.mockReset();
		waitForAgentWorkflowHostAppReadyMock.mockReset();

		getSessionMock.mockResolvedValue(sampleSession());
		resolveSessionRuntimeTargetMock.mockResolvedValue(null);
		daprFetchMock.mockResolvedValue(new Response("", { status: 404 }));
		resolveAgentRefMock.mockResolvedValue(sampleAgent());
	});

	it("keeps direct database access outside the runtime-config helper", () => {
		const source = readFileSync(
			new URL("./runtime-config.ts", import.meta.url),
			"utf8",
		);

		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("prefers the live runtime endpoint", async () => {
		const liveEvent = runtimeEvent("live-hash");
		resolveSessionRuntimeTargetMock.mockResolvedValue({
			appId: "agent-runtime-coding-agent",
			invokeTarget: "agent-runtime-coding-agent",
			runtimeSandboxName: null,
			source: "persisted",
		});
		daprFetchMock.mockResolvedValueOnce(Response.json(liveEvent));

		const result = await getSessionRuntimeConfig("session-1");

		expect(result?.id).toBe(liveEvent.id);
		expect(result?.data.source).toBe("memory");
		expect(daprFetchMock).toHaveBeenCalledTimes(1);
		expect(String(daprFetchMock.mock.calls[0][0])).toContain(
			"/internal/runtime/instances/child-1/config",
		);
	});

	it("falls back from live runtime to Dapr state snapshot", async () => {
		const stateEvent = runtimeEvent("state-hash");
		resolveSessionRuntimeTargetMock.mockResolvedValue({
			appId: "agent-runtime-coding-agent",
			invokeTarget: "agent-runtime-coding-agent",
			runtimeSandboxName: null,
			source: "persisted",
		});
		daprFetchMock
			.mockResolvedValueOnce(new Response("", { status: 404 }))
			.mockResolvedValueOnce(Response.json(stateEvent));

		const result = await getSessionRuntimeConfig("session-1");

		expect(result?.id).toBe(stateEvent.id);
		expect(result?.data.source).toBe("state");
		expect(daprFetchMock).toHaveBeenCalledTimes(2);
		expect(String(daprFetchMock.mock.calls[1][0])).toContain(
			"/v1.0/state/dapr-agent-py-statestore/runtime-config%3Achild-1",
		);
	});

	it("falls back from Dapr state to the latest runtime-config event", async () => {
		const event = runtimeEvent("event-hash");
		const readLatestRuntimeConfigEvent = vi.fn(async () => event);

		const result = await getSessionRuntimeConfig("session-1", {}, {
			readLatestRuntimeConfigEvent,
		});

		expect(result?.id).toBe(event.id);
		expect(result?.data.source).toBe("event");
		expect(daprFetchMock).toHaveBeenCalledTimes(1);
		expect(readLatestRuntimeConfigEvent).toHaveBeenCalledWith("session-1");
	});

	it("does not expose runtime config outside the scoped project", async () => {
		const result = await getSessionRuntimeConfig("session-1", {
			projectId: "project-2",
		});

		expect(result).toBeNull();
		expect(resolveSessionRuntimeTargetMock).not.toHaveBeenCalled();
		expect(daprFetchMock).not.toHaveBeenCalled();
	});

	it("builds a redacted settings fallback", async () => {
		const result = await getSessionRuntimeConfig("session-1");
		const encoded = JSON.stringify(result);

		expect(result?.data.source).toBe("settings");
		expect(result?.data.attributes["gen_ai.request.model"]).toBe("openai/o3");
		expect(result?.data.attributes["agent.id"]).toBe("agent-1");
		expect(result?.data.mlflow.experimentId).toBe("exp-1");
		expect(result?.data.mlflow.runId).toBe("run-1");
		expect(result?.data.attributes["mlflow.run_id"]).toBe("run-1");
		expect(encoded).not.toContain("Bearer secret");
		expect(encoded).not.toContain("hidden system prompt");
		expect(encoded).not.toContain('"headers"');
		expect(encoded).not.toContain('"systemPrompt"');
	});
});

function runtimeEvent(configHash: string) {
	return {
		specversion: "1.0",
		id: `session:session-1:child-1:turn:1:runtime_config:${configHash}`,
		source: "urn:workflow-builder:agent-runtime:agent-runtime-coding-agent",
		type: "io.workflow-builder.session.runtime_config.v1",
		subject: "sessions/session-1/turns/1",
		datacontenttype: "application/json",
		dataschema: "urn:workflow-builder:schema:agent-runtime-config:v1",
		data: {
			schemaVersion: "workflow-builder.agent_runtime_config.v1",
			source: "memory",
			sessionId: "session-1",
			instanceId: "child-1",
			turn: 1,
			configRevision: 0,
			configHash,
			agent: { id: "agent-1" },
			llm: { providerModel: "o3" },
			execution: {},
			tools: {},
			mcp: {},
			skills: [],
			instructions: {},
			mlflow: {},
			dapr: { appId: "agent-runtime-coding-agent" },
			attributes: { "session.id": "session-1" },
		},
	};
}

function sampleAgent() {
	return {
		id: "agent-1",
		name: "Coding Agent",
		slug: "coding-agent",
		version: 1,
		config: {
			modelSpec: "openai/o3",
			systemPrompt: "hidden system prompt",
			mcpServers: [
				{
					serverName: "github",
					transport: "streamable_http",
					headers: { Authorization: "Bearer secret" },
					allowedTools: ["get_issue"],
				},
			],
			skills: ["repo-review"],
		},
		runtimeAppId: "agent-runtime-coding-agent",
		mlflowModelVersion: "model-1",
		mlflowModelName: "coding-agent",
		mlflowUri: "models:/coding-agent/1",
	};
}

function sampleSession(): SessionDetail {
	return {
		id: "session-1",
		title: "Session 1",
		status: "idle",
		stopReason: null,
		agentId: "agent-1",
		agentVersion: 1,
		projectId: "project-1",
		environmentId: null,
		environmentVersion: null,
		vaultIds: [],
		usage: {},
		errorMessage: null,
		workflowExecutionId: "workflow-exec-1",
		mlflowExperimentId: "exp-1",
		mlflowRunId: "run-1",
		mlflowParentRunId: null,
		mlflowSessionId: "session-1",
		workflowId: "workflow-1",
		workflowName: "Workflow",
		agentName: "Coding Agent",
		agentSlug: "coding-agent",
		agentAvatar: null,
		agentEphemeral: false,
		createdAt: "2026-05-15T12:00:00.000Z",
		updatedAt: "2026-05-15T12:00:00.000Z",
		completedAt: null,
		archivedAt: null,
		daprInstanceId: "child-1",
		natsSubject: "session.events.session-1",
		parentExecutionId: null,
		resumedFromSessionId: null,
		sandboxName: "dapr-agent-py",
		workspaceSandboxName: null,
		runtimeAppId: "agent-runtime-coding-agent",
		runtimeSandboxName: null,
		pausedAt: null,
	};
}
