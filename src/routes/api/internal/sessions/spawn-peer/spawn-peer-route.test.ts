import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const peerSession = {
		id: "ca-session-1",
		agentId: "agent-peer",
		agentVersion: 3,
		environmentId: "env-1",
		environmentVersion: 4,
		vaultIds: ["vault-1"],
		daprInstanceId: null as string | null,
		natsSubject: null as string | null,
	};
	const dispatchContext = {
		agentConfig: { systemPrompt: "Peer" },
		environmentConfig: { image: "env-image" },
		callableAgents: [
			{
				slug: "reviewer",
				agentId: "agent-reviewer",
				version: 2,
				appId: "dapr-agent-py",
				team: "project-1",
				registryKey: "project-1/reviewer",
			},
		],
		registryTeam: "project-1",
	};
	const workflowData = {
		ensurePeerSession: vi.fn(async (): Promise<unknown> => ({
			ok: true,
			session: peerSession,
			reused: false,
		})),
		resolvePeerAgentDispatchContext: vi.fn(async () => dispatchContext),
	};
	const validateInternalToken = vi.fn(() => true);
	const spawnSessionWorkflow = vi.fn(async () => ({
		instanceId: "ca-session-1",
		natsSubject: "session.events.ca-session-1",
	}));
	return {
		dispatchContext,
		peerSession,
		spawnSessionWorkflow,
		validateInternalToken,
		workflowData,
	};
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/internal-auth", () => ({
	validateInternalToken: mocks.validateInternalToken,
}));

vi.mock("$lib/server/sessions/spawn", () => ({
	spawnSessionWorkflow: mocks.spawnSessionWorkflow,
}));

import { POST } from "./+server";

function event(body: unknown) {
	return {
		request: new Request("http://localhost/api/internal/sessions/spawn-peer", {
			method: "POST",
			body: typeof body === "string" ? body : JSON.stringify(body),
			headers: { "Content-Type": "application/json" },
		}),
	};
}

function body(overrides: Record<string, unknown> = {}) {
	return {
		sessionId: "ca-session-1",
		peerAgentId: "agent-peer",
		prompt: "Review this change",
		parentSessionId: "parent-session-1",
		parentInstanceId: "parent-instance-1",
		...overrides,
	};
}

async function expectHttpStatus(promise: Promise<unknown>, status: number) {
	try {
		const result = await promise;
		expect((result as { status?: number }).status).toBe(status);
	} catch (err) {
		expect((err as { status?: number }).status).toBe(status);
	}
}

describe("internal spawn-peer route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.validateInternalToken.mockReturnValue(true);
		mocks.workflowData.ensurePeerSession.mockResolvedValue({
			ok: true,
			session: mocks.peerSession,
			reused: false,
		});
		mocks.workflowData.resolvePeerAgentDispatchContext.mockResolvedValue(
			mocks.dispatchContext,
		);
		mocks.spawnSessionWorkflow.mockResolvedValue({
			instanceId: "ca-session-1",
			natsSubject: "session.events.ca-session-1",
		});
	});

	it("keeps peer session persistence behind workflow-data services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.ensurePeerSession");
		expect(source).toContain("workflowData.resolvePeerAgentDispatchContext");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("createSession");
		expect(source).not.toContain("sendUserEvent");
		expect(source).not.toContain("resolveAgentRef");
		expect(source).not.toContain("resolveEnvironmentRef");
		expect(source).not.toContain("resolveCallableAgents");
	});

	it("requires an internal token", async () => {
		mocks.validateInternalToken.mockReturnValueOnce(false);

		await expectHttpStatus(Promise.resolve(POST(event(body()) as never)), 401);
		expect(mocks.workflowData.ensurePeerSession).not.toHaveBeenCalled();
	});

	it("validates required fields before ensuring the session", async () => {
		await expectHttpStatus(Promise.resolve(POST(event({}) as never)), 400);
		await expectHttpStatus(
			Promise.resolve(POST(event(body({ sessionId: "x".repeat(65) })) as never)),
			400,
		);
		expect(mocks.workflowData.ensurePeerSession).not.toHaveBeenCalled();
	});

	it("creates and spawns a fresh peer session", async () => {
		const response = (await POST(event(body({ title: "Peer review" })) as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			sessionId: "ca-session-1",
			agentId: "agent-peer",
			agentVersion: 3,
			daprInstanceId: "ca-session-1",
			natsSubject: "session.events.ca-session-1",
			reused: false,
		});
		expect(mocks.workflowData.ensurePeerSession).toHaveBeenCalledWith({
			sessionId: "ca-session-1",
			peerAgentId: "agent-peer",
			prompt: "Review this change",
			parentSessionId: "parent-session-1",
			parentInstanceId: "parent-instance-1",
			title: "Peer review",
		});
		expect(mocks.spawnSessionWorkflow).toHaveBeenCalledWith("ca-session-1");
	});

	it("returns reused sessions without spawning unless skipSpawn is requested", async () => {
		mocks.workflowData.ensurePeerSession.mockResolvedValueOnce({
			ok: true,
			session: {
				...mocks.peerSession,
				daprInstanceId: "ca-session-1",
				natsSubject: "session.events.ca-session-1",
			},
			reused: true,
		});

		const response = (await POST(event(body()) as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			sessionId: "ca-session-1",
			agentId: "agent-peer",
			agentVersion: 3,
			daprInstanceId: "ca-session-1",
			natsSubject: "session.events.ca-session-1",
			reused: true,
		});
		expect(mocks.spawnSessionWorkflow).not.toHaveBeenCalled();
		expect(mocks.workflowData.resolvePeerAgentDispatchContext).not.toHaveBeenCalled();
	});

	it("returns dispatch context for skipSpawn callers", async () => {
		const response = (await POST(event(body({ skipSpawn: true })) as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			sessionId: "ca-session-1",
			agentId: "agent-peer",
			agentVersion: 3,
			daprInstanceId: null,
			natsSubject: null,
			reused: false,
			agentConfig: { systemPrompt: "Peer" },
			environmentConfig: { image: "env-image" },
			vaultIds: ["vault-1"],
			callableAgents: mocks.dispatchContext.callableAgents,
			registryTeam: "project-1",
			skipSpawn: true,
		});
		expect(mocks.workflowData.resolvePeerAgentDispatchContext).toHaveBeenCalledWith({
			agentId: "agent-peer",
			agentVersion: 3,
			environmentId: "env-1",
			environmentVersion: 4,
		});
		expect(mocks.spawnSessionWorkflow).not.toHaveBeenCalled();
	});

	it("maps workflow-data errors to route errors", async () => {
		mocks.workflowData.ensurePeerSession.mockResolvedValueOnce({
			ok: false,
			status: 404,
			message: "Peer agent missing",
		});

		await expectHttpStatus(Promise.resolve(POST(event(body()) as never)), 404);
		expect(mocks.spawnSessionWorkflow).not.toHaveBeenCalled();
	});
});
