import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewReadProxyService } from "$lib/server/application/preview-read-proxy";
import type { PreviewReadProxyPort } from "$lib/server/application/ports";

function fakeProxy(): PreviewReadProxyPort {
	return {
		listExecutions: vi.fn(async () => ({
			ok: true as const,
			data: { executions: [], total: 0 },
		})),
		getExecution: vi.fn(async () => ({ ok: true as const, data: { id: "e1" } })),
		listExecutionArtifacts: vi.fn(async () => ({ ok: true as const, data: [] })),
		fetchFileContent: vi.fn(async () => ({
			ok: true as const,
			data: { bytes: Buffer.alloc(0), contentType: null },
		})),
	};
}

const previews = [
	{ name: "gan-claude", url: "https://wfb-gan-claude.ts.example", pool: null },
	{ name: "alice-dev", url: null, pool: "pool-1" },
];

describe("ApplicationPreviewReadProxyService", () => {
	it("resolves preview names against the SEA list only (unknown → null)", async () => {
		const proxy = fakeProxy();
		const service = new ApplicationPreviewReadProxyService({
			proxy,
			listPreviews: async () => previews,
		});
		expect(await service.listPreviewExecutions({ name: "nope" })).toBeNull();
		expect(proxy.listExecutions).not.toHaveBeenCalled();
	});

	it("passes the resolved target (with pool) to the port", async () => {
		const proxy = fakeProxy();
		const service = new ApplicationPreviewReadProxyService({
			proxy,
			listPreviews: async () => previews,
		});
		const result = await service.listPreviewExecutions({ name: "Alice-Dev", limit: 5 });
		expect(result).not.toBeNull();
		expect(result?.preview).toEqual({ name: "alice-dev", url: null });
		expect(proxy.listExecutions).toHaveBeenCalledWith({
			target: previews[1],
			limit: 5,
			status: null,
		});
	});

	it("returns the degraded result untouched (route renders it, never 500s)", async () => {
		const proxy = fakeProxy();
		proxy.listExecutions = vi.fn(async () => ({
			ok: false as const,
			reason: "unreachable" as const,
			message: "timeout",
		}));
		const service = new ApplicationPreviewReadProxyService({
			proxy,
			listPreviews: async () => previews,
		});
		const result = await service.listPreviewExecutions({ name: "gan-claude" });
		expect(result?.result).toEqual({ ok: false, reason: "unreachable", message: "timeout" });
	});

	it("proxies execution detail", async () => {
		const proxy = fakeProxy();
		const service = new ApplicationPreviewReadProxyService({
			proxy,
			listPreviews: async () => previews,
		});
		const result = await service.getPreviewExecution({
			name: "gan-claude",
			executionId: "e1",
		});
		expect(result?.result).toEqual({ ok: true, data: { id: "e1" } });
	});
});
