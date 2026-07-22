import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerSessionSpawnResult } from "$lib/server/application/peer-session-spawn";

const mocks = vi.hoisted(() => {
	const peerSessionSpawn = {
		spawnPeerSession: vi.fn(
			async (): Promise<PeerSessionSpawnResult> => ({
			status: "ok" as const,
			body: {
				sessionId: "ca-session-1",
				agentId: "agent-peer",
				agentVersion: 3,
				daprInstanceId: "ca-session-1",
				natsSubject: "session.events.ca-session-1",
				reused: false,
			},
			}),
		),
	};
	const validateInternalToken = vi.fn(() => true);
  const principal = {
    userId: "user-1",
    projectId: "project-1",
    sessionId: "parent-session-1",
    scopes: ["workflow:execute"],
    capabilities: { scriptDepth: 0, teamId: null, teamRole: "none" as const },
  };
  const internalWorkflowPrincipal = {
    authorize: vi.fn(async () => ({ ok: true as const, principal })),
  };
	return {
		peerSessionSpawn,
		validateInternalToken,
    principal,
    internalWorkflowPrincipal,
	};
});

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    peerSessionSpawn: mocks.peerSessionSpawn,
    internalWorkflowPrincipal: mocks.internalWorkflowPrincipal,
  }),
}));

vi.mock("$lib/server/internal-auth", () => ({
	validateInternalToken: mocks.validateInternalToken,
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
    mocks.internalWorkflowPrincipal.authorize.mockResolvedValue({
      ok: true,
      principal: mocks.principal,
    });
		mocks.peerSessionSpawn.spawnPeerSession.mockResolvedValue({
			status: "ok",
			body: {
				sessionId: "ca-session-1",
				agentId: "agent-peer",
				agentVersion: 3,
				daprInstanceId: "ca-session-1",
				natsSubject: "session.events.ca-session-1",
				reused: false,
			},
		});
	});

	it("keeps peer session spawn behavior behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("peerSessionSpawn.spawnPeerSession");
		expect(source).not.toContain("workflowData");
		expect(source).not.toContain("spawnSessionWorkflow");
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
		expect(mocks.peerSessionSpawn.spawnPeerSession).not.toHaveBeenCalled();
	});

	it("delegates peer-spawn requests to the application service", async () => {
		const payload = body({ title: "Peer review" });
		const response = (await POST(event(payload) as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			sessionId: "ca-session-1",
			agentId: "agent-peer",
			agentVersion: 3,
			daprInstanceId: "ca-session-1",
			natsSubject: "session.events.ca-session-1",
			reused: false,
		});
		expect(mocks.peerSessionSpawn.spawnPeerSession).toHaveBeenCalledWith(
			payload,
      {
        userId: "user-1",
        projectId: "project-1",
        sessionId: "parent-session-1",
        capabilities: {
          scriptDepth: 0,
          teamId: null,
          teamRole: "none",
        },
      },
      { kind: "call_agent" },
		);
	});

  it("maps application and retriable dispatch errors to HTTP responses", async () => {
		mocks.peerSessionSpawn.spawnPeerSession.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Peer agent missing",
		});
		await expectHttpStatus(Promise.resolve(POST(event(body()) as never)), 404);

		mocks.peerSessionSpawn.spawnPeerSession.mockResolvedValueOnce({
      status: "error",
      httpStatus: 502,
      message: "Dapr unavailable",
    });
    await expectHttpStatus(Promise.resolve(POST(event(body()) as never)), 502);
  });

  it("forwards structured provisioning contention as HTTP 202", async () => {
    mocks.peerSessionSpawn.spawnPeerSession.mockResolvedValueOnce({
      status: "pending",
			httpStatus: 202,
      code: "runtime_provisioning",
      message: "runtime provisioning is already in progress",
			body: {
				sessionId: "ca-session-1",
        reused: true,
        pending: true,
			},
		});

		const response = (await POST(event(body()) as never)) as Response;
		expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
			sessionId: "ca-session-1",
      reused: true,
      pending: true,
		});
	});
});
