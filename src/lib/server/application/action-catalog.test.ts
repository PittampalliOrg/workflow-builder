import { describe, expect, it, vi } from "vitest";
import {
	ApplicationActionCatalogService,
	type ActionCatalogReader,
} from "$lib/server/application/action-catalog";

describe("ApplicationActionCatalogService", () => {
	it("loads snapshots through the catalog reader port", async () => {
		const reader: ActionCatalogReader = {
			loadSnapshot: vi.fn(async () => ({ items: [] })),
			getDetail: vi.fn(async () => null),
		};

		await expect(
			new ApplicationActionCatalogService(reader).loadSnapshot({
				userId: "user-1",
			}),
		).resolves.toEqual({ items: [] });
		expect(reader.loadSnapshot).toHaveBeenCalledWith("user-1");
	});

	it("projects detail route fields without exposing route-local shaping", async () => {
		const reader: ActionCatalogReader = {
			loadSnapshot: vi.fn(async () => ({ items: [] })),
			getDetail: vi.fn(async () => ({
				id: "action-1",
				version: "1.0.0",
				raw: { pieceName: "github" },
				sw: {
					functionName: "github/create_issue",
					definition: { call: "github/create_issue" },
					taskConfig: { call: "github/create_issue" },
				},
			})),
		};

		await expect(
			new ApplicationActionCatalogService(reader).getDetail({
				actionId: "action-1",
				userId: null,
			}),
		).resolves.toEqual({
			id: "action-1",
			version: "1.0.0",
			raw: { pieceName: "github" },
			sw: {
				functionName: "github/create_issue",
				definition: { call: "github/create_issue" },
				taskConfig: { call: "github/create_issue" },
			},
			definition: { call: "github/create_issue" },
			taskConfig: { call: "github/create_issue" },
			functionRef: {
				name: "github/create_issue",
				version: "1.0.0",
			},
			pieceName: "github",
		});
		expect(reader.getDetail).toHaveBeenCalledWith("action-1", null);
	});
});
