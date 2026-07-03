import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail } from "$lib/types/sessions";

const listSessionsMock = vi.fn();
const createInteractiveSessionMock = vi.fn();

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		sessionCommands: {
			listSessions: (...args: unknown[]) => listSessionsMock(...args),
			createInteractiveSession: (...args: unknown[]) =>
				createInteractiveSessionMock(...args),
		},
	}),
}));

import { GET, POST } from "./+server";

describe("/api/v1/sessions route", () => {
	beforeEach(() => {
		listSessionsMock.mockReset();
		createInteractiveSessionMock.mockReset();
		listSessionsMock.mockResolvedValue([]);
		createInteractiveSessionMock.mockResolvedValue({
			status: "created",
			session: sampleSession(),
		});
	});

	it("keeps the root route as a presentation adapter", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toContain("$lib/server/sessions/spawn");
		expect(source).not.toContain("$lib/server/sessions/events");
		expect(source).not.toContain("$lib/server/sessions/repositories");
	});

	it("delegates listing to the session command service with scoped filters", async () => {
		const response = (await GET(
			sessionEvent("http://localhost/api/v1/sessions?status=running&limit=5"),
		)) as Response;
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.sessions).toEqual([]);
		expect(listSessionsMock).toHaveBeenCalledWith({
			userId: "user-1",
			projectId: "project-1",
			agentId: undefined,
			status: "running",
			source: undefined,
			workflowId: undefined,
			executionId: undefined,
			q: undefined,
			includeArchived: false,
			limit: 5,
		});
	});

	it("maps a created interactive session to HTTP 201", async () => {
		const response = (await POST(
			sessionEvent("http://localhost/api/v1/sessions", {
				agentId: "agent-1",
				provisioning: "eager",
			}),
		)) as Response;
		const body = await response.json();

		expect(response.status).toBe(201);
		expect(body.session.id).toBe("session-1");
		expect(createInteractiveSessionMock).toHaveBeenCalledWith({
			userId: "user-1",
			projectId: "project-1",
			body: { agentId: "agent-1", provisioning: "eager" },
		});
	});

	it("preserves CLI token precondition failures as HTTP 412", async () => {
		createInteractiveSessionMock.mockResolvedValue({
			status: "precondition_failed",
			code: "missing_cli_token",
			provider: "agy",
			settingsPath: "/settings/cli-tokens",
			message: "AGY token is required",
			session: sampleSession(),
		});

		const response = (await POST(
			sessionEvent("http://localhost/api/v1/sessions", { agentId: "agent-1" }),
		)) as Response;
		const body = await response.json();

		expect(response.status).toBe(412);
		expect(body).toMatchObject({
			code: "missing_cli_token",
			provider: "agy",
			settingsPath: "/settings/cli-tokens",
			message: "AGY token is required",
			session: { id: "session-1" },
		});
	});
});

function sessionEvent(url: string, body?: Record<string, unknown>): never {
	return {
		url: new URL(url),
		request: new Request(url, {
			method: body ? "POST" : "GET",
			headers: { "content-type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		}),
		locals: {
			session: {
				userId: "user-1",
				projectId: "project-1",
			},
		},
	} as never;
}

function sampleSession(): SessionDetail {
	return {
		id: "session-1",
		title: "Session 1",
		status: "rescheduling",
		stopReason: null,
		agentId: "agent-1",
		agentVersion: 1,
		projectId: "project-1",
		environmentId: null,
		environmentVersion: null,
		vaultIds: [],
		usage: {},
		errorMessage: null,
		workflowExecutionId: null,
		mlflowExperimentId: null,
		mlflowRunId: null,
		mlflowParentRunId: null,
		mlflowSessionId: "session-1",
		workflowId: null,
		workflowName: null,
		agentName: "Coding Agent",
		agentSlug: "coding-agent",
		agentAvatar: null,
		agentEphemeral: false,
		createdAt: "2026-05-15T12:00:00.000Z",
		updatedAt: "2026-05-15T12:00:00.000Z",
		completedAt: null,
		archivedAt: null,
		daprInstanceId: null,
		natsSubject: null,
		parentExecutionId: null,
		resumedFromSessionId: null,
		sandboxName: "dapr-agent-py",
		workspaceSandboxName: null,
		runtimeAppId: null,
		runtimeSandboxName: null,
		pausedAt: null,
	};
}
