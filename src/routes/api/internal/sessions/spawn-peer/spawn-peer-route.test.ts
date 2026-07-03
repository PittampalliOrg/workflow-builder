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
	return {
		peerSessionSpawn,
		validateInternalToken,
	};
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ peerSessionSpawn: mocks.peerSessionSpawn }),
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
		);
	});

	it("maps application errors and accepted spawn failures to HTTP responses", async () => {
		mocks.peerSessionSpawn.spawnPeerSession.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Peer agent missing",
		});
		await expectHttpStatus(Promise.resolve(POST(event(body()) as never)), 404);

		mocks.peerSessionSpawn.spawnPeerSession.mockResolvedValueOnce({
			status: "ok",
			httpStatus: 202,
			body: {
				sessionId: "ca-session-1",
				agentId: "agent-peer",
				agentVersion: 3,
				daprInstanceId: null,
				natsSubject: null,
				reused: false,
				error: "Dapr unavailable",
			},
		});
		const response = (await POST(event(body()) as never)) as Response;
		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toMatchObject({
			sessionId: "ca-session-1",
			error: "Dapr unavailable",
		});
	});
});
