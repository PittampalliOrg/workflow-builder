import { afterEach, describe, expect, it, vi } from "vitest";
import {
	claimVclusterPreview,
	launchVclusterPreview,
	listVclusterPreviewsWithCounts,
	provisionVclusterPreview,
} from "./vcluster-preview";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
	return JSON.parse(String((init as RequestInit).body));
}

describe("vcluster-preview A3 claim-first client", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("claims a warm-pool member first and does not cold-provision", async () => {
		vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
		const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
			expect(url).toBe("http://sandbox-api/internal/vcluster-preview/claim");
			return jsonResponse(
				{
					name: "my-feature",
					pool: "pool-abcd",
					pooled: true,
					status: "claiming",
					tailnetHost: "wfb-my-feature",
					url: "https://wfb-my-feature.tail286401.ts.net",
				},
				202,
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const preview = await launchVclusterPreview({ name: "My Feature", user: "u1" });

		expect(preview.pool).toBe("pool-abcd");
		expect(preview.name).toBe("my-feature");
		expect(preview.phase).toBe("claiming");
		// Only the claim endpoint was hit — no cold /internal/vcluster-preview call.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
			name: "my-feature",
			user: "u1",
		});
	});

	it("falls back to a cold provision when the pool has no free member (claim 404)", async () => {
		vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
		const calls: string[] = [];
		const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
			calls.push(url);
			if (url.endsWith("/claim")) return jsonResponse({ detail: "no free member" }, 404);
			return jsonResponse({
				name: "my-feature",
				job: "vcpreview-up-my-feature",
				status: "provisioning",
				tailnetHost: "wfb-my-feature",
				url: "https://wfb-my-feature.tail286401.ts.net",
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const preview = await launchVclusterPreview({ name: "my-feature" });

		expect(calls).toEqual([
			"http://sandbox-api/internal/vcluster-preview/claim",
			"http://sandbox-api/internal/vcluster-preview",
		]);
		expect(preview.pool).toBeNull();
		expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toMatchObject({
			name: "my-feature",
			action: "up",
		});
	});

	it("claimVclusterPreview returns null on 404", async () => {
		vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, _init?: RequestInit) =>
				jsonResponse({ detail: "empty" }, 404),
			),
		);
		expect(await claimVclusterPreview({ name: "x" })).toBeNull();
	});

	it("claimVclusterPreview throws on a non-404 error", async () => {
		vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, _init?: RequestInit) =>
				jsonResponse({ detail: "boom" }, 500),
			),
		);
		await expect(claimVclusterPreview({ name: "x" })).rejects.toThrow("boom");
	});

	it("passes devMode through to the claim body", async () => {
		vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
		const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
			jsonResponse({ name: "x", pool: "pool-1", status: "claiming" }, 202),
		);
		vi.stubGlobal("fetch", fetchMock);
		await claimVclusterPreview({ name: "x", devMode: true, user: "u2" });
		expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
			name: "x",
			devMode: true,
			user: "u2",
		});
	});

	it("provisionVclusterPreview posts action=up", async () => {
		vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
		const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
			jsonResponse({ name: "x", status: "provisioning" }),
		);
		vi.stubGlobal("fetch", fetchMock);
		await provisionVclusterPreview({ name: "x" });
		expect(fetchMock).toHaveBeenCalledWith(
			"http://sandbox-api/internal/vcluster-preview",
			expect.objectContaining({ method: "POST" }),
		);
		expect(bodyOf(fetchMock.mock.calls[0]?.[1]).action).toBe("up");
	});

	it("listVclusterPreviewsWithCounts parses previews and capacity counts", async () => {
		vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, _init?: RequestInit) =>
				jsonResponse({
					previews: [
						{ name: "my-feature", phase: "ready", ready: true, pool: "pool-9" },
					],
					counts: { awake: 3, free: 1, claimed: 1, recycling: 0, max: 6, poolSize: 2 },
				}),
			),
		);
		const { previews, counts } = await listVclusterPreviewsWithCounts();
		expect(previews[0].pool).toBe("pool-9");
		expect(counts).toMatchObject({ awake: 3, free: 1, claimed: 1, max: 6, poolSize: 2 });
	});

	it("tolerates an older SEA that omits counts", async () => {
		vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, _init?: RequestInit) =>
				jsonResponse({ previews: [{ name: "x", phase: "ready" }] }),
			),
		);
		const { previews, counts } = await listVclusterPreviewsWithCounts();
		expect(previews).toHaveLength(1);
		expect(counts).toBeNull();
	});
});
