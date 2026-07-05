import type {
	PrPreviewClusterPort,
	PrPreviewDevPodPort,
	PrPreviewPullRequestPort,
	PrPreviewRecord,
	PrPreviewRecordStore,
	PrPreviewRegistryEntry,
	PrPreviewSeedPort,
	PrPreviewSeedTarget,
	PrPreviewStatus,
	PrPreviewVerifyPort,
} from "$lib/server/application/ports";

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_READY_TIMEOUT_MS = 900_000;
const DEFAULT_TTL_HOURS = 24;
const DEFAULT_VERIFY_TIMEOUT_MS = 15 * 60_000;
/** Heartbeat cadence for the durable record while a pipeline is in flight. */
const DEFAULT_HEARTBEAT_MS = 30_000;
/** A non-terminal record whose updatedAt is older than this is considered
 * orphaned (its owner replica died mid-run) and eligible for resume. Must be
 * comfortably larger than the heartbeat. */
const DEFAULT_RESUME_STALE_MS = 120_000;
/** BFF-owned sticky marker for the D2 verify verdict comment. The main
 * `<!-- pr-preview -->` status comment is owned by the hub Tekton dispatch Task. */
export const PR_PREVIEW_VERIFY_MARKER = "<!-- pr-preview-verify -->";

export type PrPreviewUpInput = {
	prNumber: number;
	headSha: string;
	headRef?: string | null;
	/** Repo-relative changed paths; when omitted the PR gateway is queried. */
	changedFiles?: string[] | null;
	/** Resume path: reuse the services the interrupted run already computed
	 * instead of re-querying the PR gateway (whose silent failure would re-map
	 * everything onto the BFF only). */
	presetServices?: string[] | null;
	/** D2: request the Playwright-critic verify pass (still gated on the flag). */
	verify?: boolean;
};

export type PrPreviewDeps = {
	clusters: PrPreviewClusterPort;
	devPods: PrPreviewDevPodPort;
	seeder: PrPreviewSeedPort;
	pullRequests: PrPreviewPullRequestPort;
	verify: PrPreviewVerifyPort;
	/** Durable pipeline records (table `pr_previews`) — the cross-replica,
	 * rollout-surviving source of truth for `status()`, with generation-fenced
	 * writes so at most one pipeline ever owns a row. */
	store: PrPreviewRecordStore;
	/** Changed-path → service mapping table (from the dev-preview registry). */
	registry: PrPreviewRegistryEntry[];
	/** Deterministic per-preview sync token (stable across re-seeds — adopted
	 * pods keep the token they were provisioned with). */
	syncToken: (alias: string) => string;
	/** D2 flag `PR_PREVIEW_VERIFY_ENABLED` (default off). */
	verifyEnabled?: boolean;
	ttlHours?: number;
	pollIntervalMs?: number;
	readyTimeoutMs?: number;
	verifyTimeoutMs?: number;
	heartbeatMs?: number;
	resumeStaleMs?: number;
};

export function prPreviewAlias(prNumber: number): string {
	return `pr-${prNumber}`;
}

function log(prNumber: number, stage: string, detail?: string) {
	console.info(`[pr-preview] pr=${prNumber} ${stage}${detail ? ` ${detail}` : ""}`);
}

function logError(prNumber: number, stage: string, err: unknown) {
	console.error(
		`[pr-preview] pr=${prNumber} ${stage} FAILED: ${
			err instanceof Error ? err.message : String(err)
		}`,
	);
}

/** Thrown by fenced writes when the pipeline's generation lost the row (a newer
 * up/resume took over, or down() deleted it): abort, write nothing further. */
class PrPreviewDeposedError extends Error {
	constructor(prNumber: number) {
		super(`pr-preview pr=${prNumber} pipeline deposed (newer owner or torn down)`);
		this.name = "PrPreviewDeposedError";
	}
}

/**
 * Map a PR's changed paths to dev-preview services: longest matching
 * `repoSubdir` prefix wins per file (the BFF's `.` root matches everything at
 * length 0, so `services/<x>/…` files land on their own service). Empty/unknown
 * input defaults to the BFF only.
 */
export function mapChangedFilesToServices(
	changedFiles: string[] | null | undefined,
	registry: PrPreviewRegistryEntry[],
	fallbackService = "workflow-builder",
): string[] {
	if (!changedFiles?.length) return [fallbackService];
	const services = new Set<string>();
	for (const file of changedFiles) {
		let best: { service: string; depth: number } | null = null;
		for (const entry of registry) {
			const sub = entry.repoSubdir === "." ? "" : entry.repoSubdir.replace(/\/+$/, "");
			if (sub && file !== sub && !file.startsWith(`${sub}/`)) continue;
			const depth = sub.length;
			if (!best || depth > best.depth) best = { service: entry.service, depth };
		}
		if (best) services.add(best.service);
	}
	if (services.size === 0) return [fallbackService];
	return [...services];
}

/**
 * Label-gated per-PR previews (D1): idempotent `up` (provision-or-reuse + PR-head
 * re-seed), capacity-aware claim-first launch, `down` teardown by alias, and the
 * flagged D2 verify dispatch. `up`/`down` return immediately; the heavy pipeline
 * runs detached and is observed via `status()` (polled by the hub Tekton Task).
 *
 * State lives in the generation-fenced durable record store, NOT in this
 * instance: the dispatch Task's polls are conntrack-pinned to one BFF replica
 * while the pipeline runs on whichever replica took the up, and a Deployment
 * rollout can kill the pipeline mid-run. Ownership rules:
 *
 * - Every `up` bumps the row's generation — LATEST PUSH WINS. Any pipeline
 *   still running for an older generation (same or other replica) aborts at
 *   its next fenced write instead of clobbering the winner's state.
 * - The owner heartbeats its record; `status()` on any replica atomically
 *   claims a stale non-terminal record (`claimStale` bumps the generation, so
 *   even a merely-stalled previous owner is fenced out) and resumes the
 *   idempotent pipeline with the services the interrupted run computed.
 * - `down()` deletes the row; every fenced write from any surviving pipeline
 *   then fails → abort. A zombie preview from the narrow claim window is
 *   reaped by the SEA TTL/GC backstop (PR previews carry ttlHours).
 */
export class ApplicationPrPreviewService {
	/** Local task handles for settled() (tests); ownership lives in the store. */
	private readonly inFlight = new Map<number, Promise<void>>();

	constructor(private readonly deps: PrPreviewDeps) {}

	/** Start (or refresh) the preview for a PR. Returns the current snapshot;
	 * the provision/seed pipeline continues in the background. A concurrent
	 * older run (rapid synchronize pushes, either replica) is deposed by the
	 * generation bump and aborts at its next write. */
	async up(input: PrPreviewUpInput): Promise<PrPreviewStatus> {
		const prNumber = input.prNumber;
		const alias = prPreviewAlias(prNumber);
		const existing = await this.deps.store.get(prNumber);
		// Persist (and take ownership) BEFORE dispatching so every replica sees
		// `provisioning` immediately (the pending commit status reads through here).
		const record = await this.deps.store.upsert({
			prNumber,
			alias,
			url: existing?.url ?? null,
			state: "provisioning",
			headSha: input.headSha,
			services: existing?.services ?? [],
			error: null,
			verify: null,
		});
		log(prNumber, "up:accepted", `head=${input.headSha.slice(0, 10)} gen=${record.gen}`);
		this.dispatch(input, record);
		return this.snapshot(prNumber);
	}

	/** Tear down the PR's preview (idempotent — absent is fine). Deleting the
	 * record fences out any in-flight pipeline (its next write fails → abort);
	 * the dispatcher's HTTP budget is short so we never wait for one. */
	async down(input: { prNumber: number }): Promise<{ state: "down" | "absent" }> {
		const alias = prPreviewAlias(input.prNumber);
		await this.deps.store.delete(input.prNumber);
		const exists = await this.deps.clusters.get(alias).catch(() => null);
		if (!exists) {
			log(input.prNumber, "down", "(already absent)");
			return { state: "absent" };
		}
		await this.deps.clusters.teardown(alias);
		log(input.prNumber, "down", "teardown dispatched");
		return { state: "down" };
	}

	/** Current state of the PR's preview from the durable record (any replica),
	 * else derived from the cluster. A stale non-terminal record — its owner
	 * died or stalled mid-run — is atomically claimed and its pipeline resumed
	 * here, so the dispatcher's next polls converge instead of pending forever. */
	async status(prNumber: number): Promise<PrPreviewStatus> {
		const record = await this.deps.store.get(prNumber);
		if (record) {
			await this.maybeResume(record);
			return this.snapshot(prNumber);
		}
		const alias = prPreviewAlias(prNumber);
		const info = await this.deps.clusters.get(alias).catch(() => null);
		return {
			prNumber,
			alias,
			url: info?.url ?? null,
			// ready MUST map to a terminal state for the dispatcher's poll; a
			// record-less ready preview (e.g. records wiped out-of-band) is ready.
			state: info ? (info.ready ? "ready" : "provisioning") : "absent",
			headSha: null,
			services: [],
			error: null,
			verify: null,
			updatedAt: null,
		};
	}

	/** Await the in-flight pipeline for a PR (test/synchronization hook). */
	async settled(prNumber: number): Promise<void> {
		await this.inFlight.get(prNumber)?.catch(() => {});
	}

	/** Resume an orphaned pipeline: non-terminal record with no heartbeat for
	 * `resumeStaleMs`. `claimStale` bumps the generation — exactly one replica
	 * becomes the new owner AND a merely-stalled previous owner is fenced out.
	 * The pipeline is idempotent (existing preview reused, recorded head
	 * re-seeded into the services the interrupted run computed). */
	private async maybeResume(record: PrPreviewRecord): Promise<void> {
		if (record.state !== "provisioning" && record.state !== "seeding") return;
		if (!record.headSha) return;
		const staleMs = this.deps.resumeStaleMs ?? DEFAULT_RESUME_STALE_MS;
		if (Date.now() - Date.parse(record.updatedAt) < staleMs) return;
		const claimed = await this.deps.store
			.claimStale(record.prNumber, staleMs)
			.catch(() => null);
		if (!claimed) return;
		log(
			record.prNumber,
			"resume:claimed",
			`state=${claimed.state} head=${claimed.headSha} gen=${claimed.gen}`,
		);
		this.dispatch(
			{
				prNumber: claimed.prNumber,
				headSha: claimed.headSha ?? record.headSha,
				presetServices: claimed.services.length ? claimed.services : null,
				// The original verify request is not persisted; verify is flagged
				// and best-effort, so a resumed run skips it.
				verify: false,
			},
			claimed,
		);
	}

	/** Kick the detached pipeline with a heartbeat keeping the record fresh
	 * (fresh = not claimable by another replica's resume). The catch handler
	 * never rejects — an unhandled rejection here would kill the BFF process. */
	private dispatch(input: PrPreviewUpInput, record: PrPreviewRecord): void {
		const prNumber = input.prNumber;
		const heartbeat = setInterval(
			() => {
				void this.deps.store
					.patch(prNumber, record.gen, {})
					.then((owned) => {
						if (!owned) {
							log(prNumber, "heartbeat:deposed", `gen=${record.gen}`);
							clearInterval(heartbeat);
						}
					})
					.catch(() => {});
			},
			this.deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
		);
		// Never keep the process alive for a background heartbeat (Node-only API).
		(heartbeat as unknown as { unref?: () => void }).unref?.();
		const task = this.runUp(input, record)
			.catch(async (err) => {
				if (err instanceof PrPreviewDeposedError) {
					// A newer up/resume owns the row (or down() removed it): their
					// pipeline reports; this one just stops.
					log(prNumber, "pipeline:deposed", `gen=${record.gen}`);
					return;
				}
				logError(prNumber, `stage=${record.state}`, err);
				try {
					await this.deps.store.patch(prNumber, record.gen, {
						state: "error",
						error: err instanceof Error ? err.message : String(err),
					});
				} catch (patchErr) {
					// Best effort — swallowing keeps the task promise resolved (an
					// unhandled rejection would crash the replica).
					logError(prNumber, "error-state write", patchErr);
				}
			})
			.finally(() => {
				clearInterval(heartbeat);
				if (this.inFlight.get(prNumber) === task) this.inFlight.delete(prNumber);
			});
		this.inFlight.set(prNumber, task);
	}

	private async snapshot(prNumber: number): Promise<PrPreviewStatus> {
		const r = await this.deps.store.get(prNumber);
		if (!r) {
			return {
				prNumber,
				alias: prPreviewAlias(prNumber),
				url: null,
				state: "absent",
				headSha: null,
				services: [],
				error: null,
				verify: null,
				updatedAt: null,
			};
		}
		return {
			prNumber: r.prNumber,
			alias: r.alias,
			url: r.url,
			state: r.state,
			headSha: r.headSha,
			services: [...r.services],
			error: r.error,
			verify: r.verify,
			updatedAt: r.updatedAt,
		};
	}

	/** Fenced stage write: mutate the local record (in-run reads) AND persist.
	 * Throws PrPreviewDeposedError when the row moved on without us. `{}` is
	 * the pure ownership probe (used right before the seed POST). */
	private async patch(record: PrPreviewRecord, changes: Partial<PrPreviewRecord>) {
		Object.assign(record, changes, { updatedAt: new Date().toISOString() });
		const { prNumber: _pr, gen: _gen, updatedAt: _ts, ...rest } = changes;
		const owned = await this.deps.store.patch(record.prNumber, record.gen, rest);
		if (!owned) throw new PrPreviewDeposedError(record.prNumber);
	}

	private async runUp(input: PrPreviewUpInput, record: PrPreviewRecord): Promise<void> {
		const deps = this.deps;
		const alias = record.alias;
		const prNumber = input.prNumber;

		// 1. Changed paths → services (registry repoSubdir longest-prefix). A
		// resume reuses the interrupted run's mapping (presetServices).
		const services =
			input.presetServices?.length
				? input.presetServices
				: mapChangedFilesToServices(
						input.changedFiles ??
							(await deps.pullRequests.listChangedFiles(prNumber).catch(() => null)),
						deps.registry,
					);
		await this.patch(record, { services });
		log(prNumber, "stage=services", services.join(","));

		// 2. Ensure the Tier-2 preview exists (idempotent: an existing preview —
		// ready or still booting — is reused; synchronize only re-seeds).
		const launch = {
			alias,
			prNumber,
			ttlHours: deps.ttlHours ?? DEFAULT_TTL_HOURS,
		};
		let info = await deps.clusters.get(alias);
		if (!info) {
			const claimed = await deps.clusters.claim(launch);
			if (claimed) {
				log(prNumber, "stage=claimed", `url=${claimed.url ?? "pending"}`);
			} else {
				const admitted = await this.admitColdProvision(launch);
				if (!admitted) {
					log(prNumber, "stage=capacity_full");
					await this.patch(record, {
						state: "capacity_full",
						error: "preview capacity is full (no free slot after PR-origin reap)",
					});
					return;
				}
				log(prNumber, "stage=cold-provisioned");
			}
		} else {
			log(prNumber, "stage=reusing", `phase=${info.phase}`);
		}

		// 3. Wait for readiness (pool claims are near-instant; cold ≈ 5 min).
		info = await this.waitReady(alias);
		await this.patch(record, { url: info.url });
		log(prNumber, "stage=cluster-ready", `url=${info.url ?? "n/a"}`);

		// 4. Adopt dev-mode pods for the mapped services inside the preview.
		await this.patch(record, { state: "seeding" });
		const syncToken = deps.syncToken(alias);
		const previewUrl = info.url ?? `https://wfb-${alias}.tail286401.ts.net`;
		const pods = await deps.devPods.provision({
			previewUrl,
			alias,
			services,
			syncToken,
		});
		const targets: PrPreviewSeedTarget[] = [];
		const podErrors: string[] = [];
		for (const pod of pods) {
			const entry = deps.registry.find((e) => e.service === pod.service);
			if (pod.ok && pod.podIp && pod.syncPort && entry) {
				targets.push({
					service: pod.service,
					repoSubdir: entry.repoSubdir,
					syncPaths: entry.syncPaths,
					extraSync: entry.extraSync,
					podIp: pod.podIp,
					syncPort: pod.syncPort,
				});
			} else {
				podErrors.push(`${pod.service}: ${pod.error ?? "no pod address"}`);
			}
		}
		log(
			prNumber,
			"stage=dev-pods",
			`ok=${targets.length}/${pods.length}${podErrors.length ? ` errors=[${podErrors.join("; ")}]` : ""}`,
		);
		if (targets.length === 0) {
			throw new Error(
				`no dev-mode pod came up for ${services.join(", ")}${
					podErrors.length ? ` (${podErrors.join("; ")})` : ""
				}`,
			);
		}

		// 5. Seed the PR head into every adopted pod (/__sync). The ownership
		// probe just before the POST keeps a deposed pipeline from overwriting a
		// newer run's freshly-seeded pods (the widest un-fenced gap otherwise).
		await this.patch(record, {});
		const seeded = await deps.seeder.seed({
			prNumber,
			headSha: input.headSha,
			targets,
			syncToken,
		});
		if (!seeded.ok) {
			throw new Error(seeded.detail ?? "PR-head seed failed");
		}
		await this.patch(record, {
			state: "ready",
			headSha: input.headSha,
			error: podErrors.length ? `partial: ${podErrors.join("; ")}` : null,
		});
		log(prNumber, "stage=ready", `head=${input.headSha.slice(0, 10)}`);

		// 6. D2: flagged Playwright-critic verify against the preview URL.
		if (deps.verifyEnabled && input.verify !== false) {
			await this.runVerify(record, previewUrl, input);
		}
	}

	/** Cold-provision admission: on a full cluster ask SEA to reap the oldest
	 * PR-origin preview ONCE, then retry once (contract with the SEA lifecycle
	 * sibling). Human previews are never evicted — that policy lives in SEA. */
	private async admitColdProvision(launch: {
		alias: string;
		prNumber: number;
		ttlHours: number;
	}): Promise<boolean> {
		const attempt = async (): Promise<"ok" | "capacity"> => {
			const counts = await this.deps.clusters.counts().catch(() => null);
			if (counts && counts.awake >= counts.max) return "capacity";
			const res = await this.deps.clusters.provision(launch);
			if (res.ok) return "ok";
			if (res.capacity) return "capacity";
			throw new Error(res.detail);
		};
		if ((await attempt()) === "ok") return true;
		await this.deps.clusters.reap().catch(() => false);
		return (await attempt()) === "ok";
	}

	private async waitReady(alias: string) {
		const interval = this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		const deadline = Date.now() + (this.deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
		for (;;) {
			const info = await this.deps.clusters.get(alias);
			if (info?.ready) return info;
			if (info?.phase === "failed") {
				throw new Error(`preview ${alias} provision failed`);
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`preview ${alias} not ready after ${Math.round(
						(this.deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS) / 1000,
					)}s (phase=${info?.phase ?? "absent"})`,
				);
			}
			await new Promise((r) => setTimeout(r, interval));
		}
	}

	private async runVerify(
		record: PrPreviewRecord,
		previewUrl: string,
		input: PrPreviewUpInput,
	): Promise<void> {
		const deps = this.deps;
		try {
			const started = await deps.verify.start({
				prNumber: input.prNumber,
				previewUrl,
				headSha: input.headSha,
			});
			if (!started.started) {
				await this.patch(record, {
					verify: {
						state: "skipped",
						executionId: null,
						reason: started.reason ?? "verify unavailable",
						verdict: null,
					},
				});
				return;
			}
			await this.patch(record, {
				verify: {
					state: "started",
					executionId: started.executionId ?? null,
					reason: null,
					verdict: null,
				},
			});
			log(input.prNumber, "stage=verify-started", started.executionId ?? "");
			const result = await deps.verify.waitForVerdict({
				executionId: started.executionId ?? "",
				timeoutMs: deps.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
			});
			const ok = result.status === "completed";
			await this.patch(record, {
				verify: {
					state: ok ? "completed" : "failed",
					executionId: started.executionId ?? null,
					reason: ok ? null : `verify run ${result.status}`,
					verdict: result.verdict,
				},
			});
			log(input.prNumber, "stage=verify-done", result.status);
			await deps.pullRequests.upsertStickyComment({
				prNumber: input.prNumber,
				marker: PR_PREVIEW_VERIFY_MARKER,
				body: [
					PR_PREVIEW_VERIFY_MARKER,
					`### Preview verify (Playwright critic)`,
					``,
					`- Preview: ${previewUrl}`,
					`- Head: \`${input.headSha}\``,
					`- Run: ${started.executionId ?? "n/a"} — **${result.status}**`,
					``,
					result.verdict ?? "_no verdict output_",
				].join("\n"),
			});
		} catch (err) {
			if (err instanceof PrPreviewDeposedError) throw err;
			// Verify is best-effort: never fail a ready preview over it.
			logError(input.prNumber, "stage=verify", err);
			await this.patch(record, {
				verify: {
					state: "failed",
					executionId: record.verify?.executionId ?? null,
					reason: err instanceof Error ? err.message : String(err),
					verdict: null,
				},
			});
		}
	}
}
