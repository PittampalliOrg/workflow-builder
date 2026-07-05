import { describe, expect, it } from "vitest";
import {
	ApplicationPrPreviewService,
	mapChangedFilesToServices,
	prPreviewAlias,
	PR_PREVIEW_VERIFY_MARKER,
	type PrPreviewDeps,
} from "$lib/server/application/pr-previews";
import { InMemoryPrPreviewRecordStore } from "$lib/server/application/adapters/pr-preview-records";
import type {
	PrPreviewClusterInfo,
	PrPreviewClusterPort,
	PrPreviewDevPodPort,
	PrPreviewPullRequestPort,
	PrPreviewRegistryEntry,
	PrPreviewSeedPort,
	PrPreviewVerifyPort,
} from "$lib/server/application/ports";

const REGISTRY: PrPreviewRegistryEntry[] = [
	{
		service: "workflow-builder",
		repoSubdir: ".",
		syncPaths: ["src", "services/shared/workflow-data-contract"],
		extraSync: [],
	},
	{
		service: "workflow-orchestrator",
		repoSubdir: "services/workflow-orchestrator",
		syncPaths: ["app.py", "core"],
		extraSync: [{ from: "../shared/workflow-data-contract", to: ".contract-fixtures" }],
	},
];

const READY: PrPreviewClusterInfo = {
	ready: true,
	phase: "ready",
	url: "https://wfb-pr-7.tail286401.ts.net",
};

type Calls = {
	claim: number;
	provision: number;
	reap: number;
	teardown: string[];
	devPods: Array<{ services: string[]; previewUrl: string; syncToken: string }>;
	seeds: Array<{ headSha: string; services: string[]; syncToken: string }>;
	comments: Array<{ marker: string; body: string }>;
	verifyStarts: number;
};

function makeDeps(overrides?: {
	/** Sequential answers for clusters.get (last repeats). */
	getSequence?: Array<PrPreviewClusterInfo | null>;
	claim?: PrPreviewClusterInfo | null;
	counts?: Array<{ awake: number; max: number } | null>;
	provisionCapacity?: boolean;
	reapResult?: boolean;
	podOk?: boolean;
	seedOk?: boolean;
	verifyEnabled?: boolean;
	verifyStarted?: boolean;
	changedFiles?: string[] | null;
	resumeStaleMs?: number;
	/** Awaited inside devPods.provision — lets tests hold a pipeline mid-flight. */
	podGate?: () => Promise<void>;
}): { deps: PrPreviewDeps; calls: Calls; store: InMemoryPrPreviewRecordStore } {
	const calls: Calls = {
		claim: 0,
		provision: 0,
		reap: 0,
		teardown: [],
		devPods: [],
		seeds: [],
		comments: [],
		verifyStarts: 0,
	};
	const getSequence = overrides?.getSequence ?? [null, READY];
	let getIndex = 0;
	const countsSequence = overrides?.counts ?? [{ awake: 1, max: 6 }];
	let countsIndex = 0;
	const clusters: PrPreviewClusterPort = {
		async claim() {
			calls.claim += 1;
			return overrides?.claim ?? null;
		},
		async provision() {
			calls.provision += 1;
			if (overrides?.provisionCapacity) {
				return { ok: false, capacity: true, detail: "capacity" };
			}
			return { ok: true };
		},
		async get() {
			const value = getSequence[Math.min(getIndex, getSequence.length - 1)];
			getIndex += 1;
			return value;
		},
		async counts() {
			const value = countsSequence[Math.min(countsIndex, countsSequence.length - 1)];
			countsIndex += 1;
			return value;
		},
		async reap() {
			calls.reap += 1;
			return overrides?.reapResult ?? false;
		},
		async teardown(alias) {
			calls.teardown.push(alias);
		},
	};
	const devPods: PrPreviewDevPodPort = {
		async provision(input) {
			if (overrides?.podGate) await overrides.podGate();
			calls.devPods.push({
				services: input.services,
				previewUrl: input.previewUrl,
				syncToken: input.syncToken,
			});
			return input.services.map((service) =>
				(overrides?.podOk ?? true)
					? { service, ok: true, podIp: "10.0.0.9", syncPort: 8001 }
					: { service, ok: false, podIp: null, syncPort: null, error: "boom" },
			);
		},
	};
	const seeder: PrPreviewSeedPort = {
		async seed(input) {
			calls.seeds.push({
				headSha: input.headSha,
				services: input.targets.map((t) => t.service),
				syncToken: input.syncToken,
			});
			return (overrides?.seedOk ?? true)
				? { ok: true, detail: null }
				: { ok: false, detail: "sync rejected" };
		},
	};
	const pullRequests: PrPreviewPullRequestPort = {
		async listChangedFiles() {
			return overrides?.changedFiles ?? null;
		},
		async upsertStickyComment(input) {
			calls.comments.push({ marker: input.marker, body: input.body });
			return true;
		},
	};
	const verify: PrPreviewVerifyPort = {
		async start() {
			calls.verifyStarts += 1;
			return (overrides?.verifyStarted ?? true)
				? { started: true, executionId: "exec-1" }
				: { started: false, reason: "no critic configured" };
		},
		async waitForVerdict() {
			return { status: "completed", verdict: "LGTM — nav + composer render" };
		},
	};
	const store = new InMemoryPrPreviewRecordStore();
	return {
		deps: {
			clusters,
			devPods,
			seeder,
			pullRequests,
			verify,
			store,
			registry: REGISTRY,
			syncToken: (alias) => `token-${alias}`,
			verifyEnabled: overrides?.verifyEnabled ?? false,
			pollIntervalMs: 1,
			readyTimeoutMs: 250,
			verifyTimeoutMs: 50,
			heartbeatMs: 60_000,
			resumeStaleMs: overrides?.resumeStaleMs,
		},
		calls,
		store,
	};
}

describe("mapChangedFilesToServices", () => {
	it("maps service subdirs by longest repoSubdir prefix", () => {
		expect(
			mapChangedFilesToServices(
				["services/workflow-orchestrator/app.py", "src/routes/x/+server.ts"],
				REGISTRY,
			).sort(),
		).toEqual(["workflow-builder", "workflow-orchestrator"]);
	});

	it("keeps orchestrator-only changes off the bff", () => {
		expect(
			mapChangedFilesToServices(["services/workflow-orchestrator/core/run.py"], REGISTRY),
		).toEqual(["workflow-orchestrator"]);
	});

	it("defaults to the bff when changed files are unknown or empty", () => {
		expect(mapChangedFilesToServices(null, REGISTRY)).toEqual(["workflow-builder"]);
		expect(mapChangedFilesToServices([], REGISTRY)).toEqual(["workflow-builder"]);
	});

	it("root files land on the bff (repoSubdir '.')", () => {
		expect(mapChangedFilesToServices(["package.json"], REGISTRY)).toEqual([
			"workflow-builder",
		]);
	});
});

describe("ApplicationPrPreviewService", () => {
	it("cold-provisions, waits ready, adopts pods, seeds, and reports ready", async () => {
		const { deps, calls } = makeDeps({
			getSequence: [null, null, READY],
			changedFiles: ["src/app.ts"],
		});
		const service = new ApplicationPrPreviewService(deps);
		const accepted = await service.up({ prNumber: 7, headSha: "abc123" });
		expect(accepted.state).toBe("provisioning");
		expect(accepted.alias).toBe(prPreviewAlias(7));
		await service.settled(7);
		const status = await service.status(7);
		expect(status.state).toBe("ready");
		expect(status.url).toBe(READY.url);
		expect(status.headSha).toBe("abc123");
		expect(calls.claim).toBe(1);
		expect(calls.provision).toBe(1);
		expect(calls.devPods[0]?.services).toEqual(["workflow-builder"]);
		expect(calls.devPods[0]?.syncToken).toBe("token-pr-7");
		expect(calls.seeds[0]?.headSha).toBe("abc123");
	});

	it("reports capacity_full when the pool is empty, the cluster is full, and reap frees nothing", async () => {
		const { deps, calls } = makeDeps({
			getSequence: [null],
			counts: [{ awake: 6, max: 6 }],
			reapResult: false,
		});
		const service = new ApplicationPrPreviewService(deps);
		await service.up({ prNumber: 8, headSha: "abc" });
		await service.settled(8);
		const status = await service.status(8);
		expect(status.state).toBe("capacity_full");
		expect(calls.reap).toBe(1);
		expect(calls.provision).toBe(0); // never cold-provisioned into a full cluster
	});

	it("recovers capacity via one reap and retries the cold provision once", async () => {
		const { deps, calls } = makeDeps({
			getSequence: [null, READY],
			counts: [{ awake: 6, max: 6 }, { awake: 5, max: 6 }],
			reapResult: true,
		});
		const service = new ApplicationPrPreviewService(deps);
		await service.up({ prNumber: 9, headSha: "abc" });
		await service.settled(9);
		expect((await service.status(9)).state).toBe("ready");
		expect(calls.reap).toBe(1);
		expect(calls.provision).toBe(1);
	});

	it("treats a provision-side capacity refusal (SEA 429) the same way", async () => {
		const { deps, calls } = makeDeps({
			getSequence: [null],
			counts: [null], // older SEA: no counts → provision decides
			provisionCapacity: true,
			reapResult: true,
		});
		const service = new ApplicationPrPreviewService(deps);
		await service.up({ prNumber: 10, headSha: "abc" });
		await service.settled(10);
		expect((await service.status(10)).state).toBe("capacity_full");
		expect(calls.provision).toBe(2); // initial + post-reap retry
		expect(calls.reap).toBe(1);
	});

	it("is idempotent per PR: an existing preview is re-seeded, never re-provisioned", async () => {
		const { deps, calls } = makeDeps({ getSequence: [READY] });
		const service = new ApplicationPrPreviewService(deps);
		await service.up({ prNumber: 7, headSha: "sha-1" });
		await service.settled(7);
		await service.up({ prNumber: 7, headSha: "sha-2" }); // synchronize
		await service.settled(7);
		expect(calls.claim).toBe(0);
		expect(calls.provision).toBe(0);
		expect(calls.seeds.map((s) => s.headSha)).toEqual(["sha-1", "sha-2"]);
		expect(calls.seeds[1]?.syncToken).toBe("token-pr-7"); // stable across re-seeds
		expect((await service.status(7)).headSha).toBe("sha-2");
	});

	it("maps changed paths through the registry for the dev-pod fan-out", async () => {
		const { deps, calls } = makeDeps({
			getSequence: [READY],
			changedFiles: [
				"services/workflow-orchestrator/app.py",
				"src/lib/server/foo.ts",
			],
		});
		const service = new ApplicationPrPreviewService(deps);
		await service.up({ prNumber: 7, headSha: "abc" });
		await service.settled(7);
		expect(calls.devPods[0]?.services.sort()).toEqual([
			"workflow-builder",
			"workflow-orchestrator",
		]);
		expect(calls.seeds[0]?.services.sort()).toEqual([
			"workflow-builder",
			"workflow-orchestrator",
		]);
	});

	it("errors when no dev pod comes up", async () => {
		const { deps } = makeDeps({ getSequence: [READY], podOk: false });
		const service = new ApplicationPrPreviewService(deps);
		await service.up({ prNumber: 7, headSha: "abc" });
		await service.settled(7);
		const status = await service.status(7);
		expect(status.state).toBe("error");
		expect(status.error).toContain("no dev-mode pod");
	});

	it("errors when the seed is rejected", async () => {
		const { deps } = makeDeps({ getSequence: [READY], seedOk: false });
		const service = new ApplicationPrPreviewService(deps);
		await service.up({ prNumber: 7, headSha: "abc" });
		await service.settled(7);
		expect((await service.status(7)).state).toBe("error");
	});

	it("down tears down by alias and reports absent for unknown PRs", async () => {
		const { deps, calls } = makeDeps({ getSequence: [READY] });
		const service = new ApplicationPrPreviewService(deps);
		expect(await service.down({ prNumber: 7 })).toEqual({ state: "down" });
		expect(calls.teardown).toEqual(["pr-7"]);

		const absent = makeDeps({ getSequence: [null] });
		const absentService = new ApplicationPrPreviewService(absent.deps);
		expect(await absentService.down({ prNumber: 99 })).toEqual({ state: "absent" });
		expect(absent.calls.teardown).toEqual([]);
	});

	it("verify (flag on): posts the verdict as the sticky verify comment", async () => {
		const { deps, calls } = makeDeps({ getSequence: [READY], verifyEnabled: true });
		const service = new ApplicationPrPreviewService(deps);
		await service.up({ prNumber: 7, headSha: "abc" });
		await service.settled(7);
		const status = await service.status(7);
		expect(status.verify?.state).toBe("completed");
		expect(status.verify?.verdict).toContain("LGTM");
		expect(calls.comments[0]?.marker).toBe(PR_PREVIEW_VERIFY_MARKER);
		expect(calls.comments[0]?.body).toContain(READY.url as string);
	});

	it("verify (flag on, no critic configured): records skipped, posts nothing", async () => {
		const { deps, calls } = makeDeps({
			getSequence: [READY],
			verifyEnabled: true,
			verifyStarted: false,
		});
		const service = new ApplicationPrPreviewService(deps);
		await service.up({ prNumber: 7, headSha: "abc" });
		await service.settled(7);
		expect((await service.status(7)).verify?.state).toBe("skipped");
		expect(calls.comments).toEqual([]);
	});

	it("verify (flag off): never dispatches", async () => {
		const { deps, calls } = makeDeps({ getSequence: [READY], verifyEnabled: false });
		const service = new ApplicationPrPreviewService(deps);
		await service.up({ prNumber: 7, headSha: "abc" });
		await service.settled(7);
		expect(calls.verifyStarts).toBe(0);
		expect((await service.status(7)).verify).toBeNull();
	});
});

describe("ApplicationPrPreviewService durable records (#39)", () => {
	it("status() on a DIFFERENT instance sharing the store sees the pipeline result", async () => {
		const { deps } = makeDeps({ getSequence: [READY] });
		const owner = new ApplicationPrPreviewService(deps);
		await owner.up({ prNumber: 7, headSha: "abc" });
		await owner.settled(7);
		// A second "replica": same store, fresh instance (no in-memory state).
		const peer = new ApplicationPrPreviewService(deps);
		const seen = await peer.status(7);
		expect(seen.state).toBe("ready");
		expect(seen.headSha).toBe("abc");
		expect(seen.services).toEqual(["workflow-builder"]);
	});

	it("status() resumes a stale orphaned run (owner replica died mid-run)", async () => {
		const { deps, store, calls } = makeDeps({
			getSequence: [READY],
			resumeStaleMs: 0, // everything non-terminal is immediately claimable
		});
		// Simulate a record left behind by a killed pipeline: seeding, never finished.
		await store.upsert({
			prNumber: 7,
			alias: prPreviewAlias(7),
			url: READY.url,
			state: "seeding",
			headSha: "orphan-sha",
			services: ["workflow-builder"],
			error: null,
			verify: null,
		});
		const replica = new ApplicationPrPreviewService(deps);
		await replica.status(7); // sees the stale record → claims → re-dispatches
		await replica.settled(7);
		expect((await replica.status(7)).state).toBe("ready");
		expect(calls.seeds[0]?.headSha).toBe("orphan-sha");
	});

	it("status() does NOT steal a fresh (heartbeating) run", async () => {
		const { deps, store, calls } = makeDeps({
			getSequence: [READY],
			resumeStaleMs: 60_000,
		});
		await store.upsert({
			prNumber: 7,
			alias: prPreviewAlias(7),
			url: null,
			state: "provisioning",
			headSha: "abc",
			services: [],
			error: null,
			verify: null,
		});
		const replica = new ApplicationPrPreviewService(deps);
		const seen = await replica.status(7);
		expect(seen.state).toBe("provisioning");
		await replica.settled(7);
		expect(calls.seeds).toEqual([]); // nothing dispatched
	});

	it("claimStale admits exactly one winner and terminal states are never claimed", async () => {
		const store = new InMemoryPrPreviewRecordStore();
		await store.upsert({
			prNumber: 5,
			alias: "pr-5",
			url: null,
			state: "seeding",
			headSha: "x",
			services: [],
			error: null,
			verify: null,
		});
		// staleMs 0: any non-terminal row is claimable — the first caller wins.
		const before = await store.get(5);
		const first = await store.claimStale(5, 0);
		expect(first?.prNumber).toBe(5);
		// The claim bumps the generation, fencing out the previous owner.
		expect(first!.gen).toBe(before!.gen + 1);
		expect(await store.patch(5, before!.gen, {})).toBe(false);
		// The claim bumped updatedAt: with a real threshold the second caller loses.
		expect(await store.claimStale(5, 60_000)).toBeNull();
		// Terminal records are never claimable, even when stale.
		expect(await store.patch(5, first!.gen, { state: "ready" })).toBe(true);
		expect(await store.claimStale(5, 0)).toBeNull();
	});

	it("down() deletes the durable record", async () => {
		const { deps, store } = makeDeps({ getSequence: [READY, null] });
		const service = new ApplicationPrPreviewService(deps);
		await service.up({ prNumber: 7, headSha: "abc" });
		await service.settled(7);
		await service.down({ prNumber: 7 });
		expect(await store.get(7)).toBeNull();
	});
});

describe("ApplicationPrPreviewService generation fencing", () => {
	it("a second up deposes a live older run: latest push wins, loser writes nothing", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let gated = true;
		const { deps, calls, store } = makeDeps({
			getSequence: [READY],
			podGate: () => (gated ? gate : Promise.resolve()),
		});
		const service = new ApplicationPrPreviewService(deps);
		await service.up({ prNumber: 7, headSha: "sha-old" }); // parks at devPods
		const oldRun = (service as unknown as { inFlight: Map<number, Promise<void>> })
			.inFlight.get(7)!;
		gated = false;
		await service.up({ prNumber: 7, headSha: "sha-new" }); // deposes sha-old
		await service.settled(7); // the new run
		release();
		await oldRun.catch(() => {});
		const final = await store.get(7);
		expect(final?.state).toBe("ready");
		expect(final?.headSha).toBe("sha-new"); // the deposed run could not clobber
		expect(calls.seeds.map((x) => x.headSha)).toEqual(["sha-new"]); // old aborted pre-seed
	});

	it("down during a run: the pipeline aborts, the record is not resurrected", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const { deps, calls, store } = makeDeps({
			getSequence: [READY, null],
			podGate: () => gate,
		});
		const service = new ApplicationPrPreviewService(deps);
		await service.up({ prNumber: 7, headSha: "abc" }); // parks at devPods
		await service.down({ prNumber: 7 });
		release();
		await service.settled(7);
		expect(await store.get(7)).toBeNull(); // no error-state resurrection
		expect(calls.seeds).toEqual([]); // aborted at the pre-seed ownership probe
	});

	it("resume reuses the interrupted run's services (no BFF-only re-map)", async () => {
		const { deps, store, calls } = makeDeps({
			getSequence: [READY],
			resumeStaleMs: 0,
			changedFiles: null, // gateway would re-map to the BFF fallback
		});
		await store.upsert({
			prNumber: 7,
			alias: prPreviewAlias(7),
			url: READY.url,
			state: "seeding",
			headSha: "orphan",
			services: ["workflow-builder", "workflow-orchestrator"],
			error: null,
			verify: null,
		});
		const replica = new ApplicationPrPreviewService(deps);
		await replica.status(7);
		await replica.settled(7);
		expect(calls.devPods[0]?.services.sort()).toEqual([
			"workflow-builder",
			"workflow-orchestrator",
		]);
	});

	it("a store failure in the error path never rejects the detached task", async () => {
		const { deps, store } = makeDeps({ getSequence: [READY], seedOk: false });
		const failingPatch = store.patch.bind(store);
		let patches = 0;
		store.patch = async (prNumber, gen, changes) => {
			patches += 1;
			// Fail the write that records the error state (the last one).
			if ((changes as { state?: string }).state === "error") {
				throw new Error("db down");
			}
			return failingPatch(prNumber, gen, changes);
		};
		const service = new ApplicationPrPreviewService(deps);
		await service.up({ prNumber: 7, headSha: "abc" });
		await expect(service.settled(7)).resolves.toBeUndefined(); // no rejection
		expect(patches).toBeGreaterThan(0);
	});
});
