import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	evaluationTemplates: {
		listSwebenchSuites: vi.fn(() => ({ suites: [{ slug: "SWE-bench_Lite" }] })),
		createSwebench: vi.fn(async () => ({
			dataset: { id: "dataset-1" },
			evaluation: { id: "eval-1" },
		})),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		evaluationTemplates: mocks.evaluationTemplates,
	}),
}));

import { GET, POST } from "./+server";

describe("/api/evaluations/templates/swebench route", () => {
	beforeEach(() => vi.clearAllMocks());

	it("delegates suite list and template creation", async () => {
		const getResponse = await GET({
			locals: { session: { userId: "user-1" } },
		} as never);
		expect(getResponse.status).toBe(200);
		await expect(getResponse.json()).resolves.toEqual({
			suites: [{ slug: "SWE-bench_Lite" }],
		});

		const body = { suiteSlug: "SWE-bench_Lite", rows: [{ id: "row-1" }] };
		const postResponse = await POST({
			request: new Request("http://localhost/api/evaluations/templates/swebench", {
				method: "POST",
				body: JSON.stringify(body),
			}),
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never);
		expect(postResponse.status).toBe(201);
		await expect(postResponse.json()).resolves.toEqual({
			dataset: { id: "dataset-1" },
			evaluation: { id: "eval-1" },
		});
		expect(mocks.evaluationTemplates.createSwebench).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
			body,
		});
	});
});
