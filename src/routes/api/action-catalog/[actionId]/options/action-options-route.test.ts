import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	actionOptions: {
		getOptions: vi.fn(async () => ({
			status: 200,
			payload: { options: [{ label: "A", value: "a" }] },
		})),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		actionOptions: mocks.actionOptions,
	}),
}));

import { POST } from "./+server";

describe("/api/action-catalog/[actionId]/options route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps dynamic option lookup behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("actionOptions.getOptions");
		expect(source).not.toContain("$lib/server/action-catalog");
		expect(source).not.toContain("$lib/server/code-functions");
		expect(source).not.toContain("$lib/server/app-connections");
		expect(source).not.toContain("$lib/server/activepieces/piece-service");
		expect(source).not.toContain("$lib/server/dapr-client");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates requests to actionOptions", async () => {
		const body = { param: "repo", input: { owner: "octo" } };
		const request = new Request(
			"http://localhost/api/action-catalog/github.create_issue/options",
			{
				method: "POST",
				headers: { cookie: "sid=123" },
				body: JSON.stringify(body),
			},
		);

		const response = await POST({
			params: { actionId: "github.create_issue" },
			request,
			locals: { session: { userId: "user-1" } },
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			options: [{ label: "A", value: "a" }],
		});
		expect(mocks.actionOptions.getOptions).toHaveBeenCalledWith({
			actionId: "github.create_issue",
			userId: "user-1",
			body,
			requestUrl: request.url,
			cookie: "sid=123",
		});
	});
});
