import type {
	ImmutableGitSha,
	PrPreviewAuthority,
	PrPreviewCommandPort,
	PrPreviewDevPodPort,
	PrPreviewEnvironmentLaunchPort,
	PrPreviewPullRequestPort,
	PrPreviewRecord,
	PrPreviewRecordStore,
	PrPreviewRegistryEntry,
	PrPreviewSeedPort,
	PrPreviewSeedTarget,
	PrPreviewStatus,
	PrPreviewVerifyPort,
	PreviewAcceptanceChangedServiceCatalogPort,
	PreviewEnvironmentCleanupProof,
	PreviewEnvironmentReadinessPort,
	PreviewEnvironmentRevisionResolverPort,
	PreviewEnvironmentTeardownPort,
} from "$lib/server/application/ports";

const DEFAULT_READY_TIMEOUT_MS = 900_000;
const DEFAULT_TEARDOWN_TIMEOUT_MS = 600_000;
const DEFAULT_TTL_HOURS = 24;
const DEFAULT_VERIFY_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_RESUME_STALE_MS = 120_000;
const FULL_SHA = /^[0-9a-f]{40}$/;

export const PR_PREVIEW_VERIFY_MARKER = "<!-- pr-preview-verify -->";

export type PrPreviewUpInput = Readonly<{
	prNumber: number;
	/** Webhook observation only; GitHub must confirm this exact SHA. */
	headSha: string;
	verify?: boolean;
}>;

export type PrPreviewDeps = Readonly<{
	environments: PrPreviewEnvironmentLaunchPort;
	readiness: PreviewEnvironmentReadinessPort;
	teardown: PreviewEnvironmentTeardownPort;
	platformRevisions: PreviewEnvironmentRevisionResolverPort;
	pullRequests: PrPreviewPullRequestPort;
	catalog: PreviewAcceptanceChangedServiceCatalogPort;
	devPods: PrPreviewDevPodPort;
	seeder: PrPreviewSeedPort;
	verify: PrPreviewVerifyPort;
	store: PrPreviewRecordStore;
	registry: readonly PrPreviewRegistryEntry[];
	syncToken: (alias: string) => string;
	platformRepository: string;
	platformRef: string;
	sourceRepository: string;
	verifyEnabled?: boolean;
	ttlHours?: number;
	readyTimeoutMs?: number;
	teardownTimeoutMs?: number;
	verifyTimeoutMs?: number;
	heartbeatMs?: number;
	resumeStaleMs?: number;
	now?: () => Date;
	requestId?: () => string;
}>;

export type PrPreviewAdmissionErrorCode =
	| "invalid-request"
	| "github-verification-failed"
	| "unsupported-change"
	| "no-preview-service"
	| "platform-resolution-failed"
	| "teardown-failed";

export class PrPreviewAdmissionError extends Error {
	constructor(
		public readonly code: PrPreviewAdmissionErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "PrPreviewAdmissionError";
	}
}

export function prPreviewAlias(prNumber: number): string {
	return `pr-${prNumber}`;
}

function log(prNumber: number, stage: string, detail?: string) {
	console.info(
		`[pr-preview] pr=${prNumber} ${stage}${detail ? ` ${detail}` : ""}`,
	);
}

function logError(prNumber: number, stage: string, error: unknown) {
	console.error(
		`[pr-preview] pr=${prNumber} ${stage} FAILED: ${message(error)}`,
	);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class PrPreviewDeposedError extends Error {
	constructor(prNumber: number) {
		super(`pr-preview pr=${prNumber} pipeline deposed`);
		this.name = "PrPreviewDeposedError";
	}
}

function sameAuthority(
	left: PrPreviewAuthority | null,
	right: PrPreviewAuthority,
): boolean {
	return Boolean(
		left &&
		left.repository === right.repository &&
		left.baseRef === right.baseRef &&
		left.baseSha === right.baseSha &&
		left.headSha === right.headSha &&
		left.platformRepository === right.platformRepository &&
		left.platformRevision === right.platformRevision &&
		left.catalogDigest === right.catalogDigest &&
		JSON.stringify([...left.services].sort()) ===
			JSON.stringify([...right.services].sort()) &&
		JSON.stringify([...left.changedPaths].sort()) ===
			JSON.stringify([...right.changedPaths].sort()),
	);
}

/**
 * PR automation specialization over the unified PreviewEnvironment domain.
 * GitHub and the canonical catalog establish authority synchronously; only that
 * immutable authority is persisted and handed to the detached launch pipeline.
 */
export class ApplicationPrPreviewService {
	private readonly inFlight = new Map<number, Promise<void>>();

	constructor(private readonly deps: PrPreviewDeps) {}

	async up(input: PrPreviewUpInput): Promise<PrPreviewStatus> {
		const authority = await this.authorize(input);
		const existing = await this.deps.store.get(input.prNumber);
		if (
			existing &&
			sameAuthority(existing.authority, authority) &&
			["provisioning", "seeding", "ready"].includes(existing.state)
		) {
			log(input.prNumber, "up:idempotent", `state=${existing.state}`);
			return this.snapshot(input.prNumber);
		}

		const record = await this.deps.store.upsert({
			prNumber: input.prNumber,
			alias: prPreviewAlias(input.prNumber),
			url: null,
			state: "provisioning",
			headSha: authority.headSha,
			services: [...authority.services],
			authority,
			error: null,
			verify: null,
		});
		log(
			input.prNumber,
			"up:authorized",
			`head=${authority.headSha.slice(0, 12)} platform=${authority.platformRevision.slice(0, 12)} gen=${record.gen}`,
		);
		this.dispatch(record, {
			// `gen > 1` closes the race where another replica inserted between this
			// replica's read and upsert: the winner must clean the losing generation.
			replaceExisting: Boolean(existing) || record.gen > 1,
			verify: input.verify !== false,
		});
		return this.snapshot(input.prNumber);
	}

	async down(input: {
		prNumber: number;
	}): Promise<{ state: "down" | "absent" }> {
		const existing = await this.deps.store.get(input.prNumber);
		if (!existing) return { state: "absent" };
		const tombstone = await this.deps.store.upsert({
			prNumber: input.prNumber,
			alias: existing?.alias ?? prPreviewAlias(input.prNumber),
			url: existing?.url ?? null,
			state: "tearing_down",
			headSha: existing?.headSha ?? null,
			services: existing?.services ?? [],
			authority: existing?.authority ?? null,
			error: null,
			verify: existing?.verify ?? null,
		});
		if (!tombstone.authority) {
			const detail =
				"preview cleanup refused because generation authority is unavailable";
			await this.deps.store.patch(input.prNumber, tombstone.gen, {
				state: "error",
				error: detail,
			});
			throw new PrPreviewAdmissionError("teardown-failed", detail);
		}
		let cleanup: PreviewEnvironmentCleanupProof;
		try {
			cleanup = await this.teardownOwned(tombstone, {
				mode: "owned",
				requestId: tombstone.authority.requestId,
				sourceRevision: tombstone.authority.headSha,
			});
		} catch (cause) {
			const detail = `preview cleanup failed: ${message(cause)}`;
			await this.deps.store.patch(input.prNumber, tombstone.gen, {
				state: "error",
				error: detail,
			});
			throw new PrPreviewAdmissionError("teardown-failed", detail, { cause });
		}
		if (!cleanup.complete) {
			await this.deps.store.patch(input.prNumber, tombstone.gen, {
				state: "error",
				error: cleanup.message ?? "preview cleanup did not complete",
			});
			throw new PrPreviewAdmissionError(
				"teardown-failed",
				cleanup.message ?? "preview cleanup did not complete",
			);
		}
		await this.deps.store.delete(input.prNumber, tombstone.gen);
		log(input.prNumber, "down", cleanup.resourceName);
		return { state: existing ? "down" : "absent" };
	}

	async status(prNumber: number): Promise<PrPreviewStatus> {
		const record = await this.deps.store.get(prNumber);
		if (record) await this.maybeResume(record);
		return this.snapshot(prNumber);
	}

	async listStatuses(): Promise<PrPreviewStatus[]> {
		return (await this.deps.store.listActive()).map((record) =>
			this.statusFromRecord(record),
		);
	}

	async peek(prNumber: number): Promise<PrPreviewStatus> {
		return this.snapshot(prNumber);
	}

	async settled(prNumber: number): Promise<void> {
		await this.inFlight.get(prNumber)?.catch(() => undefined);
	}

	private async authorize(
		input: PrPreviewUpInput,
	): Promise<PrPreviewAuthority> {
		if (
			!Number.isSafeInteger(input.prNumber) ||
			input.prNumber < 1 ||
			!FULL_SHA.test(input.headSha)
		) {
			throw new PrPreviewAdmissionError(
				"invalid-request",
				"PR preview requires a positive PR number and full lowercase head SHA",
			);
		}
		let pullRequest;
		try {
			pullRequest = await this.deps.pullRequests.inspect({
				prNumber: input.prNumber,
				expectedHeadSha: input.headSha,
			});
		} catch (cause) {
			throw new PrPreviewAdmissionError(
				"github-verification-failed",
				`GitHub did not verify PR #${input.prNumber}: ${message(cause)}`,
				{ cause },
			);
		}
		if (pullRequest.repository !== this.deps.sourceRepository) {
			throw new PrPreviewAdmissionError(
				"github-verification-failed",
				"GitHub returned a non-canonical repository",
			);
		}

		const classified = this.deps.catalog.deriveChangedServices(
			pullRequest.changedPaths,
		);
		if (classified.unmappedRuntimePaths.length > 0) {
			throw new PrPreviewAdmissionError(
				"unsupported-change",
				`PR changes unmapped runtime paths: ${classified.unmappedRuntimePaths.join(", ")}`,
			);
		}
		if (classified.services.length === 0) {
			throw new PrPreviewAdmissionError(
				"no-preview-service",
				"PR does not change a catalog-backed preview-native service",
			);
		}

		let platformRevision: string;
		try {
			platformRevision = await this.deps.platformRevisions.resolve({
				repository: this.deps.platformRepository,
				ref: this.deps.platformRef,
			});
		} catch (cause) {
			throw new PrPreviewAdmissionError(
				"platform-resolution-failed",
				`Unable to resolve preview platform ${this.deps.platformRepository}@${this.deps.platformRef}`,
				{ cause },
			);
		}
		if (!FULL_SHA.test(platformRevision)) {
			throw new PrPreviewAdmissionError(
				"platform-resolution-failed",
				"Preview platform resolver did not return a full lowercase Git SHA",
			);
		}

		return Object.freeze({
			repository: pullRequest.repository,
			baseRef: "main",
			baseSha: pullRequest.baseSha,
			headSha: pullRequest.headSha,
			changedPaths: Object.freeze([...pullRequest.changedPaths]),
			services: Object.freeze([...classified.services]),
			platformRepository: this.deps.platformRepository,
			platformRevision: platformRevision as ImmutableGitSha,
			catalogDigest: this.deps.catalog.currentDigest(),
			requestId: this.deps.requestId?.() ?? globalThis.crypto.randomUUID(),
			requestedAt: (this.deps.now?.() ?? new Date()).toISOString(),
		});
	}

	private async maybeResume(record: PrPreviewRecord): Promise<void> {
		if (record.state !== "provisioning" && record.state !== "seeding") return;
		if (
			Date.now() - Date.parse(record.updatedAt) <
			(this.deps.resumeStaleMs ?? DEFAULT_RESUME_STALE_MS)
		)
			return;
		const claimed = await this.deps.store.claimStale(
			record.prNumber,
			this.deps.resumeStaleMs ?? DEFAULT_RESUME_STALE_MS,
		);
		if (!claimed) return;
		if (!claimed.authority) {
			await this.deps.store.patch(claimed.prNumber, claimed.gen, {
				state: "error",
				error: "legacy PR preview record has no persisted server authority",
			});
			return;
		}
		log(claimed.prNumber, "resume:claimed", `gen=${claimed.gen}`);
		this.dispatch(claimed, { replaceExisting: false, verify: false });
	}

	private dispatch(
		record: PrPreviewRecord,
		options: Readonly<{ replaceExisting: boolean; verify: boolean }>,
	): void {
		const heartbeat = setInterval(() => {
			void this.deps.store
				.patch(record.prNumber, record.gen, {})
				.then((owned) => {
					if (!owned) clearInterval(heartbeat);
				})
				.catch(() => undefined);
		}, this.deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
		(heartbeat as unknown as { unref?: () => void }).unref?.();

		const task = this.runUp(record, options)
			.catch(async (error) => {
				if (error instanceof PrPreviewDeposedError) return;
				logError(record.prNumber, "pipeline", error);
				let cleanup: Pick<
					PreviewEnvironmentCleanupProof,
					"complete" | "message"
				>;
				try {
					const authority = record.authority;
					if (!authority) throw new PrPreviewDeposedError(record.prNumber);
					cleanup = await this.teardownOwned(record, {
						mode: "owned",
						requestId: authority.requestId,
						sourceRevision: authority.headSha,
					});
				} catch (cleanupError) {
					if (cleanupError instanceof PrPreviewDeposedError) return;
					cleanup = {
						complete: false,
						message: message(cleanupError),
					};
				}
				const cleanupDetail = cleanup.complete
					? ""
					: `; cleanup incomplete: ${cleanup.message ?? "unknown"}`;
				await this.deps.store
					.patch(record.prNumber, record.gen, {
						state: "error",
						error: `${message(error)}${cleanupDetail}`,
					})
					.catch(() => undefined);
			})
			.finally(() => {
				clearInterval(heartbeat);
				if (this.inFlight.get(record.prNumber) === task) {
					this.inFlight.delete(record.prNumber);
				}
			});
		this.inFlight.set(record.prNumber, task);
	}

	private async runUp(
		record: PrPreviewRecord,
		options: Readonly<{ replaceExisting: boolean; verify: boolean }>,
	): Promise<void> {
		const authority = record.authority;
		if (!authority) throw new Error("PR preview has no server authority");
		if (options.replaceExisting) {
			const cleanup = await this.teardownOwned(record, {
				mode: "superseded",
				protectedRequestId: authority.requestId,
			});
			if (!cleanup.complete) {
				throw new Error(
					cleanup.message ?? "previous PR preview cleanup did not complete",
				);
			}
		}
		if (this.deps.catalog.currentDigest() !== authority.catalogDigest) {
			throw new Error(
				"PR preview catalog changed after authority was persisted; submit a new up request",
			);
		}

		const owner = {
			kind: "automation" as const,
			id: `pr-preview:${record.prNumber}`,
		};
		const allocation = { kind: "cold" as const };
		const launch = await this.deps.environments.launch({
			name: record.alias,
			profile: "app-live",
			lane: "application",
			capabilities: ["service-live-sync"],
			platformRevision: authority.platformRevision,
			sourceRevision: authority.headSha,
			services: authority.services,
			owner,
			origin: {
				kind: "pull-request",
				reference: `${authority.repository}#${record.prNumber}`,
			},
			ttlHours: this.deps.ttlHours ?? DEFAULT_TTL_HOURS,
			mode: "live",
			lifecycle: "ephemeral",
			allocation,
			provenance: {
				requestId: authority.requestId,
				requestedAt: authority.requestedAt,
				platformRepository: authority.platformRepository,
				sourceRepository: authority.repository,
			},
		});
		if (!launch.ok && launch.reason === "capacity") {
			await this.patch(record, {
				state: "capacity_full",
				error: launch.message,
			});
			return;
		}

		const ready = await this.deps.readiness.waitReady({
			name: record.alias,
			platformRevision: authority.platformRevision,
			sourceRevision: authority.headSha,
			profile: "app-live",
			lane: "application",
			mode: "live",
			services: authority.services,
			owner,
			origin: {
				kind: "pull-request",
				reference: `${authority.repository}#${record.prNumber}`,
			},
			lifecycle: "ephemeral",
			allocation,
			provenance: {
				requestId: authority.requestId,
				requestedAt: authority.requestedAt,
				platformRepository: authority.platformRepository,
				sourceRepository: authority.repository,
			},
			images: {},
			catalogDigest: authority.catalogDigest,
			timeoutMs: this.deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
		});
		if (!ready.ready || !ready.url) {
			throw new Error(
				`preview ${record.alias} did not become Ready at the verified contract (phase=${ready.phase})`,
			);
		}
		await this.patch(record, { url: ready.url, state: "seeding" });

		const syncToken = this.deps.syncToken(record.alias);
		if (!syncToken) throw new Error("PR preview sync token is not configured");
		const pods = await this.deps.devPods.provision({
			previewUrl: ready.url,
			alias: record.alias,
			services: [...authority.services],
			syncToken,
			requestId: authority.requestId,
			platformRevision: authority.platformRevision,
			sourceRevision: authority.headSha,
			catalogDigest: authority.catalogDigest,
		});
		const byService = new Map(pods.map((pod) => [pod.service, pod]));
		const targets: PrPreviewSeedTarget[] = [];
		const failures: string[] = [];
		for (const service of authority.services) {
			const pod = byService.get(service);
			const entry = this.deps.registry.find(
				(candidate) => candidate.service === service,
			);
			if (
				!pod?.ok ||
				!pod.podIp ||
				!pod.syncPort ||
				!pod.syncCapability ||
				!entry
			) {
				failures.push(
					`${service}: ${pod?.error ?? "missing pod or catalog sync metadata"}`,
				);
				continue;
			}
			targets.push({
				service,
				repoSubdir: entry.repoSubdir,
				syncPaths: entry.syncPaths,
				extraSync: entry.extraSync,
				podIp: pod.podIp,
				syncPort: pod.syncPort,
				syncToken: pod.syncCapability,
				appPort: entry.appPort,
				healthPath: entry.healthPath,
			});
		}
		if (failures.length > 0 || targets.length !== authority.services.length) {
			throw new Error(`preview-native adoption failed: ${failures.join("; ")}`);
		}

		await this.patch(record, {});
		const seeded = await this.deps.seeder.seed({
			prNumber: record.prNumber,
			headSha: authority.headSha,
			targets,
		});
		if (!seeded.ok) throw new Error(seeded.detail ?? "PR head sync failed");
		await this.patch(record, {
			state: "ready",
			headSha: authority.headSha,
			error: null,
		});
		log(record.prNumber, "stage=ready", authority.headSha.slice(0, 12));
		if (this.deps.verifyEnabled && options.verify) {
			await this.runVerify(record, ready.url, authority);
		}
	}

	private async patch(
		record: PrPreviewRecord,
		changes: Partial<PrPreviewRecord>,
	): Promise<void> {
		Object.assign(record, changes, { updatedAt: new Date().toISOString() });
		const { prNumber: _pr, gen: _gen, updatedAt: _at, ...persisted } = changes;
		if (
			!(await this.deps.store.patch(record.prNumber, record.gen, persisted))
		) {
			throw new PrPreviewDeposedError(record.prNumber);
		}
	}

	private async assertCurrent(record: PrPreviewRecord): Promise<void> {
		const current = await this.deps.store.get(record.prNumber);
		if (
			!current ||
			current.gen !== record.gen ||
			!record.authority ||
			!sameAuthority(current.authority, record.authority)
		) {
			throw new PrPreviewDeposedError(record.prNumber);
		}
	}

	private async teardownOwned(
		record: PrPreviewRecord,
		guard:
			| Readonly<{
					mode: "owned";
					requestId: string;
					sourceRevision: ImmutableGitSha;
			  }>
			| Readonly<{ mode: "superseded"; protectedRequestId: string }>,
	): Promise<PreviewEnvironmentCleanupProof> {
		await this.assertCurrent(record);
		return this.deps.teardown.teardown({
			name: record.alias,
			timeoutMs: this.deps.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS,
			guard,
		});
	}

	private async runVerify(
		record: PrPreviewRecord,
		previewUrl: string,
		authority: PrPreviewAuthority,
	): Promise<void> {
		try {
			const started = await this.deps.verify.start({
				prNumber: record.prNumber,
				previewUrl,
				headSha: authority.headSha,
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
			const result = await this.deps.verify.waitForVerdict({
				executionId: started.executionId ?? "",
				timeoutMs: this.deps.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
			});
			const completed = result.status === "completed";
			await this.patch(record, {
				verify: {
					state: completed ? "completed" : "failed",
					executionId: started.executionId ?? null,
					reason: completed ? null : `verify run ${result.status}`,
					verdict: result.verdict,
				},
			});
			await this.deps.pullRequests.upsertStickyComment({
				prNumber: record.prNumber,
				marker: PR_PREVIEW_VERIFY_MARKER,
				body: [
					PR_PREVIEW_VERIFY_MARKER,
					"### Preview verify (Playwright critic)",
					"",
					`- Preview: ${previewUrl}`,
					`- Head: \`${authority.headSha}\``,
					`- Run: ${started.executionId ?? "n/a"} - **${result.status}**`,
					"",
					result.verdict ?? "_no verdict output_",
				].join("\n"),
			});
		} catch (error) {
			if (error instanceof PrPreviewDeposedError) throw error;
			logError(record.prNumber, "verify", error);
			await this.patch(record, {
				verify: {
					state: "failed",
					executionId: record.verify?.executionId ?? null,
					reason: message(error),
					verdict: null,
				},
			});
		}
	}

	private async snapshot(prNumber: number): Promise<PrPreviewStatus> {
		const record = await this.deps.store.get(prNumber);
		return record
			? this.statusFromRecord(record)
			: {
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

	private statusFromRecord(record: PrPreviewRecord): PrPreviewStatus {
		return {
			prNumber: record.prNumber,
			alias: record.alias,
			url: record.url,
			state: record.state,
			headSha: record.headSha,
			services: [...record.services],
			error: record.error,
			verify: record.verify,
			updatedAt: record.updatedAt,
		};
	}
}

/**
 * Stable composition surface used by the persistent BFF. Reads stay local to
 * the shared durable store; every mutating/resuming command crosses the narrow
 * command port to the immutable broker.
 */
export class ApplicationPrPreviewFacadeService {
	constructor(
		private readonly commands: PrPreviewCommandPort,
		private readonly store: PrPreviewRecordStore,
	) {}

	up(input: PrPreviewUpInput): Promise<PrPreviewStatus> {
		return this.commands.up(input);
	}

	down(input: { prNumber: number }): Promise<{ state: "down" | "absent" }> {
		return this.commands.down(input);
	}

	status(prNumber: number): Promise<PrPreviewStatus> {
		return this.commands.status(prNumber);
	}

	async listStatuses(): Promise<PrPreviewStatus[]> {
		return (await this.store.listActive()).map(prPreviewStatusFromRecord);
	}

	async peek(prNumber: number): Promise<PrPreviewStatus> {
		const record = await this.store.get(prNumber);
		return record
			? prPreviewStatusFromRecord(record)
			: absentPrPreviewStatus(prNumber);
	}
}

function prPreviewStatusFromRecord(record: PrPreviewRecord): PrPreviewStatus {
	return {
		prNumber: record.prNumber,
		alias: record.alias,
		url: record.url,
		state: record.state,
		headSha: record.headSha,
		services: [...record.services],
		error: record.error,
		verify: record.verify,
		updatedAt: record.updatedAt,
	};
}

function absentPrPreviewStatus(prNumber: number): PrPreviewStatus {
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
