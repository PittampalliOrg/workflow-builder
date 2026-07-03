import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	requireInternal: vi.fn(),
	workflowData: {
		reconcileAdminPieceRuntimeImages: vi.fn(async () => ({
			checked: 2,
			readied: 1,
			failed: 0,
		})),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

import { POST } from "./+server";

describe("internal piece image reconcile route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.reconcileAdminPieceRuntimeImages.mockResolvedValue({
			checked: 2,
			readied: 1,
			failed: 0,
		});
	});

	it("keeps image reconcile behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.reconcileAdminPieceRuntimeImages");
		expect(source).toContain("requireInternal");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/pieces/piece-images");
	});

	it("delegates reconcile requests", async () => {
		const request = new Request(
			"http://localhost/api/internal/pieces/reconcile-building",
			{ method: "POST" },
		);
		const response = (await POST({ request } as never)) as Response;

		expect(mocks.requireInternal).toHaveBeenCalledWith(request);
		expect(mocks.workflowData.reconcileAdminPieceRuntimeImages).toHaveBeenCalledWith();
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			checked: 2,
			readied: 1,
			failed: 0,
		});
	});
});
