import type {
	PrPreviewClusterPort,
	PrPreviewDevPodPort,
	PrPreviewPullRequestPort,
	PrPreviewRegistryEntry,
	PrPreviewSeedPort,
	PrPreviewSeedTarget,
	PrPreviewState,
	PrPreviewStatus,
	PrPreviewVerifyPort,
} from "$lib/server/application/ports";

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_READY_TIMEOUT_MS = 900_000;
const DEFAULT_TTL_HOURS = 24;
const DEFAULT_VERIFY_TIMEOUT_MS = 15 * 60_000;
/** BFF-owned sticky marker for the D2 verify verdict comment. The main
 * `<!-- pr-preview -->` status comment is owned by the hub Tekton dispatch Task. */
export const PR_PREVIEW_VERIFY_MARKER = "<!-- pr-preview-verify -->";

export type PrPreviewUpInput = {
	prNumber: number;
	headSha: string;
	headRef?: string | null;
	/** Repo-relative changed paths; when omitted the PR gateway is queried. */
	changedFiles?: string[] | null;
	/** D2: request the Playwright-critic verify pass (still gated on the flag). */
	verify?: boolean;
};

export type PrPreviewDeps = {
	clusters: PrPreviewClusterPort;
	devPods: PrPreviewDevPodPort;
	seeder: PrPreviewSeedPort;
	pullRequests: PrPreviewPullRequestPort;
	verify: PrPreviewVerifyPort;
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
};

type PrPreviewRecord = {
	prNumber: number;
	alias: string;
	url: string | null;
	state: PrPreviewState;
	headSha: string | null;
	services: string[];
	error: string | null;
	verify: PrPreviewStatus["verify"];
	updatedAt: string;
};

export function prPreviewAlias(prNumber: number): string {
	return `pr-${prNumber}`;
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
 */
export class ApplicationPrPreviewService {
	private readonly records = new Map<number, PrPreviewRecord>();
	private readonly inFlight = new Map<number, Promise<void>>();

	constructor(private readonly deps: PrPreviewDeps) {}

	/** Start (or refresh) the preview for a PR. Returns the current snapshot;
	 * the provision/seed pipeline continues in the background. */
	up(input: PrPreviewUpInput): PrPreviewStatus {
		const prNumber = input.prNumber;
		const alias = prPreviewAlias(prNumber);
		const existing = this.records.get(prNumber);
		if (this.inFlight.has(prNumber)) {
			// An up is already running for this PR (e.g. rapid synchronize pushes):
			// report it instead of racing a second pipeline.
			return this.snapshot(prNumber);
		}
		const record: PrPreviewRecord = {
			prNumber,
			alias,
			url: existing?.url ?? null,
			state: "provisioning",
			headSha: input.headSha,
			services: existing?.services ?? [],
			error: null,
			verify: null,
			updatedAt: new Date().toISOString(),
		};
		this.records.set(prNumber, record);
		const task = this.runUp(input, record)
			.catch((err) => {
				this.patch(record, {
					state: "error",
					error: err instanceof Error ? err.message : String(err),
				});
			})
			.finally(() => {
				this.inFlight.delete(prNumber);
			});
		this.inFlight.set(prNumber, task);
		return this.snapshot(prNumber);
	}

	/** Tear down the PR's preview (idempotent — absent is fine). Does NOT wait
	 * for an in-flight up (the dispatcher's HTTP budget is short); a racing up
	 * errors out against the vanished preview and the SEA TTL/GC backstops. */
	async down(input: { prNumber: number }): Promise<{ state: "down" | "absent" }> {
		const alias = prPreviewAlias(input.prNumber);
		this.records.delete(input.prNumber);
		const exists = await this.deps.clusters.get(alias).catch(() => null);
		if (!exists) return { state: "absent" };
		await this.deps.clusters.teardown(alias);
		return { state: "down" };
	}

	/** Current state of the PR's preview: the in-memory pipeline record when this
	 * BFF ran the up, else derived from the cluster (post-restart fallback). */
	async status(prNumber: number): Promise<PrPreviewStatus> {
		const record = this.records.get(prNumber);
		if (record) return this.snapshot(prNumber);
		const alias = prPreviewAlias(prNumber);
		const info = await this.deps.clusters.get(alias).catch(() => null);
		return {
			prNumber,
			alias,
			url: info?.url ?? null,
			// ready MUST map to a terminal state: with 2 BFF replicas the record
			// lives only on the replica that ran the up, and conntrack pins the
			// dispatcher's polls to ONE backend — a non-owner replica reporting
			// "unknown" for a ready cluster kept the commit status pending forever.
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

	private snapshot(prNumber: number): PrPreviewStatus {
		const r = this.records.get(prNumber);
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
		return { ...r, services: [...r.services] };
	}

	private patch(record: PrPreviewRecord, changes: Partial<PrPreviewRecord>) {
		Object.assign(record, changes, { updatedAt: new Date().toISOString() });
	}

	private async runUp(input: PrPreviewUpInput, record: PrPreviewRecord): Promise<void> {
		const deps = this.deps;
		const alias = record.alias;

		// 1. Changed paths → services (registry repoSubdir longest-prefix).
		const changed =
			input.changedFiles ??
			(await deps.pullRequests.listChangedFiles(input.prNumber).catch(() => null));
		const services = mapChangedFilesToServices(changed, deps.registry);
		this.patch(record, { services });

		// 2. Ensure the Tier-2 preview exists (idempotent: an existing preview —
		// ready or still booting — is reused; synchronize only re-seeds).
		const launch = {
			alias,
			prNumber: input.prNumber,
			ttlHours: deps.ttlHours ?? DEFAULT_TTL_HOURS,
		};
		let info = await deps.clusters.get(alias);
		if (!info) {
			const claimed = await deps.clusters.claim(launch);
			if (!claimed) {
				const admitted = await this.admitColdProvision(launch);
				if (!admitted) {
					this.patch(record, {
						state: "capacity_full",
						error: "preview capacity is full (no free slot after PR-origin reap)",
					});
					return;
				}
			}
		}

		// 3. Wait for readiness (pool claims are near-instant; cold ≈ 5 min).
		info = await this.waitReady(alias);
		this.patch(record, { url: info.url });

		// 4. Adopt dev-mode pods for the mapped services inside the preview.
		this.patch(record, { state: "seeding" });
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
		if (targets.length === 0) {
			throw new Error(
				`no dev-mode pod came up for ${services.join(", ")}${
					podErrors.length ? ` (${podErrors.join("; ")})` : ""
				}`,
			);
		}

		// 5. Seed the PR head into every adopted pod (/__sync). Partial pod
		// failure is tolerated (B1 semantics) but surfaces in `error`.
		const seeded = await deps.seeder.seed({
			prNumber: input.prNumber,
			headSha: input.headSha,
			targets,
			syncToken,
		});
		if (!seeded.ok) {
			throw new Error(seeded.detail ?? "PR-head seed failed");
		}
		this.patch(record, {
			state: "ready",
			headSha: input.headSha,
			error: podErrors.length
				? `partial: ${podErrors.join("; ")}`
				: null,
		});

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
				this.patch(record, {
					verify: {
						state: "skipped",
						executionId: null,
						reason: started.reason ?? "verify unavailable",
						verdict: null,
					},
				});
				return;
			}
			this.patch(record, {
				verify: {
					state: "started",
					executionId: started.executionId ?? null,
					reason: null,
					verdict: null,
				},
			});
			const result = await deps.verify.waitForVerdict({
				executionId: started.executionId ?? "",
				timeoutMs: deps.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
			});
			const ok = result.status === "completed";
			this.patch(record, {
				verify: {
					state: ok ? "completed" : "failed",
					executionId: started.executionId ?? null,
					reason: ok ? null : `verify run ${result.status}`,
					verdict: result.verdict,
				},
			});
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
			// Verify is best-effort: never fail a ready preview over it.
			this.patch(record, {
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
