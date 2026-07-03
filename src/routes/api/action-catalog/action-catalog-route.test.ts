import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	actionCatalog: {
		loadSnapshot: vi.fn(async () => ({ items: [{ id: "action-1" }] })),
		getDetail: vi.fn(async () => ({ id: "action-1", definition: {} })),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		actionCatalog: mocks.actionCatalog,
	}),
}));

import { GET as getActionCatalog } from "./+server";
import { GET as getActionDetail } from "./[actionId]/+server";

describe("/api/action-catalog routes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps action catalog loading behind the application service", () => {
		const routeDir = dirname(fileURLToPath(import.meta.url));
		for (const routePath of ["+server.ts", "[actionId]/+server.ts"]) {
			const source = readFileSync(join(routeDir, routePath), "utf8");

			expect(source).toContain("actionCatalog");
			expect(source).not.toContain("$lib/server/action-catalog");
			expect(source).not.toContain("$lib/server/db");
			expect(source).not.toContain("drizzle-orm");
		}
	});

	it("delegates snapshot loading", async () => {
		const response = await getActionCatalog({
			locals: { session: { userId: "user-1" } },
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			items: [{ id: "action-1" }],
		});
		expect(mocks.actionCatalog.loadSnapshot).toHaveBeenCalledWith({
			userId: "user-1",
		});
	});

	it("delegates detail loading", async () => {
		const response = await getActionDetail({
			params: { actionId: "action-1" },
			locals: { session: null },
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			id: "action-1",
			definition: {},
		});
		expect(mocks.actionCatalog.getDetail).toHaveBeenCalledWith({
			actionId: "action-1",
			userId: null,
		});
	});
});
