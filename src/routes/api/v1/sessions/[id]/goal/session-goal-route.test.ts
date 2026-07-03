import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionGoalMock = vi.fn();
const setSessionGoalMock = vi.fn();
const updateSessionGoalStatusMock = vi.fn();

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		sessionGoals: {
			getSessionGoal: (...args: unknown[]) => getSessionGoalMock(...args),
			setSessionGoal: (...args: unknown[]) => setSessionGoalMock(...args),
			updateSessionGoalStatus: (...args: unknown[]) =>
				updateSessionGoalStatusMock(...args),
		},
	}),
}));

import { GET, PATCH, POST } from "./+server";

describe("session goal route", () => {
	beforeEach(() => {
		getSessionGoalMock.mockReset();
		setSessionGoalMock.mockReset();
		updateSessionGoalStatusMock.mockReset();
		getSessionGoalMock.mockResolvedValue({
			status: "ok",
			goal: sampleGoal(),
			nativeGoalAvailable: true,
		});
		setSessionGoalMock.mockResolvedValue({ status: "goal", goal: sampleGoal() });
		updateSessionGoalStatusMock.mockResolvedValue({
			status: "goal",
			goal: sampleGoal({ status: "complete" }),
		});
	});

	it("keeps goal business rules behind session goal application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("sessionGoals.getSessionGoal");
		expect(source).toContain("sessionGoals.setSessionGoal");
		expect(source).toContain("sessionGoals.updateSessionGoalStatus");
		expect(source).not.toContain("$lib/server/lifecycle");
		expect(source).not.toContain("$lib/server/workflows/project-scope");
		expect(source).not.toContain("$lib/server/sessions/runtime-target");
		expect(source).not.toContain("$lib/server/goals/repo");
		expect(source).not.toContain("$lib/server/goals/goal-loop");
		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toContain("$lib/server/sessions/events");
		expect(source).not.toContain("$lib/server/sessions/spawn");
		expect(source).not.toContain("appendEvent");
		expect(source).not.toContain("getSession(");
	});

	it("delegates GET to the session goal service", async () => {
		const response = (await GET(
			sessionEvent("http://localhost/api/v1/sessions/session-1/goal"),
		)) as Response;
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({ goal: sampleGoalJson(), nativeGoalAvailable: true });
		expect(getSessionGoalMock).toHaveBeenCalledWith(commandInput());
	});

	it("delegates POST goal creation to the session goal service", async () => {
		const body = { objective: "ship it" };

		const response = (await POST(
			sessionEvent("http://localhost/api/v1/sessions/session-1/goal", body),
		)) as Response;
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload).toEqual({ goal: sampleGoalJson() });
		expect(setSessionGoalMock).toHaveBeenCalledWith({
			...commandInput(),
			body,
		});
	});

	it("maps native POST results without exposing route-side injection", async () => {
		setSessionGoalMock.mockResolvedValue({
			status: "native",
			native: true,
			objective: "ship it",
		});

		const response = (await POST(
			sessionEvent("http://localhost/api/v1/sessions/session-1/goal", {
				objective: "/goal ship it",
			}),
		)) as Response;
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload).toEqual({ native: true, objective: "ship it" });
	});

	it("delegates PATCH status updates to the session goal service", async () => {
		const body = { status: "complete" };

		const response = (await PATCH(
			sessionEvent("http://localhost/api/v1/sessions/session-1/goal", body),
		)) as Response;
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload).toEqual({ goal: sampleGoalJson({ status: "complete" }) });
		expect(updateSessionGoalStatusMock).toHaveBeenCalledWith({
			...commandInput(),
			body,
		});
	});
});

function sessionEvent(url: string, body?: Record<string, unknown>): never {
	return {
		params: { id: "session-1" },
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

function commandInput() {
	return {
		sessionId: "session-1",
		projectId: "project-1",
		userId: "user-1",
	};
}

function sampleGoal(overrides: Record<string, unknown> = {}) {
	return {
		id: "goal-row-1",
		sessionId: "session-1",
		goalId: "goal-1",
		objective: "ship it",
		status: "active",
		tokenBudget: null,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		iterations: 0,
		maxIterations: 50,
		acceptanceCriteria: null,
		evidencePlan: null,
		budgetSteeredAt: null,
		lastContinuationAt: null,
		stopReason: null,
		workflowExecutionId: "execution-1",
		createdAt: new Date("2026-05-15T12:00:00.000Z"),
		updatedAt: new Date("2026-05-15T12:00:00.000Z"),
		completedAt: null,
		...overrides,
	};
}

function sampleGoalJson(overrides: Record<string, unknown> = {}) {
	return JSON.parse(JSON.stringify(sampleGoal(overrides)));
}
