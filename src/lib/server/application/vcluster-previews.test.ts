import { describe, expect, it, vi } from "vitest";
import { ApplicationVclusterPreviewService } from "$lib/server/application/vcluster-previews";
import type {
	VclusterPreviewGatewayPort,
	VclusterPreviewSleepOutcome,
	VclusterPreviewTouchResult,
} from "$lib/server/application/ports";
import type {
	VclusterPreviewCounts,
	VclusterPreviewRecord,
} from "$lib/types/dev-previews";

function record(over: Partial<VclusterPreviewRecord> = {}): VclusterPreviewRecord {
	return {
		name: "feat-x",
		phase: "ready",
		ready: true,
		url: "https://wfb-feat-x.ts.net",
		targetCluster: "dev",
		pool: null,
		state: "hot",
		origin: null,
		prNumber: null,
		expiresAt: null,
		lastActive: null,
		protected: false,
		bootSeconds: null,
		...over,
	};
}

function counts(over: Partial<VclusterPreviewCounts> = {}): VclusterPreviewCounts {
	return {
		awake: 0,
		slept: 0,
		total: 0,
		baking: 0,
		free: 0,
		claimed: 0,
		recycling: 0,
		max: 6,
		totalMax: 0,
		poolSize: 2,
		...over,
	};
}

function gateway(over: Partial<VclusterPreviewGatewayPort> = {}): VclusterPreviewGatewayPort {
	return {
		listWithCounts: vi.fn(async () => ({ previews: [], counts: counts() })),
		get: vi.fn(async (name: string) => record({ name })),
		claim: vi.fn(async () => null),
		provision: vi.fn(async (input) => record({ name: input.name })),
		teardown: vi.fn(async (name: string) => record({ name })),
		touch: vi.fn(
			async (name: string): Promise<VclusterPreviewTouchResult> => ({
				name,
				state: "hot",
				resuming: false,
				lastActive: null,
			}),
		),
		sleep: vi.fn(async (name: string): Promise<VclusterPreviewSleepOutcome> => ({
			ok: true,
			name,
			alreadySlept: false,
		})),
		...over,
	};
}

const service = (gw: VclusterPreviewGatewayPort) =>
	new ApplicationVclusterPreviewService({
		gateway: gw,
		previewRepo: "PittampalliOrg/workflow-builder",
		maxPreviews: 6,
	});

describe("ApplicationVclusterPreviewService", () => {
	it("decorates a pr-origin preview with a GitHub prUrl (null otherwise)", async () => {
		const gw = gateway({
			listWithCounts: vi.fn(async () => ({
				previews: [
					record({ name: "pr-42", origin: "pr", prNumber: 42 }),
					record({ name: "feat-y", origin: "user" }),
				],
				counts: counts(),
			})),
		});
		const { previews } = await service(gw).list();
		expect(previews[0].prUrl).toBe("https://github.com/PittampalliOrg/workflow-builder/pull/42");
		expect(previews[1].prUrl).toBeNull();
	});

	it("claims a warm-pool member first — pooled, uncapped, and touched", async () => {
		const gw = gateway({
			claim: vi.fn(async () => record({ name: "feat-x", pool: "pool-1" })),
		});
		const result = await service(gw).launch({ name: "feat-x", user: "u1" });
		expect(result.ok && result.pooled).toBe(true);
		expect(gw.claim).toHaveBeenCalledWith({ name: "feat-x", user: "u1" });
		expect(gw.touch).toHaveBeenCalledWith("feat-x");
		// Never lists/gates when a claim succeeds.
		expect(gw.listWithCounts).not.toHaveBeenCalled();
		expect(gw.provision).not.toHaveBeenCalled();
	});

	it("cold-provisions when the pool is empty and there is headroom", async () => {
		const gw = gateway({
			listWithCounts: vi.fn(async () => ({ previews: [], counts: counts({ awake: 2, max: 6 }) })),
		});
		const result = await service(gw).launch({ name: "feat-x" });
		expect(result.ok && !result.pooled).toBe(true);
		expect(gw.provision).toHaveBeenCalledWith({ name: "feat-x" });
	});

	it("refuses AS DATA when awake >= max (no throw)", async () => {
		const gw = gateway({
			listWithCounts: vi.fn(async () => ({ previews: [], counts: counts({ awake: 6, max: 6 }) })),
		});
		const result = await service(gw).launch({ name: "feat-x" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("capacity");
			expect(result.awake).toBe(6);
			expect(result.max).toBe(6);
		}
		expect(gw.provision).not.toHaveBeenCalled();
	});

	it("allows re-provisioning an EXISTING preview even at capacity", async () => {
		const gw = gateway({
			listWithCounts: vi.fn(async () => ({
				previews: [record({ name: "feat-x" })],
				counts: counts({ awake: 6, max: 6 }),
			})),
		});
		const result = await service(gw).launch({ name: "feat-x" });
		expect(result.ok).toBe(true);
		expect(gw.provision).toHaveBeenCalled();
	});

	it("falls back to the configured max when the SEA omits counts", async () => {
		const gw = gateway({
			listWithCounts: vi.fn(async () => ({
				previews: [record({ name: "a" }), record({ name: "b" }), record({ name: "c" })],
				counts: null,
			})),
		});
		// config max = 6, 3 awake (previews.length) < 6 → provisions
		const svc = new ApplicationVclusterPreviewService({
			gateway: gw,
			previewRepo: "o/r",
			maxPreviews: 6,
		});
		const ok = await svc.launch({ name: "feat-x" });
		expect(ok.ok).toBe(true);
		// Same list at cap=3 → refused.
		const capped = new ApplicationVclusterPreviewService({
			gateway: gw,
			previewRepo: "o/r",
			maxPreviews: 3,
		});
		const refused = await capped.launch({ name: "feat-x" });
		expect(refused.ok).toBe(false);
	});

	it("classifies a sleep 409 into protected vs pool-member", async () => {
		const protectedGw = gateway({
			sleep: vi.fn(async () => ({ ok: false as const, status: 409, detail: "preview is protected" })),
		});
		const poolGw = gateway({
			sleep: vi.fn(async () => ({
				ok: false as const,
				status: 409,
				detail: "free pool members stay claim-ready (never slept)",
			})),
		});
		expect(await service(protectedGw).sleep("p")).toEqual({
			ok: false,
			reason: "protected",
			message: "preview is protected",
		});
		expect(await service(poolGw).sleep("m")).toEqual({
			ok: false,
			reason: "pool-member",
			message: "free pool members stay claim-ready (never slept)",
		});
	});

	it("throws on a non-409 sleep failure", async () => {
		const gw = gateway({
			sleep: vi.fn(async () => ({ ok: false as const, status: 500, detail: "sleep failed" })),
		});
		await expect(service(gw).sleep("x")).rejects.toThrow("sleep failed");
	});

	it("wake returns the resume flag from a touch", async () => {
		const gw = gateway({
			touch: vi.fn(async (name: string) => ({
				name,
				state: "slept",
				resuming: true,
				lastActive: "2026-07-05T00:00:00Z",
			})),
		});
		expect(await service(gw).wake("feat-x")).toEqual({
			name: "feat-x",
			state: "slept",
			resuming: true,
		});
	});
});
