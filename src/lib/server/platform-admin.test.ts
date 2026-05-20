import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
	const limit = vi.fn();
	const where = vi.fn(() => ({ limit }));
	const from = vi.fn(() => ({ where }));
	const select = vi.fn(() => ({ from }));
	return { from, limit, select, where };
});

vi.mock("$lib/server/db", () => ({
	db: { select: dbMock.select },
}));

import { requirePlatformAdmin } from "./platform-admin";

describe("requirePlatformAdmin", () => {
	beforeEach(() => {
		dbMock.limit.mockReset();
		dbMock.where.mockClear();
		dbMock.from.mockClear();
		dbMock.select.mockClear();
	});

	it("rejects unauthenticated callers", async () => {
		await expect(requirePlatformAdmin({ session: null })).rejects.toMatchObject({
			status: 401,
		});
		expect(dbMock.select).not.toHaveBeenCalled();
	});

	it("rejects non-admin callers", async () => {
		dbMock.limit.mockResolvedValueOnce([{ platformRole: "MEMBER" }]);

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
	});

	it("allows platform admins", async () => {
		dbMock.limit.mockResolvedValueOnce([{ platformRole: "ADMIN" }]);

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
	});
});
