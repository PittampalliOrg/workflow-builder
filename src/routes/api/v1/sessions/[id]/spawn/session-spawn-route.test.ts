import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const startSessionWorkflowMock = vi.fn();

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		sessionCommands: {
			startSessionWorkflow: (...args: unknown[]) =>
				startSessionWorkflowMock(...args),
		},
	}),
}));

import { POST } from "./+server";

describe("session spawn route", () => {
	beforeEach(() => {
		startSessionWorkflowMock.mockReset();
		startSessionWorkflowMock.mockResolvedValue({
			status: "started",
			instanceId: "session-1",
			natsSubject: "session.events.session-1",
			alreadyStarted: false,
		});
	});

	it("delegates session spawn through the application command service", async () => {
		const response = (await POST(
			sessionEvent("http://localhost/api/v1/sessions/session-1/spawn"),
		)) as Response;
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({
			instanceId: "session-1",
			natsSubject: "session.events.session-1",
			alreadyStarted: false,
		});
		expect(startSessionWorkflowMock).toHaveBeenCalledWith({
			sessionId: "session-1",
			userId: "user-1",
			projectId: "project-1",
		});
	});

	it("maps CLI token precondition failures to HTTP 412", async () => {
		startSessionWorkflowMock.mockResolvedValue({
			status: "precondition_failed",
			code: "CLI_TOKEN_MISSING",
			provider: "agy",
			settingsPath: "/settings/cli-tokens",
			message: "AGY login required",
		});

		const response = (await POST(
			sessionEvent("http://localhost/api/v1/sessions/session-1/spawn"),
		)) as Response;
		const body = await response.json();

		expect(response.status).toBe(412);
		expect(body).toEqual({
			code: "CLI_TOKEN_MISSING",
			provider: "agy",
			settingsPath: "/settings/cli-tokens",
			message: "AGY login required",
		});
	});

	it("keeps direct session registry and spawner helpers out of the route", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("sessionCommands.startSessionWorkflow");
		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toContain("$lib/server/sessions/spawn");
		expect(source).not.toContain("$lib/server/users/cli-credentials");
		expect(source).not.toContain("updateSessionStatusUnlessTerminated");
		expect(source).not.toContain("getSession(");
		expect(source).not.toContain("spawnSessionWorkflow");
	});
});

function sessionEvent(url: string): never {
	return {
		params: { id: "session-1" },
		request: new Request(url, { method: "POST" }),
		locals: {
			session: {
				userId: "user-1",
				projectId: "project-1",
			},
		},
	} as never;
}
