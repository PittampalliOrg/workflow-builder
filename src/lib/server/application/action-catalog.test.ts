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

	it("marks deployment-unsupported actions as unavailable in snapshots and details", async () => {
		const reader: ActionCatalogReader = {
			loadSnapshot: vi.fn(async () => ({
				items: [
					{
						id: "builtin.browser/start-preview",
						name: "browser/start-preview",
						insertable: true,
						ready: true,
						warnings: [],
					},
				],
			})),
			getDetail: vi.fn(async () => ({
				id: "builtin.browser/start-preview",
				version: "1.0.0",
				slug: "browser/start-preview",
				insertable: true,
				runtime: { ready: true, errors: [] },
				raw: null,
				sw: {
					functionName: "browser/start-preview",
					definition: { call: "browser/start-preview" },
					taskConfig: { call: "browser/start-preview" },
				},
			})),
		};
		const capabilities = {
			actionAvailability: vi.fn(() => ({
				available: false,
				code: "unsupported_in_preview",
				message: "OpenShell is unavailable in preview deployments",
			})),
		};
		const service = new ApplicationActionCatalogService(reader, capabilities);

		await expect(service.loadSnapshot({ userId: null })).resolves.toMatchObject({
			items: [
				{
					name: "browser/start-preview",
					insertable: false,
					ready: false,
					availability: { code: "unsupported_in_preview" },
					warnings: [
						"unsupported_in_preview: OpenShell is unavailable in preview deployments",
					],
				},
			],
		});
		await expect(
			service.getDetail({
				actionId: "builtin.browser/start-preview",
				userId: null,
			}),
		).resolves.toMatchObject({
			insertable: false,
			ready: false,
			runtime: {
				ready: false,
				errors: [
					"unsupported_in_preview: OpenShell is unavailable in preview deployments",
				],
			},
			availability: { code: "unsupported_in_preview" },
		});
	});
});
