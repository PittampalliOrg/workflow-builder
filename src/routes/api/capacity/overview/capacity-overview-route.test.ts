import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./+server";

const mocks = vi.hoisted(() => ({
	getOverview: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		capacityOverview: {
			getOverview: mocks.getOverview,
		},
	}),
}));

describe("capacity overview route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getOverview.mockResolvedValue({
			observer: {
				available: true,
				snapshot: { cluster: "dev", resources: [] },
				error: null,
			},
			businessWork: {
				active: [],
				recent: [],
				infrastructure: [],
				totals: { activeWork: 1 },
				generatedAt: "2026-01-01T00:00:00.000Z",
			},
		});
	});

	it("calls the application capacity overview service with workspace context", async () => {
		const response = (await GET({
			locals: {
				session: {
					userId: "user-1",
					projectId: "project-1",
				},
			},
		} as never)) as Response;

		await expect(response.json()).resolves.toMatchObject({
			observer: { available: true, snapshot: { cluster: "dev" } },
			businessWork: { totals: { activeWork: 1 } },
		});
		expect(mocks.getOverview).toHaveBeenCalledTimes(1);
		expect(mocks.getOverview).toHaveBeenCalledWith({
			projectId: "project-1",
			workspaceSlug: "default",
		});
	});

	it("keeps the legacy null businessWork response shape when observer is unavailable", async () => {
		mocks.getOverview.mockResolvedValueOnce({
			observer: {
				available: false,
				snapshot: null,
				error: "observer unavailable",
			},
			businessWork: {
				active: [],
				recent: [],
				infrastructure: [],
				totals: { activeWork: 0 },
				generatedAt: "2026-01-01T00:00:00.000Z",
			},
		});

		const response = (await GET({
			locals: {
				session: {
					userId: "user-1",
					projectId: "project-1",
				},
			},
		} as never)) as Response;

		await expect(response.json()).resolves.toMatchObject({
			observer: { available: false, error: "observer unavailable" },
			businessWork: null,
		});
	});

	it("delegates capacity reads and ownership enrichment to the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("capacityOverview.getOverview");
		expect(source).not.toContain("$lib/server/capacity/observer");
		expect(source).not.toContain("$lib/server/capacity/business-work");
		expect(source).not.toContain("$lib/server/capacity/ownership");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});
