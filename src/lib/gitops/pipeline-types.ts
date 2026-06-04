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
	/** Per-env roll-up for the release-train bundle stages. */
	rollup?: StageRollup | null;
	promoterBranch?: string | null;
	promoterHydratedSha?: string | null;
	/** Soak / verification gate label (Promoter TimedCommitStatus). */
	gate?: { label: string; phase: string | null } | null;
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
