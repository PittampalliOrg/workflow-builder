import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	evaluationDefinitions: {
		get: vi.fn(async () => ({ evaluation: { id: "eval-1" } })),
		update: vi.fn(async () => ({ evaluation: { id: "eval-1", name: "Updated" } })),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		evaluationDefinitions: mocks.evaluationDefinitions,
	}),
}));

import { GET, PATCH } from "./+server";

describe("/api/evaluations/evals/[evaluationId] route", () => {
	beforeEach(() => vi.clearAllMocks());

	it("keeps evaluation definition detail behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("evaluationDefinitions");
		expect(source).not.toContain("$lib/server/evaluations/service");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates get and update requests", async () => {
		const getResponse = await GET({
			params: { evaluationId: "eval-1" },
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never);
		expect(getResponse.status).toBe(200);
		await expect(getResponse.json()).resolves.toEqual({
			evaluation: { id: "eval-1" },
		});

		const body = { name: "Updated" };
		const patchResponse = await PATCH({
			request: new Request("http://localhost/api/evaluations/evals/eval-1", {
				method: "PATCH",
				body: JSON.stringify(body),
			}),
			params: { evaluationId: "eval-1" },
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never);
		expect(patchResponse.status).toBe(200);
		await expect(patchResponse.json()).resolves.toEqual({
			evaluation: { id: "eval-1", name: "Updated" },
		});
		expect(mocks.evaluationDefinitions.get).toHaveBeenCalledWith({
			projectId: "project-1",
			evaluationId: "eval-1",
		});
		expect(mocks.evaluationDefinitions.update).toHaveBeenCalledWith({
			projectId: "project-1",
			evaluationId: "eval-1",
			body,
		});
	});
});
