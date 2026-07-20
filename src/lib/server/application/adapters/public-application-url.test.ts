import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getAppUrl: vi.fn(async () => "https://workflow-builder.example"),
}));

vi.mock("$lib/server/app-url", () => ({ getAppUrl: mocks.getAppUrl }));

import { ConfiguredPublicApplicationUrlAdapter } from "./public-application-url";

describe("ConfiguredPublicApplicationUrlAdapter", () => {
	beforeEach(() => vi.clearAllMocks());

	it("resolves the configured public application URL", async () => {
		const request = new Request("http://workflow-builder:3000/internal");
		const fallbackUrl = new URL(request.url);
		const adapter = new ConfiguredPublicApplicationUrlAdapter();

		await expect(adapter.resolve({ request, fallbackUrl })).resolves.toBe(
			"https://workflow-builder.example",
		);
		expect(mocks.getAppUrl).toHaveBeenCalledWith(fallbackUrl, request);
	});
});
