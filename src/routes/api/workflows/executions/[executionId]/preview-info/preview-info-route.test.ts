import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const cliPreview = {
		getExecutionPreviewInfo: vi.fn(async () => ({
			status: "ok" as const,
			body: { backend: "cli" },
		})),
	};
	return { cliPreview };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		cliPreview: mocks.cliPreview,
	}),
}));

import { GET } from "./+server";

describe("execution preview info route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.cliPreview.getExecutionPreviewInfo.mockResolvedValue({
			status: "ok",
			body: { backend: "cli" },
		});
	});

	it("delegates preview backend detection to the application service", async () => {
		const response = (await GET(event())) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ backend: "cli" });
		expect(mocks.cliPreview.getExecutionPreviewInfo).toHaveBeenCalledWith({
			executionId: "exec-1",
		});
	});

	it("keeps direct preview backend helpers out of the route", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("cliPreview.getExecutionPreviewInfo");
		expect(source).not.toContain("$lib/server/sessions/cli-preview");
		expect(source).not.toContain("executionPreviewBackend");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-1" },
		locals: { session: { userId: "user-1", projectId: "project-1" } },
		...overrides,
	} as never;
}
