/**
 * Pure derivations for the Dev-hub preview drift overview: per-service drift
 * classification, preview stage derivation, and the overview join. No I/O —
 * the production loader (`preview-drift.ts`) feeds these from cached reads,
 * and the vitest matrix exercises them directly.
 */
import type {
	PreviewDriftEntry,
	PreviewDriftOverview,
	PreviewPromotionReceiptSummary,
	PreviewServiceDrift,
	PreviewServiceDriftStatus,
	PreviewServicePin,
	PreviewServiceRunningImage,
	PreviewStage,
	VclusterPreviewSummary,
	VclusterPreviewRuntimeView,
} from "$lib/types/dev-previews";

/** Minimal image-ref split (tag + digest) without importing server modules. */
export function splitImageRef(image: string): {
	tag: string | null;
	digest: string | null;
} {
	const [withoutDigest, digest] = image.split("@", 2);
	const lastSlash = withoutDigest.lastIndexOf("/");
	const lastColon = withoutDigest.lastIndexOf(":");
	const tag = lastColon > lastSlash ? withoutDigest.slice(lastColon + 1) : null;
	return { tag, digest: digest ?? null };
}

function shaMatches(a: string | null, b: string | null): boolean {
	if (!a || !b) return false;
	const x = a.toLowerCase();
	const y = b.toLowerCase();
	return x === y || x.startsWith(y) || y.startsWith(x);
}

export type DriftStatusInput = {
	running: Pick<PreviewServiceRunningImage, "tag" | "digest"> | null;
	pin: PreviewServicePin | null;
	/** workflow-builder main HEAD sha (null when unknown). */
	mainHeadSha: string | null;
	/** Historical pin tags/digests for THIS service (from pin history). */
	knownPinTags: ReadonlySet<string>;
	knownPinDigests: ReadonlySet<string>;
};

/**
 * Classify one service's drift. See `PreviewServiceDriftStatus` for the exact
 * semantics of each verdict.
 */
export function deriveDriftStatus(input: DriftStatusInput): PreviewServiceDriftStatus {
	const { running, pin } = input;
	if (!running || !pin) return "unknown";

	const digestsComparable = Boolean(running.digest && pin.digest);
	const tagsComparable = Boolean(running.tag && pin.tag);
	if (!digestsComparable && !tagsComparable) return "unknown";

	const matchesPin = digestsComparable
		? running.digest!.toLowerCase() === pin.digest!.toLowerCase()
		: running.tag === pin.tag;

	if (matchesPin) {
		if (
			pin.commitSha &&
			input.mainHeadSha &&
			!shaMatches(pin.commitSha, input.mainHeadSha)
		) {
			return "pin-behind-main";
		}
		return "in-sync";
	}

	if (running.tag && input.knownPinTags.has(running.tag)) return "behind-pin";
	if (running.digest && input.knownPinDigests.has(running.digest.toLowerCase())) {
		return "behind-pin";
	}
	return "diverged";
}

export type StageInput = {
	phase: string;
	state: "hot" | "slept" | null;
	lifecycle: "ephemeral" | "retained" | null;
	hasReceipts: boolean;
	hasActiveSandboxes: boolean;
};

const PROVISIONING_PHASES = new Set([
	"provisioning",
	"pending",
	"claiming",
	"terminating",
	"unknown",
]);

/**
 * Derive the preview's lifecycle stage. Priority (first match wins):
 * failed → sleeping → provisioning → agent-editing → promoted → retained → ready.
 */
export function derivePreviewStage(input: StageInput): PreviewStage {
	if (input.phase === "failed") return "failed";
	if (input.state === "slept" || input.phase === "slept") return "sleeping";
	if (PROVISIONING_PHASES.has(input.phase)) return "provisioning";
	if (input.hasActiveSandboxes) return "agent-editing";
	if (input.hasReceipts) return "promoted";
	if (input.lifecycle === "retained") return "retained";
	return "ready";
}

/** One preview's runtime observation, or why it is unavailable. */
export type RuntimeObservation =
	| { ok: true; view: VclusterPreviewRuntimeView }
	| { ok: false; reason: string };

export type PreviewDriftJoinInput = {
	previews: VclusterPreviewSummary[];
	/** Keyed by preview name; absent = not observed (treated as unavailable). */
	runtimeByPreview: ReadonlyMap<string, RuntimeObservation>;
	/** Dev release pins keyed by service name. */
	pinsByService: ReadonlyMap<string, PreviewServicePin>;
	/** Historical pin tags/digests keyed by service name. */
	pinHistoryByService: ReadonlyMap<
		string,
		{ tags: ReadonlySet<string>; digests: ReadonlySet<string> }
	>;
	/** Promotion receipts keyed by preview name (newest first). */
	receiptsByPreview: ReadonlyMap<string, PreviewPromotionReceiptSummary[]>;
	/** Execution ids with live dev sandboxes (host dev-environment groups). */
	activeSandboxExecutionIds: ReadonlySet<string>;
	/** Receipt execution ids per preview (links previews to sandbox groups). */
	receiptExecutionIdsByPreview?: ReadonlyMap<string, readonly string[]>;
	workflowBuilderMainSha: string | null;
	stacksMainSha: string | null;
	generatedAt?: string;
};

const EMPTY_HISTORY = {
	tags: new Set<string>() as ReadonlySet<string>,
	digests: new Set<string>() as ReadonlySet<string>,
};

function linkedExecutionIds(
	preview: VclusterPreviewSummary,
	receiptExecutionIds: readonly string[] | undefined,
): string[] {
	const ids = new Set<string>(receiptExecutionIds ?? []);
	if (preview.owner && preview.owner.kind !== "user" && preview.owner.id) {
		ids.add(preview.owner.id);
	}
	const provenanceExecution = preview.provenance?.executionId;
	if (typeof provenanceExecution === "string" && provenanceExecution) {
		ids.add(provenanceExecution);
	}
	return [...ids];
}

function syncGenerationOf(preview: VclusterPreviewSummary): string | null {
	const raw =
		preview.provenance?.syncGeneration ?? preview.provenance?.sync_generation;
	if (typeof raw === "string" && raw.trim()) return raw.trim();
	if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
	return null;
}

function serviceDrift(
	service: string,
	observation: RuntimeObservation | undefined,
	input: PreviewDriftJoinInput,
): PreviewServiceDrift {
	const pin = input.pinsByService.get(service) ?? null;
	let running: PreviewServiceRunningImage | null = null;
	let reason: string | null = null;

	if (!observation) {
		reason = "runtime was not observed";
	} else if (!observation.ok) {
		reason = observation.reason;
	} else {
		const observed = observation.view.services.find(
			(candidate) => candidate.service === service,
		);
		const container = observed?.containers[0] ?? null;
		if (!container) {
			reason = "no running container reported for this service";
		} else {
			const parsed = splitImageRef(container.image);
			running = {
				image: container.image,
				tag: parsed.tag,
				digest: parsed.digest,
				ready: container.ready,
			};
		}
	}

	const history = input.pinHistoryByService.get(service) ?? EMPTY_HISTORY;
	return {
		service,
		running,
		runningUnavailableReason: running ? null : reason,
		pin,
		driftStatus: deriveDriftStatus({
			running,
			pin,
			mainHeadSha: input.workflowBuilderMainSha,
			knownPinTags: history.tags,
			knownPinDigests: history.digests,
		}),
	};
}

/** Join previews × runtime × pins × receipts into the overview DTO. Pure. */
export function buildPreviewDriftOverview(
	input: PreviewDriftJoinInput,
): PreviewDriftOverview {
	const previews: PreviewDriftEntry[] = input.previews.map((preview) => {
		const observation = input.runtimeByPreview.get(preview.name);
		const receipts = input.receiptsByPreview.get(preview.name) ?? [];
		const executionIds = linkedExecutionIds(
			preview,
			input.receiptExecutionIdsByPreview?.get(preview.name),
		);
		const hasActiveSandboxes = executionIds.some((id) =>
			input.activeSandboxExecutionIds.has(id),
		);
		const services = (preview.services ?? []).map((service) =>
			serviceDrift(service, observation, input),
		);
		// Surface runtime-observed services the declared list missed (e.g. a
		// preview whose contract predates a service addition).
		if (observation?.ok) {
			for (const observed of observation.view.services) {
				if (!services.some((row) => row.service === observed.service)) {
					services.push(serviceDrift(observed.service, observation, input));
				}
			}
		}
		services.sort((a, b) => a.service.localeCompare(b.service));

		return {
			name: preview.name,
			phase: preview.phase,
			state: preview.state,
			lifecycle: preview.lifecycle,
			stage: derivePreviewStage({
				phase: preview.phase,
				state: preview.state,
				lifecycle: preview.lifecycle,
				hasReceipts: receipts.length > 0,
				hasActiveSandboxes,
			}),
			syncGeneration: syncGenerationOf(preview),
			services,
			receipts,
		};
	});

	return {
		generatedAt: input.generatedAt ?? new Date().toISOString(),
		repoHeads: {
			workflowBuilderMainSha: input.workflowBuilderMainSha,
			stacksMainSha: input.stacksMainSha,
		},
		previews,
	};
}
