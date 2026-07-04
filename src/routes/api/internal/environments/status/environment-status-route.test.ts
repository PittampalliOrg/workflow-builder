import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	requireInternal: vi.fn(),
	benchmarkEnvironmentValidation: {
		getEnvironmentStatus: vi.fn(),
	},
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		benchmarkEnvironmentValidation: mocks.benchmarkEnvironmentValidation,
	}),
}));

import { POST } from "./+server";

describe("internal environment status route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.benchmarkEnvironmentValidation.getEnvironmentStatus.mockResolvedValue({
			success: true,
			complete: false,
			environmentStatus: "building",
			status: "building",
			sandboxTemplate: "dapr-agent",
			buildId: "build-1",
			envSpecHash: "hash-1",
		});
	});

	it("delegates status lookups to the environment validation service", async () => {
		const request = new Request("http://localhost/api/internal/environments/status", {
			method: "POST",
			body: JSON.stringify({
				buildId: "build-1",
				envSpecHash: "hash-1",
				environmentKey: "env-1",
			}),
		});

		const response = (await POST({ request } as never)) as Response;
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(mocks.requireInternal).toHaveBeenCalledWith(request);
		expect(
			mocks.benchmarkEnvironmentValidation.getEnvironmentStatus,
		).toHaveBeenCalledWith({
			buildId: "build-1",
			envSpecHash: "hash-1",
			environmentKey: "env-1",
		});
		expect(payload).toMatchObject({
			success: true,
			environmentStatus: "building",
			buildId: "build-1",
		});
	});

	it("normalizes absent lookup fields to null", async () => {
		const request = new Request("http://localhost/api/internal/environments/status", {
			method: "POST",
			body: JSON.stringify({ buildId: "build-1" }),
		});

		await POST({ request } as never);

		expect(
			mocks.benchmarkEnvironmentValidation.getEnvironmentStatus,
		).toHaveBeenCalledWith({
			buildId: "build-1",
			envSpecHash: null,
			environmentKey: null,
		});
	});

	it("keeps the route free of direct DB and legacy environment imports", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("benchmarkEnvironmentValidation");
		expect(source).toContain("getEnvironmentStatus");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("environmentImageBuilds");
		expect(source).not.toContain("environment-image-builds");
	});
});
