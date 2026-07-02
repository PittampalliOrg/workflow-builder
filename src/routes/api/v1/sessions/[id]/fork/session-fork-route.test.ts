import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	type ForkResult =
		| {
				status: "created";
				sessionId: string;
				sourceSessionId: string;
				replayed: number;
		  }
		| { status: "not_found" }
		| { status: "bad_request"; message: string };
	const workflowData = {
		forkSessionFromEvent: vi.fn<() => Promise<ForkResult>>(async () => ({
			status: "created",
			sessionId: "fork-session-1",
			sourceSessionId: "session-1",
			replayed: 2,
		})),
	};
	return { workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import { POST } from "./+server";

function event(body: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
	return {
		params: { id: "session-1" },
		request: new Request("http://test.local/api/v1/sessions/session-1/fork", {
			method: "POST",
			body: JSON.stringify(body),
		}),
		locals: { session: { userId: "user-1", projectId: "project-1" } },
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

describe("session fork route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.forkSessionFromEvent.mockResolvedValue({
			status: "created",
			sessionId: "fork-session-1",
			sourceSessionId: "session-1",
			replayed: 2,
		});
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.forkSessionFromEvent");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/sessions/");
		expect(source).not.toContain("resolveAgentRef");
		expect(source).not.toContain("findOrCreateExperimentAgent");
	});

	it("delegates fork creation to workflowData", async () => {
		const response = (await POST(
			event({
				fromSequence: 2,
				title: "Fork point",
				agentConfig: { runtime: "codex" },
			}) as never,
		)) as Response;

		expect(response.status).toBe(201);
		await expect(response.json()).resolves.toEqual({
			sessionId: "fork-session-1",
			sourceSessionId: "session-1",
			replayed: 2,
		});
		expect(mocks.workflowData.forkSessionFromEvent).toHaveBeenCalledWith({
			sourceSessionId: "session-1",
			fromSequence: 2,
			title: "Fork point",
			agentConfig: { runtime: "codex" },
			userId: "user-1",
			projectId: "project-1",
		});
	});

	it("maps workflowData not-found and bad-request results", async () => {
		mocks.workflowData.forkSessionFromEvent.mockResolvedValueOnce({
			status: "not_found",
		});
		await expectHttpStatus(
			Promise.resolve(POST(event({ fromSequence: 1 }) as never)),
			404,
		);

		mocks.workflowData.forkSessionFromEvent.mockResolvedValueOnce({
			status: "bad_request",
			message: "Experiment agent create failed",
		});
		await expectHttpStatus(
			Promise.resolve(POST(event({ fromSequence: 1 }) as never)),
			400,
		);
	});

	it("validates auth and fromSequence before calling workflowData", async () => {
		await expectHttpStatus(
			Promise.resolve(
				POST(event({ fromSequence: 1 }, { locals: { session: null } }) as never),
			),
			401,
		);
		await expectHttpStatus(
			Promise.resolve(POST(event({ fromSequence: 0 }) as never)),
			400,
		);
		expect(mocks.workflowData.forkSessionFromEvent).not.toHaveBeenCalled();
	});
});
