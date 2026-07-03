import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workflowDataMock = vi.hoisted(() => ({
	isPlatformAdmin: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: workflowDataMock,
	}),
}));

import { requirePlatformAdmin } from "./platform-admin";

describe("requirePlatformAdmin", () => {
	beforeEach(() => {
		workflowDataMock.isPlatformAdmin.mockReset();
	});

	it("rejects unauthenticated callers", async () => {
		await expect(requirePlatformAdmin({ session: null })).rejects.toMatchObject({
			status: 401,
		});
		expect(workflowDataMock.isPlatformAdmin).not.toHaveBeenCalled();
	});

	it("rejects non-admin callers", async () => {
		workflowDataMock.isPlatformAdmin.mockResolvedValueOnce(false);

		await expect(
			requirePlatformAdmin({
				session: {
					userId: "user-1",
					email: "member@example.com",
					projectId: "project-1",
					platformId: "platform-1",
				},
			}),
		).rejects.toMatchObject({ status: 403 });
		expect(workflowDataMock.isPlatformAdmin).toHaveBeenCalledWith("user-1");
	});

	it("allows platform admins", async () => {
		workflowDataMock.isPlatformAdmin.mockResolvedValueOnce(true);

		await expect(
			requirePlatformAdmin({
				session: {
					userId: "admin-1",
					email: "admin@example.com",
					projectId: "project-1",
					platformId: "platform-1",
				},
			}),
		).resolves.toBeUndefined();
		expect(workflowDataMock.isPlatformAdmin).toHaveBeenCalledWith("admin-1");
	});

	it("does not import direct DB infrastructure", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "platform-admin.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.isPlatformAdmin");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});
});
