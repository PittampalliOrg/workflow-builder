import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BulkLifecycleStopServiceResult } from "$lib/server/application/lifecycle-bulk-stop";

const mocks = vi.hoisted(() => {
	const bulkLifecycleStop = {
		stopMany: vi.fn(async (): Promise<BulkLifecycleStopServiceResult> => ({
			status: "ok",
			body: {
				mode: "terminate",
				results: [
					{
						kind: "session",
						id: "session-1",
						state: "confirmed",
						status: 200,
						ok: true,
					},
				],
				summary: {
					total: 1,
					confirmed: 1,
					stopping: 0,
					cancelled: 0,
					coordinatorOwned: 0,
					notFound: 0,
					failed: 0,
				},
			},
		})),
	};
	return { bulkLifecycleStop };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ bulkLifecycleStop: mocks.bulkLifecycleStop }),
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
		request: jsonRequest({ targets: [{ kind: "session", id: "session-1" }] }),
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

describe("bulk lifecycle stop route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps the route as a thin application-service adapter", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("bulkLifecycleStop.stopMany");
		expect(source).not.toContain("$env/dynamic/private");
		expect(source).not.toContain("$lib/server/lifecycle");
		expect(source).not.toContain("$lib/server/dapr-client");
		expect(source).not.toContain("$lib/server/benchmarks");
		expect(source).not.toContain("$lib/server/evaluations");
		expect(source).not.toContain("$lib/server/goals");
		expect(source).not.toContain("$lib/server/workflows/project-scope");
	});

	it("delegates parsed requests to the application service", async () => {
		const response = (await POST(
			event({
				request: jsonRequest({
					mode: "purge",
					targets: [{ kind: "session", id: "session-1" }],
				}),
			}) as never,
		)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			mode: "terminate",
			summary: { total: 1, confirmed: 1 },
		});
		expect(mocks.bulkLifecycleStop.stopMany).toHaveBeenCalledWith({
			userId: "user-1",
			projectId: "project-1",
			body: {
				mode: "purge",
				targets: [{ kind: "session", id: "session-1" }],
			},
		});
	});

	it("requires an authenticated session", async () => {
		await expectHttpStatus(
			Promise.resolve(POST(event({ locals: { session: null } }) as never)),
			401,
		);
		expect(mocks.bulkLifecycleStop.stopMany).not.toHaveBeenCalled();
	});

	it("maps service validation errors to HTTP errors", async () => {
		mocks.bulkLifecycleStop.stopMany.mockResolvedValueOnce({
			status: "error",
			httpStatus: 400,
			message: "No valid targets provided",
		});

		await expectHttpStatus(Promise.resolve(POST(event() as never)), 400);
	});
});
