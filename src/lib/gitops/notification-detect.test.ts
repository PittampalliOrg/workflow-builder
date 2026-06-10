import { describe, expect, it } from "vitest";

import {
	DEGRADED_CONFIRM_STREAK,
	detect,
	isFailedBuild,
	liveTagsFor,
	migrateV1,
	PROMOTION_STUCK_MS,
	type DetectState,
	type InventoryApp,
	type InventoryEnv,
} from "./notification-detect";

const NOW = Date.parse("2026-06-10T12:00:00Z");

function snapshot(apps: InventoryApp[]): InventoryEnv[] {
	return [{ name: "dev", applications: apps }];
}

function app(overrides: Partial<InventoryApp> = {}): InventoryApp {
	return {
		component: "workflow-builder",
		desired: { image: "ghcr.io/pittampalliorg/workflow-builder:git-aaa" },
		live: {
			images: ["ghcr.io/pittampalliorg/workflow-builder:git-aaa"],
			syncStatus: "Synced",
			healthStatus: "Healthy",
		},
		build: null,
		promotion: null,
		...overrides,
	};
}

/** Run detect over a sequence of snapshots (first = baseline), return all fresh. */
function run(snapshots: InventoryEnv[][], times?: number[]) {
	let state: DetectState = new Map();
	const all: ReturnType<typeof detect>["fresh"][] = [];
	snapshots.forEach((envs, i) => {
		const { next, fresh } = detect(state, envs, times?.[i] ?? NOW + i * 60_000, i === 0);
		state = next;
		all.push(fresh);
	});
	return { state, all };
}

describe("baseline rule", () => {
	it("never notifies on the baseline snapshot, even when already failed/degraded/stuck", () => {
		const { all } = run([
			snapshot([
				app({
					live: { images: ["ghcr.io/pittampalliorg/workflow-builder:git-aaa"], syncStatus: "Synced", healthStatus: "Degraded" },
					build: { pipelineRun: "pr-1", status: "False", reason: "Failed" },
					promotion: { drySha: "d1", hydratedSha: null, healthPhase: "Failure" },
				}),
			]),
		]);
		expect(all[0]).toEqual([]);
	});

	it("never notifies for a component first seen mid-session", () => {
		const { all } = run([
			snapshot([app()]),
			snapshot([app(), app({ component: "new-svc", desired: { image: "ghcr.io/pittampalliorg/new-svc:git-zzz" }, live: { images: ["ghcr.io/pittampalliorg/new-svc:git-zzz"], syncStatus: "Synced", healthStatus: "Healthy" } })]),
		]);
		expect(all[1]).toEqual([]);
	});
});

describe("deploy", () => {
	it("fires once for a new tag while Synced, with v1-compatible id", () => {
		const { all } = run([
			snapshot([app()]),
			snapshot([
				app({ live: { images: ["ghcr.io/pittampalliorg/workflow-builder:git-bbb"], syncStatus: "Synced", healthStatus: "Healthy" } }),
			]),
		]);
		expect(all[1]).toHaveLength(1);
		expect(all[1][0]).toMatchObject({
			id: "dev:workflow-builder:git-bbb",
			kind: "deploy",
			severity: "info",
			fromTag: "git-aaa",
			toTag: "git-bbb",
		});
	});

	it("does not fire while OutOfSync", () => {
		const { all } = run([
			snapshot([app()]),
			snapshot([
				app({ live: { images: ["ghcr.io/pittampalliorg/workflow-builder:git-bbb"], syncStatus: "OutOfSync", healthStatus: "Healthy" } }),
			]),
		]);
		expect(all[1]).toEqual([]);
	});

	it("fires once for the new tag during old+new coexistence; no-op on same-tag resync", () => {
		const both = app({
			live: {
				images: [
					"ghcr.io/pittampalliorg/workflow-builder:git-aaa",
					"ghcr.io/pittampalliorg/workflow-builder:git-bbb",
				],
				syncStatus: "Synced",
				healthStatus: "Healthy",
			},
		});
		const { all } = run([snapshot([app()]), snapshot([both]), snapshot([both])]);
		expect(all[1].map((n) => n.toTag)).toEqual(["git-bbb"]);
		expect(all[2]).toEqual([]);
	});
});

describe("build_failed", () => {
	const okBuild = { pipelineRun: "pr-1", status: "True", reason: "Succeeded" };
	const badBuild = { pipelineRun: "pr-2", status: "False", reason: "Failed" };

	it("fires on the transition into failed", () => {
		const { all } = run([
			snapshot([app({ build: okBuild })]),
			snapshot([app({ build: badBuild })]),
		]);
		expect(all[1]).toHaveLength(1);
		expect(all[1][0]).toMatchObject({
			id: "build_failed:dev:workflow-builder:pr-2",
			kind: "build_failed",
			severity: "error",
			detail: "pr-2 · Failed",
		});
	});

	it("fires once while the same failed run persists", () => {
		const { all } = run([
			snapshot([app({ build: okBuild })]),
			snapshot([app({ build: badBuild })]),
			snapshot([app({ build: badBuild })]),
		]);
		expect(all[1]).toHaveLength(1);
		expect(all[2]).toEqual([]);
	});

	it("fires again for a NEW failing run", () => {
		const badBuild2 = { pipelineRun: "pr-3", status: "False", reason: "Failed" };
		const { all } = run([
			snapshot([app({ build: badBuild })]),
			snapshot([app({ build: badBuild2 })]),
		]);
		expect(all[1]).toHaveLength(1);
		expect(all[1][0].id).toBe("build_failed:dev:workflow-builder:pr-3");
	});

	it("no-ops on success transitions", () => {
		const { all } = run([
			snapshot([app({ build: { pipelineRun: "pr-1", status: "Unknown", reason: "Running" } })]),
			snapshot([app({ build: okBuild })]),
		]);
		expect(all[1]).toEqual([]);
	});
});

describe("degraded", () => {
	const degraded = () =>
		app({ live: { images: ["ghcr.io/pittampalliorg/workflow-builder:git-aaa"], syncStatus: "Synced", healthStatus: "Degraded" } });

	it("requires the confirm streak, then fires exactly once per episode", () => {
		const { all } = run([
			snapshot([app()]),
			snapshot([degraded()]), // streak 1 — no-op
			snapshot([degraded()]), // streak 2 — fires
			snapshot([degraded()]), // streak 3 — silent
		]);
		expect(all[1]).toEqual([]);
		expect(all[2]).toHaveLength(1);
		expect(all[2][0]).toMatchObject({ kind: "degraded", severity: "error" });
		expect(all[3]).toEqual([]);
		expect(DEGRADED_CONFIRM_STREAK).toBe(2);
	});

	it("never fires on alternating Healthy/Degraded flaps", () => {
		const { all } = run([
			snapshot([app()]),
			snapshot([degraded()]),
			snapshot([app()]),
			snapshot([degraded()]),
			snapshot([app()]),
		]);
		expect(all.flat()).toEqual([]);
	});

	it("a recovery + re-degrade episode produces the same id (window-dedupe documented)", () => {
		const { all } = run([
			snapshot([app()]),
			snapshot([degraded()]),
			snapshot([degraded()]),
			snapshot([app()]),
			snapshot([degraded()]),
			snapshot([degraded()]),
		]);
		const fired = all.flat();
		expect(fired).toHaveLength(2);
		expect(fired[0].id).toBe(fired[1].id);
	});
});

describe("promotion_stuck", () => {
	it("fires immediately on a failed phase", () => {
		const { all } = run([
			snapshot([app({ promotion: { drySha: "d1", hydratedSha: null, healthPhase: "Pending" } })]),
			snapshot([app({ promotion: { drySha: "d1", hydratedSha: null, healthPhase: "Failure" } })]),
		]);
		expect(all[1]).toHaveLength(1);
		expect(all[1][0]).toMatchObject({
			id: "promotion_stuck:dev:workflow-builder:d1",
			kind: "promotion_stuck",
			severity: "error",
			title: "promotion failed",
		});
	});

	it("fires stuck only past the threshold, once per drySha", () => {
		const pending = app({ promotion: { drySha: "d1", hydratedSha: null, healthPhase: "Pending" } });
		const t0 = NOW;
		const { all } = run(
			[
				snapshot([app()]),
				snapshot([pending]), // non-passing since t1
				snapshot([pending]), // 14 min in — no-op
				snapshot([pending]), // 16 min in — fires
				snapshot([pending]), // still stuck — silent (same drySha)
			],
			[t0, t0 + 60_000, t0 + 60_000 + 14 * 60_000, t0 + 60_000 + PROMOTION_STUCK_MS + 60_000, t0 + 60_000 + PROMOTION_STUCK_MS + 2 * 60_000],
		);
		expect(all[1]).toEqual([]);
		expect(all[2]).toEqual([]);
		expect(all[3]).toHaveLength(1);
		expect(all[3][0]).toMatchObject({ title: "promotion stuck", severity: "warning" });
		expect(all[4]).toEqual([]);
	});

	it("passing resets the clock; a new drySha stuck again re-fires", () => {
		const t0 = NOW;
		const stuck = (sha: string) =>
			app({ promotion: { drySha: sha, hydratedSha: null, healthPhase: "Pending" } });
		const passing = app({ promotion: { drySha: "d1", hydratedSha: null, healthPhase: "Healthy" } });
		const { all } = run(
			[
				snapshot([app()]),
				snapshot([stuck("d1")]),
				snapshot([stuck("d1")]),
				snapshot([passing]), // resets
				snapshot([stuck("d2")]), // new freight, non-passing since here
				snapshot([stuck("d2")]), // past threshold — fires for d2
			],
			[
				t0,
				t0 + 60_000,
				t0 + 60_000 + PROMOTION_STUCK_MS + 60_000, // fires for d1
				t0 + 60_000 + PROMOTION_STUCK_MS + 2 * 60_000,
				t0 + 60_000 + PROMOTION_STUCK_MS + 3 * 60_000,
				t0 + 60_000 + 2 * (PROMOTION_STUCK_MS + 3 * 60_000),
			],
		);
		const fired = all.flat();
		expect(fired).toHaveLength(2);
		expect(fired[0].id).toContain(":d1");
		expect(fired[1].id).toContain(":d2");
	});
});

describe("id stability", () => {
	it("re-running detect over identical snapshots yields zero fresh notifications", () => {
		const snap = snapshot([
			app({
				build: { pipelineRun: "pr-2", status: "False", reason: "Failed" },
				live: { images: ["ghcr.io/pittampalliorg/workflow-builder:git-aaa"], syncStatus: "Synced", healthStatus: "Degraded" },
			}),
		]);
		const { all } = run([snap, snap, snap, snap]);
		// degraded fires once (streak confirm at snapshot 3); nothing else ever.
		expect(all.flat().map((n) => n.kind)).toEqual(["degraded"]);
	});
});

describe("helpers", () => {
	it("liveTagsFor matches only the component's own repo", () => {
		expect(
			[...liveTagsFor(
				app({
					live: {
						images: [
							"ghcr.io/pittampalliorg/workflow-builder:git-aaa",
							"ghcr.io/dapr/daprd:1.17.9",
							"docker.io/library/postgres:16",
						],
						syncStatus: "Synced",
						healthStatus: "Healthy",
					},
				}),
			)],
		).toEqual(["git-aaa"]);
	});

	it("isFailedBuild matches AttentionBanner vocabulary exactly", () => {
		expect(isFailedBuild({ pipelineRun: "p", status: "False", reason: null })).toBe(true);
		expect(isFailedBuild({ pipelineRun: "p", status: null, reason: "Failed" })).toBe(true);
		expect(isFailedBuild({ pipelineRun: "p", status: null, reason: "Failure" })).toBe(true);
		expect(isFailedBuild({ pipelineRun: "p", status: "True", reason: "Succeeded" })).toBe(false);
		expect(isFailedBuild(null)).toBe(false);
	});

	it("migrateV1 maps deploy entries and drops malformed rows", () => {
		const migrated = migrateV1([
			{ id: "dev:svc:git-a", component: "svc", env: "dev", fromTag: null, toTag: "git-a", at: 5, read: true },
			{ not: "valid" },
			null,
		]);
		expect(migrated).toHaveLength(1);
		expect(migrated[0]).toMatchObject({
			id: "dev:svc:git-a",
			kind: "deploy",
			severity: "info",
			toTag: "git-a",
			read: true,
		});
	});
});
