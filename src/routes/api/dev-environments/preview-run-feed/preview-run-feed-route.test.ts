import { beforeEach, describe, expect, it, vi } from "vitest";

import { requirePlatformAdmin } from "$lib/server/platform-admin";
import { GET } from "./+server";

const mocks = vi.hoisted(() => ({
	config: {
		previewRunFeedEnabled: true,
	},
	isControlPlane: vi.fn(),
	createEventStream: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		previewDeploymentScope: {
			isControlPlane: mocks.isControlPlane,
		},
		previewRunFeed: {
			createEventStream: mocks.createEventStream,
		},
	}),
}));

vi.mock("$lib/server/application/config", () => ({
	getApplicationAdapterConfig: () => mocks.config,
}));

vi.mock("$lib/server/platform-admin", () => ({
	requirePlatformAdmin: vi.fn(),
}));

describe("preview run feed route", () => {
	beforeEach(() => {
		mocks.config.previewRunFeedEnabled = true;
		mocks.createEventStream.mockReset();
		mocks.isControlPlane.mockReset();
		mocks.isControlPlane.mockReturnValue(true);
		vi.mocked(requirePlatformAdmin).mockReset();
		vi.mocked(requirePlatformAdmin).mockResolvedValue(undefined);
	});

	it("rejects an unauthenticated request before deployment-scope evaluation", async () => {
		await expect(GET({ locals: { session: null } } as never)).rejects.toMatchObject({
			status: 401,
		});

		expect(mocks.isControlPlane).not.toHaveBeenCalled();
		expect(requirePlatformAdmin).not.toHaveBeenCalled();
		expect(mocks.createEventStream).not.toHaveBeenCalled();
	});

	it("rejects a preview deployment even with an admin session", async () => {
		mocks.isControlPlane.mockReturnValueOnce(false);

		await expect(
			GET({ locals: { session: { userId: "admin-1" } } } as never),
		).rejects.toMatchObject({ status: 403 });

		expect(requirePlatformAdmin).not.toHaveBeenCalled();
		expect(mocks.createEventStream).not.toHaveBeenCalled();
	});

	it("rejects a signed-in non-admin before opening the cross-preview stream", async () => {
		const forbidden = Object.assign(new Error("Admin access required"), {
			status: 403,
		});
		vi.mocked(requirePlatformAdmin).mockRejectedValueOnce(forbidden);

		await expect(
			GET({ locals: { session: { userId: "member-1" } } } as never),
		).rejects.toMatchObject({ status: 403 });

		expect(requirePlatformAdmin).toHaveBeenCalledOnce();
		expect(mocks.createEventStream).not.toHaveBeenCalled();
	});

	it("keeps the feed invisible when the feature is disabled", async () => {
		mocks.config.previewRunFeedEnabled = false;

		await expect(
			GET({ locals: { session: { userId: "admin-1" } } } as never),
		).rejects.toMatchObject({ status: 404 });

		expect(requirePlatformAdmin).toHaveBeenCalledOnce();
		expect(mocks.createEventStream).not.toHaveBeenCalled();
	});

	it("opens the SSE stream for a platform admin", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});
		mocks.createEventStream.mockReturnValueOnce(stream);

		const response = (await GET({
			locals: { session: { userId: "admin-1" } },
		} as never)) as Response;

		expect(requirePlatformAdmin).toHaveBeenCalledOnce();
		expect(mocks.createEventStream).toHaveBeenCalledOnce();
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		expect(response.headers.get("x-accel-buffering")).toBe("no");
	});
});
