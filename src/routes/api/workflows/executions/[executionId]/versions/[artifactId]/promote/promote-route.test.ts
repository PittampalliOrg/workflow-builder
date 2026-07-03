import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowCodeVersionPromotionResult } from "$lib/server/application/workflow-code-version-promotion";

const mocks = vi.hoisted(() => {
	const workflowCodeVersionPromotion = {
		promote: vi.fn(async (): Promise<WorkflowCodeVersionPromotionResult> => ({
			status: "ok",
			body: {
				ok: true,
				mode: "branch",
				repo: "owner/repo",
				base: "main",
				tier: "tar-overlay",
				promotionGate: { allowed: true },
				prUrl: null,
				branch: "wfb-promote-1",
				prError: null,
				output: "BRANCH_PUSHED=wfb-promote-1\n",
			},
		})),
	};
	return { workflowCodeVersionPromotion };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowCodeVersionPromotion: mocks.workflowCodeVersionPromotion,
	}),
}));

import { POST } from "./+server";

function jsonRequest(body: unknown) {
	return new Request("http://workflow-builder.local/test", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-1", artifactId: "artifact-1" },
		request: jsonRequest({ mode: "branch" }),
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

describe("workflow execution source-bundle promote route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps the route behind the code-version promotion application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("workflowCodeVersionPromotion.promote");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/workflows/project-scope");
		expect(source).not.toContain("$lib/server/workflows/promotion-gates");
		expect(source).not.toContain("$lib/server/workflows/source-bundle");
		expect(source).not.toContain("$lib/server/workflows/helper-pod");
	});

	it("delegates promotion requests with route params and session scope", async () => {
		const response = (await POST(
			event({
				request: jsonRequest({
					mode: "branch",
					repo: "owner/repo",
				}),
			}) as never,
		)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			mode: "branch",
			repo: "owner/repo",
			branch: "wfb-promote-1",
		});
		expect(mocks.workflowCodeVersionPromotion.promote).toHaveBeenCalledWith({
			executionId: "exec-1",
			artifactId: "artifact-1",
			userId: "user-1",
			projectId: "project-1",
			body: { mode: "branch", repo: "owner/repo" },
		});
	});

	it("requires an authenticated session", async () => {
		await expectHttpStatus(
			Promise.resolve(POST(event({ locals: { session: null } }) as never)),
			401,
		);
		expect(mocks.workflowCodeVersionPromotion.promote).not.toHaveBeenCalled();
	});

	it("maps application errors to HTTP errors", async () => {
		mocks.workflowCodeVersionPromotion.promote.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});

		await expectHttpStatus(Promise.resolve(POST(event() as never)), 404);
	});

	it("preserves application-selected response status for JSON failures", async () => {
		mocks.workflowCodeVersionPromotion.promote.mockResolvedValueOnce({
			status: "ok",
			httpStatus: 409,
			body: {
				ok: false,
				error: "promotion_gate_failed",
				promotionGate: { allowed: false },
			},
		});

		const response = (await POST(event() as never)) as Response;
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			error: "promotion_gate_failed",
		});
	});
});
