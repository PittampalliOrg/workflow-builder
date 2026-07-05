import { afterEach, describe, expect, it, vi } from "vitest";
import {
	HttpPreviewReadProxy,
	previewApiBaseUrl,
} from "$lib/server/application/adapters/preview-read-proxy";
import type { PreviewRunTarget } from "$lib/server/application/ports";

const target = (over: Partial<PreviewRunTarget> = {}): PreviewRunTarget => ({
	name: "myfeature",
	url: "https://wfb-myfeature.tail286401.ts.net",
	pool: null,
	...over,
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("previewApiBaseUrl", () => {
	it("prefers the vcluster-synced in-cluster Service", () => {
		expect(previewApiBaseUrl(target())).toBe(
			"http://workflow-builder-x-workflow-builder-x-myfeature.vcluster-myfeature.svc.cluster.local:3000",
		);
	});

	it("keys on the backing POOL member for a claimed warm-pool preview", () => {
		// A claimed member keeps its pool-named namespace/services; the alias is
		// display-only — same rule as the E1 feed streams.
		expect(previewApiBaseUrl(target({ name: "alice-dev", pool: "pool-33b8" }))).toBe(
			"http://workflow-builder-x-workflow-builder-x-pool-33b8.vcluster-pool-33b8.svc.cluster.local:3000",
		);
	});

	it("falls back to the tailnet URL when the synced name would exceed the DNS label limit", () => {
		const name = "a".repeat(40); // 38-char prefix + 40 > 63
		expect(previewApiBaseUrl(target({ name }))).toBe(
			"https://wfb-myfeature.tail286401.ts.net",
		);
	});

	it("returns null when nothing is resolvable", () => {
		expect(previewApiBaseUrl(target({ name: "a".repeat(40), url: null }))).toBeNull();
	});
});

describe("HttpPreviewReadProxy", () => {
	it("lists executions with the internal token against the in-cluster URL", async () => {
		const fetchImpl = vi.fn(async () =>
			new Response(
				JSON.stringify({
					success: true,
					total: 1,
					executions: [
						{
							id: "exec-1",
							workflowId: "wf-1",
							status: "success",
							phase: "done",
							progress: 100,
							error: null,
							startedAt: "2026-07-04T10:00:00.000Z",
							completedAt: "2026-07-04T10:00:30.000Z",
							workflow: { id: "wf-1", name: "Smoke", description: null },
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const proxy = new HttpPreviewReadProxy({ token: "tok-123", fetchImpl });
		const result = await proxy.listExecutions({ target: target(), limit: 10 });

		expect(fetchImpl).toHaveBeenCalledOnce();
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(
			"http://workflow-builder-x-workflow-builder-x-myfeature.vcluster-myfeature.svc.cluster.local:3000/api/internal/agent/workflows/executions?limit=10",
		);
		expect((init.headers as Record<string, string>)["X-Internal-Token"]).toBe("tok-123");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.total).toBe(1);
			expect(result.data.executions[0]).toMatchObject({
				id: "exec-1",
				workflowName: "Smoke",
				status: "success",
				durationMs: 30_000,
			});
		}
	});

	it("degrades to unreachable when fetch rejects", async () => {
		const proxy = new HttpPreviewReadProxy({
			token: "tok",
			fetchImpl: vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		});
		const result = await proxy.listExecutions({ target: target() });
		expect(result).toMatchObject({ ok: false, reason: "unreachable" });
	});

	it("maps 401 to unauthorized and 405 to bad-response (pre-route preview image)", async () => {
		const mk = (status: number) =>
			new HttpPreviewReadProxy({
				token: "tok",
				fetchImpl: vi.fn(async () => new Response("no", { status })),
			});
		expect(await mk(401).listExecutions({ target: target() })).toMatchObject({
			ok: false,
			reason: "unauthorized",
		});
		expect(
			await mk(405).listExecutionArtifacts({ target: target(), executionId: "e1" }),
		).toMatchObject({ ok: false, reason: "bad-response" });
	});

	it("refuses without a configured internal token", async () => {
		vi.stubEnv("INTERNAL_API_TOKEN", "");
		const proxy = new HttpPreviewReadProxy({ fetchImpl: vi.fn() });
		const result = await proxy.getExecution({ target: target(), executionId: "e1" });
		expect(result).toMatchObject({ ok: false, reason: "unauthorized" });
	});

	it("caps fetched file content at maxBytes", async () => {
		const proxy = new HttpPreviewReadProxy({
			token: "tok",
			fetchImpl: vi.fn(async () =>
				new Response(new Uint8Array(64), {
					status: 200,
					headers: { "content-type": "application/gzip" },
				}),
			),
		});
		const result = await proxy.fetchFileContent({
			target: target(),
			fileId: "f1",
			maxBytes: 16,
		});
		expect(result).toMatchObject({ ok: false, reason: "bad-response" });
	});
});
