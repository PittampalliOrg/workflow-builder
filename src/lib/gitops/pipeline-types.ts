/**
 * Domain types for the Kargo-style GitOps pipeline view. These mirror Kargo's
 * Warehouse / Subscription / Stage / Freight model (so the dagre layout port
 * stays faithful) but are populated from OUR data (service-matrix `ServiceRow`s
 * + release-pins + GitOps Promoter state).
 *
 * Kargo mapping:
 *  - Warehouse  → a service's GHCR image (per-service) OR the release-pins bundle
 *  - Subscription → the GHCR image repo (+ stacks git repo for config)
 *  - Stage      → a per-service environment lane (ryzen / dev / staging)
 *  - Freight    → the pinned image version (or the release-pins snapshot)
 */
import type { ColorMap } from "./kargo-colors";
import type { EnvCell, EnvName, SpecialCase } from "./service-matrix";

export type SubscriptionType = "image" | "git" | "chart" | "generic";

export type PipelineSubscription = {
	id: string;
	type: SubscriptionType;
	repoURL: string;
	name?: string;
};

export type WarehouseKind = "service" | "bundle";

export type PipelineWarehouse = {
	/** Unique name: a service name, or "release-pins" for the bundle. */
	name: string;
	kind: WarehouseKind;
	subsystem: string;
	subscriptions: PipelineSubscription[];
	/** Identity colour (assigned from WarehouseColorMapHex). */
	color?: string;
	reconciling: boolean;
	hasError: boolean;
	specialCase: SpecialCase;
	/** Informational runtime/bundle coupling (not enforced DAG edges). */
	dependedOnBy?: string[];
	dependsOn?: string[];
	/** Most-actionable image build across this warehouse's lanes (building →
	 *  failed → most-recent built); null when no lane carries an inventory build. */
	build?: StageBuild | null;
	/** Latest durable event overlay for this warehouse, if any. */
	activity?: PipelineActivity | null;
};

export type StageFreightRef = {
	/** Origin warehouse name. */
	origin: string;
	sources: { direct?: boolean; stages?: string[] };
};

export type StageRollup = {
	synced: number;
	drift: number;
	degraded: number;
	total: number;
};

/**
 * A single promotion gate (Promoter `CommitStatus`) the next freight must clear
 * for this stage. `phase` follows Promoter's vocabulary
 * (`pending` | `success` | `failure`).
 */
export type StagePromotionGate = {
	key: string;
	phase: string | null;
	description: string | null;
};

/**
 * Promoter-aware promotion state for a Promoter-gated stage (today: dev). This
 * is the C1 per-environment state — the proposed-vs-active distinction the
 * Promoter actually tracks, NOT a single collapsed tone. `inFlight` is true when
 * a distinct proposed freight exists and hasn't merged yet. Stages with no
 * Promoter process (ryzen direct-main, dormant staging) carry `null`.
 */
export type StagePromotion = {
	/** A promotion is in flight when a proposed freight exists. */
	inFlight: boolean;
	/** Proposed (next) hydrated sha when in-flight, else null. */
	proposedTag: string | null;
	/** Active (live) hydrated sha. */
	activeTag: string | null;
	/** When the active freight was promoted (active hydrated/dry commit time). */
	activeAt: string | null;
	gates: StagePromotionGate[];
	/** Soak countdown label parsed from the `timer` gate, e.g. "4m of 10m". */
	soak: { elapsed: string; total: string; label: string } | null;
	pullRequest: { url: string | null; state: string | null } | null;
	/** First pending/failing gate key — what delivery is blocked on. */
	stalledOn: string | null;
};

export type StageBuild = {
	pipelineRun: string | null;
	/** building (in progress) | built (Tekton Succeeded) | failed. */
	phase: "building" | "built" | "failed";
	startedAt: string | null;
	finishedAt: string | null;
	/** Final build duration (finished − started) in ms; null while still building
	 *  — compute elapsed at render from `startedAt` + the shared clock. */
	durationMs: number | null;
};

/**
 * Source-→-pin provenance for the image this stage runs, matched from the
 * service's `imageHistory` by the stage's desired tag. Powers the drawer's
 * Commit→…→Pin delivery-timeline rows. All fields nullable (history may lack the
 * matching version, or a pin-only/live-only cell carries none).
 */
export type StageProvenance = {
	/** Source commit (sourceSha) that produced the image. */
	commitSha: string | null;
	/** First line of that commit's message, when known. */
	commitMessage: string | null;
	/** Source-commit time (when the image's commit landed), when known. */
	committedAt: string | null;
	/** Stacks release-pins commit that pinned this image. */
	pinCommit: string | null;
	pinCommittedAt: string | null;
};

export type PipelineActivity = {
	eventId: string;
	sequence: number;
	source: string;
	activityType: string;
	phase: string | null;
	reason: string | null;
	message: string | null;
	observedAt: string;
	/** Recently-completed SUCCESS (terminal pass). Distinct from failed. The
	 *  third state, "active" (fresh + in-progress), is derived at render from the
	 *  shared clock via `pipelineActivityTone` — not baked here. */
	passing: boolean;
	failed: boolean;
};

export type StageDeliveryMode = "direct-main" | "promoter" | "dormant";

export type PipelineStage = {
	/** Unique id: `${warehouse}::${env}`. */
	name: string;
	/** Origin warehouse this lane belongs to. */
	warehouse: string;
	env: EnvName;
	requestedFreight: StageFreightRef[];
	/** Mapped to Kargo health vocabulary: Healthy | Progressing | Degraded | Unknown. */
	health: string;
	syncStatus: string | null;
	promotionPhase: string | null;
	drift: string | null;
	desiredTag: string | null;
	liveTag: string | null;
	commitSha: string | null;
	source: EnvCell["source"] | null;
	updatedAt: string | null;
	/** Control-flow / dormant stage (no live promotion process). */
	controlFlow: boolean;
	dormant: boolean;
	/**
	 * How this stage receives changes:
	 *  - `direct-main`: reads the bare workload kustomization on stacks main (ryzen).
	 *    No Promoter env branch → no proposed-vs-active promotion tone.
	 *  - `promoter`: GitOps-Promoter-gated env branch (dev) with soak/health gates.
	 *  - `dormant`: downstream control-flow stage with no live promotion (staging).
	 */
	deliveryMode: StageDeliveryMode;
	/**
	 * `true` when the cell has a release-pin / source commit but no reconciled
	 * inventory evidence yet — render as "awaiting reconcile", distinct from a
	 * healthy synced cell.
	 */
	awaitingReconcile: boolean;
	/** Per-env roll-up for the release-train bundle stages. */
	rollup?: StageRollup | null;
	promoterBranch?: string | null;
	promoterHydratedSha?: string | null;
	/** Soak / verification gate label (Promoter TimedCommitStatus). */
	gate?: { label: string; phase: string | null } | null;
	/**
	 * Promoter-aware per-env promotion state (C1). Present only on
	 * Promoter-gated stages (dev); `null` for direct-main (ryzen) and dormant
	 * (staging) stages.
	 */
	promotion: StagePromotion | null;
	/** Inventory-sourced image-build status (the Tekton outer-loop run that
	 *  produced this env's desired image) — distinct from the transient event
	 *  `activity`; null when the inventory carries no build for this app. */
	build?: StageBuild | null;
	/** Source-commit → release-pin provenance for the image this stage runs
	 *  (matched from `imageHistory`); powers the drawer delivery timeline. */
	provenance?: StageProvenance | null;
	/** Latest durable event overlay from the hub Argo Events stream. */
	activity?: PipelineActivity | null;
};

export type FreightArtifact =
	| { kind: "image"; repoURL: string; tag: string | null; digest: string | null }
	| { kind: "git"; repoURL: string; sha: string | null; message?: string | null };

export type PipelineFreight = {
	id: string;
	/** Origin warehouse name. */
	warehouse: string;
	alias: string;
	artifacts: FreightArtifact[];
	createdAt: string | null;
	/** Stage names that currently hold this freight (drives the in-use bars). */
	inStages: string[];
	current: boolean;
	/** Latest durable event overlay for this warehouse, if any. */
	activity?: PipelineActivity | null;
};

export type PipelineModel = {
	warehouses: PipelineWarehouse[];
	stages: PipelineStage[];
	freights: PipelineFreight[];
	warehouseColorMap: ColorMap;
	stageColorMap: ColorMap;
	/** Ordered distinct subsystems actually present. */
	subsystems: string[];
	warehousesBySubsystem: Record<string, PipelineWarehouse[]>;
	generatedAt: string;
};
