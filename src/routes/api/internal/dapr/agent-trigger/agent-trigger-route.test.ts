import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceProjectMembershipDetail } from "$lib/server/application/ports";

const mocks = vi.hoisted(() => {
	const agent = {
		id: "agent-1",
		slug: "writer",
		name: "Writer",
		version: 3,
		projectId: "project-1",
	};
	const session = { id: "evt-session-1" };
	type Agent = typeof agent;
	type Session = typeof session;
	const workflowData = {
		getWorkspaceProjectMembershipDetail: vi.fn(
			async (): Promise<WorkspaceProjectMembershipDetail | null> => ({
			id: "project-1",
			displayName: "Project",
			externalId: "workspace-1",
			selfRole: "OPERATOR",
			}),
		),
	};
	const getAgentBySlug = vi.fn(async (): Promise<Agent | null> => agent);
	const resolveAgentRef = vi.fn(async (): Promise<Agent | null> => agent);
	const getSession = vi.fn(async (): Promise<Session | null> => null);
	const createSession = vi.fn(async () => session);
	const sendUserEvent = vi.fn(async () => undefined);
	const spawnSessionWorkflow = vi.fn(async () => undefined);
	return {
		agent,
		createSession,
		getAgentBySlug,
		getSession,
		resolveAgentRef,
		sendUserEvent,
		session,
		spawnSessionWorkflow,
		workflowData,
	};
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/agents/registry", () => ({
	getAgentBySlug: mocks.getAgentBySlug,
	resolveAgentRef: mocks.resolveAgentRef,
}));

vi.mock("$lib/server/sessions/registry", () => ({
	createSession: mocks.createSession,
	getSession: mocks.getSession,
}));

vi.mock("$lib/server/sessions/events", () => ({
	sendUserEvent: mocks.sendUserEvent,
}));

vi.mock("$lib/server/sessions/spawn", () => ({
	spawnSessionWorkflow: mocks.spawnSessionWorkflow,
}));

import { POST } from "./+server";

function event(data: Record<string, unknown> | string) {
	return {
		request: new Request("http://localhost/api/internal/dapr/agent-trigger", {
			method: "POST",
			body: typeof data === "string" ? data : JSON.stringify({ id: "ce-1", data }),
			headers: { "Content-Type": "application/json" },
		}),
	};
}

async function expectSuccess(response: Response) {
	expect(response.status).toBe(200);
	await expect(response.json()).resolves.toEqual({ status: "SUCCESS" });
}

function validPayload(overrides: Record<string, unknown> = {}) {
	return {
		agentSlug: "writer",
		projectId: "project-1",
		userId: "user-1",
		objective: "Draft the update",
		dedupKey: "source:event:1",
		...overrides,
	};
}

describe("internal Dapr agent-trigger route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getWorkspaceProjectMembershipDetail.mockResolvedValue({
			id: "project-1",
			displayName: "Project",
			externalId: "workspace-1",
			selfRole: "OPERATOR",
		});
		mocks.getAgentBySlug.mockResolvedValue(mocks.agent);
		mocks.resolveAgentRef.mockResolvedValue(mocks.agent);
		mocks.getSession.mockResolvedValue(null);
		mocks.createSession.mockResolvedValue(mocks.session);
	});

	it("keeps project membership checks behind workflow-data services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.getWorkspaceProjectMembershipDetail");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("projectMembers");
	});

	it("acks malformed JSON and missing fields without side effects", async () => {
		await expectSuccess((await POST(event("{") as never)) as Response);
		await expectSuccess((await POST(event({ projectId: "project-1" }) as never)) as Response);

		expect(mocks.resolveAgentRef).not.toHaveBeenCalled();
		expect(mocks.workflowData.getWorkspaceProjectMembershipDetail).not.toHaveBeenCalled();
		expect(mocks.createSession).not.toHaveBeenCalled();
		expect(mocks.spawnSessionWorkflow).not.toHaveBeenCalled();
	});

	it("drops missing agents without checking membership", async () => {
		mocks.getAgentBySlug.mockResolvedValueOnce(null);

		await expectSuccess((await POST(event(validPayload()) as never)) as Response);

		expect(mocks.workflowData.getWorkspaceProjectMembershipDetail).not.toHaveBeenCalled();
		expect(mocks.createSession).not.toHaveBeenCalled();
		expect(mocks.spawnSessionWorkflow).not.toHaveBeenCalled();
	});

	it("drops agents outside the requested project", async () => {
		mocks.resolveAgentRef.mockResolvedValueOnce({
			...mocks.agent,
			projectId: "other-project",
		});

		await expectSuccess((await POST(event(validPayload()) as never)) as Response);

		expect(mocks.workflowData.getWorkspaceProjectMembershipDetail).not.toHaveBeenCalled();
		expect(mocks.createSession).not.toHaveBeenCalled();
	});

	it("drops users that are not project members", async () => {
		mocks.workflowData.getWorkspaceProjectMembershipDetail.mockResolvedValueOnce(null);

		await expectSuccess((await POST(event(validPayload()) as never)) as Response);

		expect(mocks.workflowData.getWorkspaceProjectMembershipDetail).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
		});
		expect(mocks.createSession).not.toHaveBeenCalled();
		expect(mocks.spawnSessionWorkflow).not.toHaveBeenCalled();
	});

	it("short-circuits duplicate deterministic sessions", async () => {
		mocks.getSession.mockResolvedValueOnce({ id: "existing-session" });

		await expectSuccess((await POST(event(validPayload()) as never)) as Response);

		expect(mocks.createSession).not.toHaveBeenCalled();
		expect(mocks.sendUserEvent).not.toHaveBeenCalled();
		expect(mocks.spawnSessionWorkflow).not.toHaveBeenCalled();
	});

	it("creates a deterministic session, appends the objective, and spawns the workflow", async () => {
		await expectSuccess((await POST(event(validPayload()) as never)) as Response);

		expect(mocks.createSession).toHaveBeenCalledWith(
			expect.objectContaining({
				id: expect.stringMatching(/^evt-[a-f0-9]{40}$/),
				agentId: "agent-1",
				agentVersion: 3,
				title: "Triggered · Writer",
				userId: "user-1",
				projectId: "project-1",
			}),
		);
		expect(mocks.sendUserEvent).toHaveBeenCalledWith("evt-session-1", {
			type: "user.message",
			content: [{ type: "text", text: "Draft the update" }],
		});
		expect(mocks.spawnSessionWorkflow).toHaveBeenCalledWith("evt-session-1");
	});
});
