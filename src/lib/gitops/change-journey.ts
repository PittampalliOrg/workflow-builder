import { BUNDLE_WAREHOUSE } from "./pipeline-model";
import type { PipelineModel, PipelineStage } from "./pipeline-types";
import type { DeploymentMetadataResponse, ImageVersion } from "$lib/types/deployment-metadata";
import type { GitOpsActivityEvent } from "$lib/types/gitops-activity";
import { tektonPipelineRunUrl } from "$lib/utils/gitops-display";

export type ChangeJourneyFilter =
	| "recent"
	| "mine"
	| "stacks"
	| "workflow-builder"
	| "images"
	| "waiting-failed"
	| "direct-ryzen"
	| "promoter-dev";

export type ChangeJourneyStatus = "done" | "active" | "failed" | "waiting" | "neutral";

export type ChangeJourneyStepState = "done" | "active" | "failed" | "waiting" | "skipped";

export type ChangeJourneyStepKind =
	| "github-pr"
	| "github-push"
	| "merge"
	| "build"
	| "pin"
	| "promote"
	| "argocd-sync"
	| "deploy"
	| "event";

export type ChangeJourneySelection = { kind: "stage" | "warehouse"; id: string };

export type ChangeJourneyStep = {
	id: string;
	kind: ChangeJourneyStepKind;
	label: string;
	state: ChangeJourneyStepState;
	detail: string | null;
	sub?: string | null;
	at: string | null;
	href?: string | null;
	hrefLabel?: string | null;
	eventIds?: string[];
	selection?: ChangeJourneySelection | null;
};

export type ChangeJourney = {
	id: string;
	groupKey: string;
	title: string;
	subtitle: string | null;
	repo: string | null;
	repoLabel: "stacks" | "workflow-builder" | "github" | "unknown";
	branch: string | null;
	pullRequestNumber: string | null;
	sourceCommitSha: string | null;
	pinCommitSha: string | null;
	hydratedSha: string | null;
	services: string[];
	environments: string[];
	lanes: ("direct-ryzen" | "promoter-dev" | "dormant" | "unknown")[];
	actors: string[];
	status: ChangeJourneyStatus;
	currentPhase: string;
	updatedAt: string | null;
	steps: ChangeJourneyStep[];
	eventIds: string[];
	warehouseNames: string[];
	stageNames: string[];
	primarySelection: ChangeJourneySelection | null;
	hasImageReplacement: boolean;
	hasFailure: boolean;
	isWaiting: boolean;
	isMine: boolean;
};

export type ChangeJourneyLinks = {
	argoCdBase?: string | null;
	stacksRepo?: string;
	workflowBuilderRepo?: string;
	tektonBase?: string | null;
};

type BuildChangeJourneysInput = {
	events: GitOpsActivityEvent[];
	metadata: DeploymentMetadataResponse;
	model: PipelineModel;
	links?: ChangeJourneyLinks;
	viewerEmail?: string | null;
	limit?: number;
};

type MutableJourney = Omit<
	ChangeJourney,
	| "title"
	| "subtitle"
	| "status"
	| "currentPhase"
	| "updatedAt"
	| "steps"
	| "services"
	| "environments"
	| "lanes"
	| "actors"
	| "eventIds"
	| "warehouseNames"
	| "stageNames"
	| "primarySelection"
	| "hasImageReplacement"
	| "hasFailure"
	| "isWaiting"
	| "isMine"
> & {
	steps: Map<string, ChangeJourneyStep>;
	services: Set<string>;
	environments: Set<string>;
	lanes: Set<ChangeJourney["lanes"][number]>;
	actors: Set<string>;
	eventIds: Set<string>;
	warehouseNames: Set<string>;
	stageNames: Set<string>;
	hasImageReplacement: boolean;
	hasFailure: boolean;
	isWaiting: boolean;
	isMine: boolean;
};

export const CHANGE_JOURNEY_FILTERS: { value: ChangeJourneyFilter; label: string }[] = [
	{ value: "recent", label: "Recent" },
	{ value: "mine", label: "My recent changes" },
	{ value: "stacks", label: "Stacks repo" },
	{ value: "workflow-builder", label: "Workflow-builder repo" },
	{ value: "images", label: "Images replaced" },
	{ value: "waiting-failed", label: "Waiting / failed" },
	{ value: "direct-ryzen", label: "Direct ryzen lane" },
	{ value: "promoter-dev", label: "Promoter dev lane" },
];

export function buildChangeJourneys(input: BuildChangeJourneysInput): ChangeJourney[] {
	const links = normalizeLinks(input.links);
	const model = input.model;
	const events = input.events ?? [];
	const commitToPrKey = buildCommitToPrKey(events);
	const groups = new Map<string, MutableJourney>();

	const get = (key: string, seed?: Partial<MutableJourney>): MutableJourney => {
		const existing = groups.get(key);
		if (existing) return existing;
		const created: MutableJourney = {
			id: key,
			groupKey: key,
			repo: null,
			repoLabel: "unknown",
			branch: null,
			pullRequestNumber: null,
			sourceCommitSha: null,
			pinCommitSha: null,
			hydratedSha: null,
			steps: new Map(),
			services: new Set(),
			environments: new Set(),
			lanes: new Set(),
			actors: new Set(),
			eventIds: new Set(),
			warehouseNames: new Set(),
			stageNames: new Set(),
			hasImageReplacement: false,
			hasFailure: false,
			isWaiting: false,
			isMine: false,
			...seed,
		};
		groups.set(key, created);
		return created;
	};

	for (const event of events) {
		const key = groupKeyForEvent(event, commitToPrKey);
		if (!key) continue;
		const journey = get(key);
		applyEvent(journey, event, model, links);
	}

	const history = input.metadata.gitops.imageHistory ?? [];
	for (const version of history) {
		const key = groupKeyForImageVersion(version, commitToPrKey);
		const journey = get(key);
		applyImageVersion(journey, version, model, links);
	}

	for (const stage of model.stages) {
		const key = groupKeyForStage(stage, commitToPrKey);
		if (!key) continue;
		if (!groups.has(key)) continue;
		const journey = get(key);
		applyStageEvidence(journey, stage, links);
	}

	const viewerAliases = aliasesForViewer(input.viewerEmail);
	const journeys = [...groups.values()]
		.map((journey) => finalizeJourney(journey, viewerAliases))
		.filter((journey) => journey.steps.length > 0)
		.sort((a, b) => compareIsoDesc(a.updatedAt, b.updatedAt))
		.slice(0, input.limit ?? 40);

	return journeys;
}

export function filterChangeJourneys(
	journeys: ChangeJourney[],
	filter: ChangeJourneyFilter,
): ChangeJourney[] {
	switch (filter) {
		case "mine":
			return journeys.filter((journey) => journey.isMine);
		case "stacks":
			return journeys.filter((journey) => journey.repoLabel === "stacks");
		case "workflow-builder":
			return journeys.filter((journey) => journey.repoLabel === "workflow-builder");
		case "images":
			return journeys.filter((journey) => journey.hasImageReplacement);
		case "waiting-failed":
			return journeys.filter((journey) => journey.hasFailure || journey.isWaiting);
		case "direct-ryzen":
			return journeys.filter((journey) => journey.lanes.includes("direct-ryzen"));
		case "promoter-dev":
			return journeys.filter((journey) => journey.lanes.includes("promoter-dev"));
		default:
			return journeys;
	}
}

export function journeyGraphHighlight(
	journey: ChangeJourney | null,
): { warehouse: string; stageNames: string[] } | null {
	if (!journey || journey.warehouseNames.length === 0) return null;
	const warehouse = journey.primarySelection?.id.startsWith("stage/")
		? journey.primarySelection.id.slice("stage/".length).split("::")[0]!
		: journey.warehouseNames[0]!;
	return {
		warehouse,
		stageNames: journey.stageNames.filter((name) => name.startsWith(`${warehouse}::`)),
	};
}

function applyEvent(
	journey: MutableJourney,
	event: GitOpsActivityEvent,
	model: PipelineModel,
	links: Required<ChangeJourneyLinks>,
): void {
	const corr = event.correlation ?? {};
	const repo = eventRepo(event);
	if (repo) setRepo(journey, repo);
	const branch = readString(corr.branch) ?? githubBranch(event);
	if (branch && !journey.branch) journey.branch = branch;
	const pr = readString(corr.pullRequestNumber) ?? githubPullRequestNumber(event);
	if (pr && !journey.pullRequestNumber) journey.pullRequestNumber = pr;
	const sourceSha = eventSourceCommit(event);
	if (sourceSha && !journey.sourceCommitSha) journey.sourceCommitSha = sourceSha;
	const pinCommit = readString(corr.pinCommit);
	if (pinCommit && !journey.pinCommitSha) journey.pinCommitSha = pinCommit;
	const hydrated = readString(corr.hydratedSha);
	if (hydrated && !journey.hydratedSha) journey.hydratedSha = hydrated;
	for (const actor of eventActors(event)) journey.actors.add(actor);

	const target = selectionForEvent(event, model);
	if (target) {
		if (target.kind === "stage") {
			const stageName = target.id.slice("stage/".length);
			journey.stageNames.add(stageName);
			journey.warehouseNames.add(stageName.split("::")[0] ?? stageName);
			const env = stageName.split("::")[1];
			if (env) {
				journey.environments.add(env);
				journey.lanes.add(laneForEnv(env));
			}
		} else {
			journey.warehouseNames.add(target.id.slice("warehouse/".length));
		}
	}

	const imageName = readString(corr.imageName) ?? imageNameFromRef(readString(corr.imageRef));
	if (imageName) {
		journey.services.add(imageName);
		journey.warehouseNames.add(imageName);
	}
	const lane = readString(corr.expectedGitOpsLane);
	if (lane) addExpectedLane(journey, lane);

	const step = stepForEvent(event, links, target);
	upsertStep(journey, step);
	journey.eventIds.add(event.eventId);
	if (step.state === "failed") journey.hasFailure = true;
	if (step.state === "active" || step.state === "waiting") journey.isWaiting = true;
}

function applyImageVersion(
	journey: MutableJourney,
	version: ImageVersion,
	model: PipelineModel,
	links: Required<ChangeJourneyLinks>,
): void {
	journey.services.add(version.service);
	journey.warehouseNames.add(version.service);
	if (version.sourceSha && !journey.sourceCommitSha) journey.sourceCommitSha = version.sourceSha;
	if (version.pinCommit && !journey.pinCommitSha) journey.pinCommitSha = version.pinCommit;
	if (!journey.repo) setRepo(journey, "PittampalliOrg/workflow-builder");

	upsertStep(journey, {
		id: `pin:${version.pinCommit}:${version.service}:${version.tag}`,
		kind: "pin",
		label: "Pin updated",
		state: "done",
		detail: `${version.service}:${version.tag}`,
		sub: version.message,
		at: version.pinCommittedAt,
		href: version.pinCommit ? `${links.stacksRepo}/commit/${version.pinCommit}` : null,
		hrefLabel: "release pin",
	});

	for (const stage of stagesForVersion(model, version)) {
		applyStageEvidence(journey, stage, links, version);
	}
}

function applyStageEvidence(
	journey: MutableJourney,
	stage: PipelineStage,
	links: Required<ChangeJourneyLinks>,
	version?: ImageVersion,
): void {
	journey.warehouseNames.add(stage.warehouse);
	journey.stageNames.add(stage.name);
	journey.environments.add(stage.env);
	journey.lanes.add(laneForStage(stage));
	if (stage.warehouse !== BUNDLE_WAREHOUSE) journey.services.add(stage.warehouse);
	if (stage.provenance?.commitSha && !journey.sourceCommitSha) {
		journey.sourceCommitSha = stage.provenance.commitSha;
	}
	if (stage.provenance?.pinCommit && !journey.pinCommitSha) {
		journey.pinCommitSha = stage.provenance.pinCommit;
	}
	if (stage.promoterHydratedSha && !journey.hydratedSha) journey.hydratedSha = stage.promoterHydratedSha;

	const selection: ChangeJourneySelection = { kind: "stage", id: `stage/${stage.name}` };
	if (stage.build) {
		upsertStep(journey, {
			id: `build:${stage.warehouse}:${stage.env}:${stage.build.pipelineRun ?? stage.desiredTag ?? "unknown"}`,
			kind: "build",
			label: "Image build",
			state:
				stage.build.phase === "failed"
					? "failed"
					: stage.build.phase === "building"
						? "active"
						: "done",
			detail: stage.build.pipelineRun ?? stage.build.phase,
			at: stage.build.phase === "building" ? stage.build.startedAt : (stage.build.finishedAt ?? stage.build.startedAt),
			href: tektonPipelineRunUrl(links.tektonBase, stage.build.pipelineRun),
			hrefLabel: "Tekton",
			selection,
		});
	}

	const pin = version?.pinCommit ?? stage.provenance?.pinCommit ?? null;
	if (pin) {
		upsertStep(journey, {
			id: `pin:${pin}:${stage.warehouse}:${stage.env}`,
			kind: "pin",
			label: stage.deliveryMode === "direct-main" ? "Ryzen pin updated" : "Release pin updated",
			state: "done",
			detail: stage.desiredTag ?? stage.liveTag ?? null,
			at: version?.pinCommittedAt ?? stage.provenance?.pinCommittedAt ?? null,
			href: `${links.stacksRepo}/commit/${pin}`,
			hrefLabel: "stacks",
			selection,
		});
	}

	if (stage.deliveryMode === "promoter") {
		const promotion = stage.promotion;
		upsertStep(journey, {
			id: `promote:${stage.name}:${promotion?.proposedTag ?? promotion?.activeTag ?? "pending"}`,
			kind: "promote",
			label: promotion?.inFlight ? "Promoter PR" : "Auto-promotion",
			state: promotion?.inFlight ? "active" : promotion ? "done" : "waiting",
			detail: promotion?.inFlight
				? promotion.stalledOn
					? `waiting: ${promotion.stalledOn}`
					: "promotion in flight"
				: promotion?.activeTag
					? promotion.activeTag
					: "awaiting promotion",
			at: promotion?.activeAt ?? null,
			href: promotion?.pullRequest?.url ?? null,
			hrefLabel: promotion?.pullRequest?.url ? "PR" : null,
			selection,
		});
	} else if (stage.deliveryMode === "direct-main") {
		upsertStep(journey, {
			id: `promote:${stage.name}:direct`,
			kind: "promote",
			label: "Direct ryzen lane",
			state: "done",
			detail: "main -> local ArgoCD",
			at: null,
			selection,
		});
	}

	if (!stage.dormant) {
		const argo = argoUrl(links.argoCdBase, stage.env, stage.warehouse);
		upsertStep(journey, {
			id: `argocd:${stage.name}:${stage.syncStatus ?? "unknown"}`,
			kind: "argocd-sync",
			label: "ArgoCD sync",
			state:
				stage.health === "Degraded"
					? "failed"
					: stage.syncStatus === "Synced" && stage.health === "Healthy"
						? "done"
						: stage.awaitingReconcile
							? "waiting"
							: "active",
			detail: [stage.syncStatus, stage.health].filter(Boolean).join(" / ") || null,
			at: stage.updatedAt,
			href: argo,
			hrefLabel: argo ? "ArgoCD" : null,
			selection,
		});

		const replaced = Boolean(stage.liveTag && (stage.liveTag === version?.tag || stage.liveTag === stage.desiredTag));
		journey.hasImageReplacement ||= replaced;
		upsertStep(journey, {
			id: `deploy:${stage.name}:${stage.liveTag ?? stage.desiredTag ?? "unknown"}`,
			kind: "deploy",
			label: "Deployment image replaced",
			state: replaced ? "done" : stage.awaitingReconcile ? "waiting" : "active",
			detail: stage.liveTag ?? stage.desiredTag ?? null,
			at: stage.updatedAt,
			href: argo,
			hrefLabel: argo ? "ArgoCD" : null,
			selection,
		});
	}
}

function finalizeJourney(journey: MutableJourney, viewerAliases: Set<string>): ChangeJourney {
	for (const actor of journey.actors) {
		if (viewerAliases.has(actor.toLowerCase())) journey.isMine = true;
	}
	normalizeMergedPrSteps(journey);
	maybeAddSkippedBuildStep(journey);
	const steps = [...journey.steps.values()].sort(compareSteps);
	const hasFailure = journey.hasFailure || steps.some((step) => step.state === "failed");
	const isWaiting =
		journey.isWaiting ||
		steps.some((step) => step.state === "active" || step.state === "waiting");
	const status: ChangeJourneyStatus = hasFailure
		? "failed"
		: steps.some((step) => step.state === "active")
			? "active"
			: isWaiting
				? "waiting"
				: steps.length > 0
					? "done"
					: "neutral";
	const updatedAt = newestIso(steps.map((step) => step.at));
	const services = [...journey.services].sort();
	const environments = [...journey.environments].sort(envSort);
	const lanes = [...journey.lanes].sort();
	const warehouseNames = [...journey.warehouseNames].filter(Boolean).sort();
	const stageNames = [...journey.stageNames].filter(Boolean).sort(envStageSort);
	const primarySelection =
		stageNames.length > 0
			? ({ kind: "stage", id: `stage/${stageNames[0]}` } as const)
			: warehouseNames.length > 0
				? ({ kind: "warehouse", id: `warehouse/${warehouseNames[0]}` } as const)
				: null;
	const title = titleForJourney(journey, services);
	const currentPhase = currentPhaseFor(steps, status);
	const subtitle = subtitleForJourney(journey, services, environments, lanes);
	return {
		id: journey.id,
		groupKey: journey.groupKey,
		title,
		subtitle,
		repo: journey.repo,
		repoLabel: journey.repoLabel,
		branch: journey.branch,
		pullRequestNumber: journey.pullRequestNumber,
		sourceCommitSha: journey.sourceCommitSha,
		pinCommitSha: journey.pinCommitSha,
		hydratedSha: journey.hydratedSha,
		services,
		environments,
		lanes,
		actors: [...journey.actors].sort(),
		status,
		currentPhase,
		updatedAt,
		steps,
		eventIds: [...journey.eventIds],
		warehouseNames,
		stageNames,
		primarySelection,
		hasImageReplacement: journey.hasImageReplacement,
		hasFailure,
		isWaiting,
		isMine: journey.isMine,
	};
}

function normalizeMergedPrSteps(journey: MutableJourney): void {
	const hasMerge = [...journey.steps.values()].some((step) => step.kind === "merge");
	if (!hasMerge) return;
	for (const [key, step] of journey.steps) {
		if (step.kind !== "github-pr" || step.state !== "active") continue;
		journey.steps.set(key, { ...step, state: "done" });
	}
	journey.isWaiting = [...journey.steps.values()].some(
		(step) => step.state === "active" || step.state === "waiting",
	);
}

function maybeAddSkippedBuildStep(journey: MutableJourney): void {
	if (journey.repoLabel !== "workflow-builder") return;
	if (hasStepKind(journey, "build") || hasStepKind(journey, "pin") || hasStepKind(journey, "deploy")) return;
	upsertStep(journey, {
		id: "build:skipped",
		kind: "build",
		label: "Build skipped",
		state: "skipped",
		detail: "no matching outer-loop trigger yet",
		at: null,
	});
}

function hasStepKind(journey: MutableJourney, kind: ChangeJourneyStepKind): boolean {
	for (const step of journey.steps.values()) {
		if (step.kind === kind) return true;
	}
	return false;
}

function stepForEvent(
	event: GitOpsActivityEvent,
	links: Required<ChangeJourneyLinks>,
	selection: ChangeJourneySelection | null,
): ChangeJourneyStep {
	const corr = event.correlation ?? {};
	const source = event.source.toLowerCase();
	const activity = event.activityType.toLowerCase();
	const at = event.observedAt;
	const state = stateForEvent(event);
	const repo = eventRepo(event);
	const commitSha = eventSourceCommit(event);
	const pr = readString(corr.pullRequestNumber) ?? githubPullRequestNumber(event);
	const branch = readString(corr.branch) ?? githubBranch(event);

	if (source === "github" || activity.startsWith("github.")) {
		const merged = readBool(corr.merged) ?? githubMerged(event);
		if (pr) {
			return {
				id: `github-pr:${repo ?? "repo"}:${pr}:${merged ? "merged" : event.phase ?? event.reason ?? "update"}`,
				kind: merged ? "merge" : "github-pr",
				label: merged ? "Merged to main" : "PR opened / updated",
				state: merged ? "done" : event.phase === "closed" ? "done" : "active",
				detail: `#${pr}${branch ? ` -> ${branch}` : ""}`,
				sub: readString(corr.title) ?? event.message,
				at,
				href: readString(corr.pullRequestUrl) ?? githubPrUrl(repo, pr, links),
				hrefLabel: "GitHub",
				eventIds: [event.eventId],
				selection,
			};
		}
		return {
			id: `github-push:${repo ?? "repo"}:${commitSha ?? event.eventId}`,
			kind: "github-push",
			label: branch === "main" ? "Direct push" : "Push",
			state: "done",
			detail: commitSha ? `${branch ?? "branch"} @ ${commitSha.slice(0, 8)}` : (branch ?? "push"),
			sub: event.message,
			at,
			href: commitHref(repo, commitSha, links),
			hrefLabel: commitSha ? "commit" : null,
			eventIds: [event.eventId],
			selection,
		};
	}

	if (source === "tekton" || activity.startsWith("tekton.")) {
		const run = readString(corr.pipelineRun) ?? event.resourceRef.name;
		return {
			id: `build:${run ?? event.eventId}`,
			kind: "build",
			label: "Image build",
			state,
			detail: run,
			sub: event.message,
			at,
			href: tektonPipelineRunUrl(links.tektonBase, run),
			hrefLabel: run ? "Tekton" : null,
			eventIds: [event.eventId],
			selection,
		};
	}

	if (source === "promoter" || activity.startsWith("promoter.")) {
		const prUrl = readString(corr.pullRequestUrl);
		return {
			id: `promoter:${event.resourceRef.name ?? event.eventId}:${event.phase ?? ""}`,
			kind: "promote",
			label: activity.includes("pullrequest") ? "Promoter PR" : "Promoter gate",
			state,
			detail: event.reason ?? readString(corr.commitStatusKey) ?? event.phase,
			sub: event.message,
			at,
			href: prUrl,
			hrefLabel: prUrl ? "PR" : null,
			eventIds: [event.eventId],
			selection,
		};
	}

	if (source === "argocd" || activity.startsWith("argocd.")) {
		const app = readString(corr.argocdApp) ?? event.resourceRef.name;
		const env = app ? envFromAppName(app) : null;
		const warehouse = app && env ? app.slice(`${env}-`.length) : null;
		const href = env && warehouse ? argoUrl(links.argoCdBase, env, warehouse) : null;
		return {
			id: `argocd:${app ?? event.eventId}:${event.phase ?? ""}`,
			kind: "argocd-sync",
			label: "ArgoCD sync",
			state,
			detail: [readString(corr.syncStatus), readString(corr.healthStatus)].filter(Boolean).join(" / ") || event.phase,
			sub: event.message,
			at,
			href,
			hrefLabel: href ? "ArgoCD" : null,
			eventIds: [event.eventId],
			selection,
		};
	}

	return {
		id: `event:${event.eventId}`,
		kind: "event",
		label: event.activityType,
		state,
		detail: event.phase,
		sub: event.message,
		at,
		eventIds: [event.eventId],
		selection,
	};
}

function stateForEvent(event: GitOpsActivityEvent): ChangeJourneyStepState {
	const values = [event.phase, event.reason].map((value) => value?.toLowerCase() ?? "");
	if (values.some((value) => ["failed", "failure", "false", "degraded", "outofsync"].includes(value))) {
		return "failed";
	}
	if (values.some((value) => ["succeeded", "success", "true", "healthy", "synced", "ready"].includes(value))) {
		return "done";
	}
	if (values.some((value) => ["running", "progressing", "pending", "started"].includes(value))) {
		return "active";
	}
	return "done";
}

function stagesForVersion(model: PipelineModel, version: ImageVersion): PipelineStage[] {
	return model.stages.filter((stage) => {
		if (stage.warehouse !== version.service) return false;
		if (stage.desiredTag === version.tag || stage.liveTag === version.tag) return true;
		if (stage.provenance?.pinCommit === version.pinCommit) return true;
		return Boolean(version.sourceSha && stage.provenance?.commitSha === version.sourceSha);
	});
}

function groupKeyForEvent(
	event: GitOpsActivityEvent,
	commitToPrKey: Map<string, string>,
): string | null {
	const corr = event.correlation ?? {};
	const repo = eventRepo(event);
	const pr = readString(corr.pullRequestNumber) ?? githubPullRequestNumber(event);
	if (pr) return `pr:${repo ?? "_"}:${pr}`;
	const commit = eventSourceCommit(event);
	if (commit) return commitToPrKey.get(commit.toLowerCase()) ?? `commit:${commit}`;
	const pinCommit = readString(corr.pinCommit);
	if (pinCommit) return commitToPrKey.get(pinCommit.toLowerCase()) ?? `pin:${pinCommit}`;
	const imageName = readString(corr.imageName) ?? imageNameFromRef(readString(corr.imageRef));
	const tag = imageTagFromRef(readString(corr.imageRef)) ?? readString(corr.imageTag);
	if (imageName && tag) return `image:${imageName}:${tag}`;
	if (imageName) return `image:${imageName}`;
	const hydrated = readString(corr.hydratedSha);
	if (hydrated) return `hydrated:${hydrated}`;
	return event.source === "inventory" ? null : `event:${event.eventId}`;
}

function groupKeyForImageVersion(
	version: ImageVersion,
	commitToPrKey: Map<string, string>,
): string {
	if (version.sourceSha) {
		return commitToPrKey.get(version.sourceSha.toLowerCase()) ?? `commit:${version.sourceSha}`;
	}
	if (version.pinCommit) {
		return commitToPrKey.get(version.pinCommit.toLowerCase()) ?? `pin:${version.pinCommit}`;
	}
	return `image:${version.service}:${version.tag}`;
}

function groupKeyForStage(
	stage: PipelineStage,
	commitToPrKey: Map<string, string>,
): string | null {
	const commit = stage.provenance?.commitSha ?? stage.commitSha;
	if (commit) return commitToPrKey.get(commit.toLowerCase()) ?? `commit:${commit}`;
	const pin = stage.provenance?.pinCommit;
	if (pin) return commitToPrKey.get(pin.toLowerCase()) ?? `pin:${pin}`;
	if (stage.desiredTag) return `image:${stage.warehouse}:${stage.desiredTag}`;
	if (stage.promoterHydratedSha) return `hydrated:${stage.promoterHydratedSha}`;
	return null;
}

function buildCommitToPrKey(events: GitOpsActivityEvent[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const event of events) {
		const repo = eventRepo(event);
		const pr = readString(event.correlation.pullRequestNumber) ?? githubPullRequestNumber(event);
		if (!pr) continue;
		const key = `pr:${repo ?? "_"}:${pr}`;
		for (const candidate of [eventSourceCommit(event), readString(event.correlation.pinCommit)]) {
			if (candidate) map.set(candidate.toLowerCase(), key);
		}
	}
	return map;
}

function setRepo(journey: MutableJourney, repo: string): void {
	journey.repo = repo;
	if (repo.toLowerCase().includes("workflow-builder")) journey.repoLabel = "workflow-builder";
	else if (repo.toLowerCase().includes("stacks")) journey.repoLabel = "stacks";
	else if (repo) journey.repoLabel = "github";
}

function addExpectedLane(journey: MutableJourney, lane: string): void {
	const normalized = lane.toLowerCase();
	if (normalized.includes("ryzen") || normalized.includes("direct")) journey.lanes.add("direct-ryzen");
	if (normalized.includes("promoter") || normalized.includes("dev")) journey.lanes.add("promoter-dev");
}

function laneForStage(stage: PipelineStage): ChangeJourney["lanes"][number] {
	if (stage.env === "ryzen" || stage.deliveryMode === "direct-main") return "direct-ryzen";
	if (stage.env === "dev" || stage.deliveryMode === "promoter") return "promoter-dev";
	if (stage.deliveryMode === "dormant") return "dormant";
	return "unknown";
}

function laneForEnv(env: string): ChangeJourney["lanes"][number] {
	if (env === "ryzen") return "direct-ryzen";
	if (env === "dev") return "promoter-dev";
	if (env === "staging") return "dormant";
	return "unknown";
}

function upsertStep(journey: MutableJourney, step: ChangeJourneyStep): void {
	const existing = journey.steps.get(step.id);
	if (!existing || compareIsoDesc(step.at, existing.at) < 0 || stateRank(step.state) > stateRank(existing.state)) {
		journey.steps.set(step.id, step);
	}
	if (step.state === "failed") journey.hasFailure = true;
	if (step.state === "active" || step.state === "waiting") journey.isWaiting = true;
}

function stateRank(state: ChangeJourneyStepState): number {
	switch (state) {
		case "failed":
			return 5;
		case "active":
			return 4;
		case "waiting":
			return 3;
		case "done":
			return 2;
		default:
			return 1;
	}
}

function compareSteps(a: ChangeJourneyStep, b: ChangeJourneyStep): number {
	const kindOrder: Record<ChangeJourneyStepKind, number> = {
		"github-pr": 0,
		"github-push": 0,
		"merge": 1,
		"build": 2,
		"pin": 3,
		"promote": 4,
		"argocd-sync": 5,
		"deploy": 6,
		"event": 7,
	};
	const rank = kindOrder[a.kind] - kindOrder[b.kind];
	if (rank !== 0) return rank;
	return compareIsoAsc(a.at, b.at);
}

function titleForJourney(journey: MutableJourney, services: string[]): string {
	if (journey.pullRequestNumber) {
		return `${journey.repoLabel} PR #${journey.pullRequestNumber}`;
	}
	if (services.length === 1) return services[0]!;
	if (services.length > 1) return `${services.length} service changes`;
	if (journey.sourceCommitSha) return `${journey.repoLabel} ${journey.sourceCommitSha.slice(0, 8)}`;
	if (journey.pinCommitSha) return `release pin ${journey.pinCommitSha.slice(0, 8)}`;
	return journey.repoLabel === "unknown" ? "GitOps change" : `${journey.repoLabel} change`;
}

function subtitleForJourney(
	journey: MutableJourney,
	services: string[],
	environments: string[],
	lanes: string[],
): string | null {
	const parts = [];
	if (journey.branch) parts.push(journey.branch);
	if (services.length > 0) parts.push(services.slice(0, 3).join(", ") + (services.length > 3 ? ` +${services.length - 3}` : ""));
	if (environments.length > 0) parts.push(environments.join(" / "));
	else if (lanes.length > 0) parts.push(lanes.join(" / "));
	return parts.length ? parts.join(" · ") : null;
}

function currentPhaseFor(steps: ChangeJourneyStep[], status: ChangeJourneyStatus): string {
	const failed = steps.find((step) => step.state === "failed");
	if (failed) return failed.label;
	const active = steps.find((step) => step.state === "active" || step.state === "waiting");
	if (active) return active.label;
	const lastDone = [...steps].reverse().find((step) => step.state === "done");
	return lastDone?.label ?? status;
}

function aliasesForViewer(email: string | null | undefined): Set<string> {
	const aliases = new Set<string>();
	if (!email) return aliases;
	const normalized = email.trim().toLowerCase();
	if (!normalized) return aliases;
	aliases.add(normalized);
	const local = normalized.split("@")[0];
	if (local) aliases.add(local);
	return aliases;
}

function eventActors(event: GitOpsActivityEvent): string[] {
	const corr = event.correlation ?? {};
	const values = [
		readString(corr.actor),
		readString(corr.senderLogin),
		readString(corr.sender),
		readString(corr.authorEmail),
		readString(corr.pusherEmail),
		readString(corr.pusherName),
		githubSenderLogin(event),
		githubPusherEmail(event),
	];
	return values.filter((value): value is string => Boolean(value));
}

function normalizeLinks(links?: ChangeJourneyLinks): Required<ChangeJourneyLinks> {
	return {
		argoCdBase: (links?.argoCdBase ?? "https://argocd-hub.tail286401.ts.net").replace(/\/+$/, ""),
		stacksRepo: (links?.stacksRepo ?? "https://github.com/PittampalliOrg/stacks").replace(/\/+$/, ""),
		workflowBuilderRepo: (links?.workflowBuilderRepo ?? "https://github.com/PittampalliOrg/workflow-builder").replace(/\/+$/, ""),
		tektonBase: links?.tektonBase ? links.tektonBase.replace(/\/+$/, "") : null,
	};
}

function argoUrl(base: string | null, env: string, warehouse: string): string | null {
	if (!base || warehouse === BUNDLE_WAREHOUSE) return null;
	return `${base}/applications/${env}/${env}-${warehouse}`;
}

function commitHref(
	repo: string | null,
	sha: string | null,
	links: Required<ChangeJourneyLinks>,
): string | null {
	if (!repo || !sha) return null;
	if (repo.toLowerCase().includes("workflow-builder")) return `${links.workflowBuilderRepo}/commit/${sha}`;
	if (repo.toLowerCase().includes("stacks")) return `${links.stacksRepo}/commit/${sha}`;
	if (repo.includes("/")) return `https://github.com/${repo}/commit/${sha}`;
	return null;
}

function githubPrUrl(
	repo: string | null,
	pr: string,
	links: Required<ChangeJourneyLinks>,
): string | null {
	if (!repo) return null;
	if (repo.toLowerCase().includes("workflow-builder")) return `${links.workflowBuilderRepo}/pull/${pr}`;
	if (repo.toLowerCase().includes("stacks")) return `${links.stacksRepo}/pull/${pr}`;
	if (repo.includes("/")) return `https://github.com/${repo}/pull/${pr}`;
	return null;
}

function selectionForEvent(event: GitOpsActivityEvent, model: PipelineModel): ChangeJourneySelection | null {
	const corr = event.correlation ?? {};
	const app = readString(corr.argocdApp) ?? event.resourceRef.name;
	const env = envFromAppName(app);
	if (app && env) {
		const warehouse = app.slice(`${env}-`.length);
		const stageName = `${warehouse}::${env}`;
		if (model.stages.some((stage) => stage.name === stageName)) {
			return { kind: "stage", id: `stage/${stageName}` };
		}
	}
	const imageName = readString(corr.imageName) ?? imageNameFromRef(readString(corr.imageRef));
	const cluster = readString(corr.cluster);
	if (imageName && cluster) {
		const stageName = `${imageName}::${cluster}`;
		if (model.stages.some((stage) => stage.name === stageName)) {
			return { kind: "stage", id: `stage/${stageName}` };
		}
	}
	if (imageName && model.warehouses.some((warehouse) => warehouse.name === imageName)) {
		return { kind: "warehouse", id: `warehouse/${imageName}` };
	}
	if ((event.source === "promoter" || event.activityType.startsWith("promoter.")) && cluster) {
		const stageName = `${BUNDLE_WAREHOUSE}::${cluster}`;
		if (model.stages.some((stage) => stage.name === stageName)) {
			return { kind: "stage", id: `stage/${stageName}` };
		}
	}
	return null;
}

function eventRepo(event: GitOpsActivityEvent): string | null {
	return readString(event.correlation.repo) ?? githubRepo(event);
}

function eventSourceCommit(event: GitOpsActivityEvent): string | null {
	return (
		readString(event.correlation.commitSha) ??
		readString(event.correlation.sourceSha) ??
		readString(event.correlation.gitSha) ??
		githubCommitSha(event) ??
		null
	);
}

function githubRepo(event: GitOpsActivityEvent): string | null {
	const repo = asRecord(asRecord(event.raw.data)?.body)?.repository ?? asRecord(event.raw.body)?.repository ?? asRecord(event.raw.repository);
	return readString(asRecord(repo)?.full_name);
}

function githubBranch(event: GitOpsActivityEvent): string | null {
	const corr = event.correlation ?? {};
	const explicit = readString(corr.branch);
	if (explicit) return explicit;
	const body = githubBody(event);
	const ref = readString(body.ref);
	if (ref?.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
	const pr = asRecord(body.pull_request);
	return readString(asRecord(pr?.head)?.ref) ?? readString(asRecord(pr?.base)?.ref);
}

function githubCommitSha(event: GitOpsActivityEvent): string | null {
	const body = githubBody(event);
	const pr = asRecord(body.pull_request);
	return (
		readString(body.after) ??
		readString(asRecord(body.head_commit)?.id) ??
		readString(pr?.merge_commit_sha) ??
		readString(asRecord(pr?.head)?.sha)
	);
}

function githubPullRequestNumber(event: GitOpsActivityEvent): string | null {
	const body = githubBody(event);
	return readString(body.number) ?? readString(asRecord(body.pull_request)?.number);
}

function githubMerged(event: GitOpsActivityEvent): boolean | null {
	const body = githubBody(event);
	const value = asRecord(body.pull_request)?.merged;
	return typeof value === "boolean" ? value : null;
}

function githubSenderLogin(event: GitOpsActivityEvent): string | null {
	return readString(asRecord(githubBody(event).sender)?.login);
}

function githubPusherEmail(event: GitOpsActivityEvent): string | null {
	return readString(asRecord(githubBody(event).pusher)?.email);
}

function githubBody(event: GitOpsActivityEvent): Record<string, unknown> {
	const data = asRecord(event.raw.data);
	const body = asRecord(data?.body) ?? asRecord(event.raw.body) ?? event.raw;
	return body;
}

function envFromAppName(name: string | null | undefined): string | null {
	if (!name) return null;
	for (const env of ["ryzen", "dev", "staging"]) {
		if (name.startsWith(`${env}-`)) return env;
	}
	if (name === "spoke-dev-workflow-builder") return "dev";
	return null;
}

function imageNameFromRef(imageRef: string | null): string | null {
	if (!imageRef) return null;
	const withoutDigest = imageRef.split("@", 1)[0] ?? imageRef;
	const withoutTag = withoutDigest.replace(/:[^/:]+$/, "");
	return withoutTag.split("/").at(-1) ?? null;
}

function imageTagFromRef(imageRef: string | null): string | null {
	if (!imageRef) return null;
	const withoutDigest = imageRef.split("@", 1)[0] ?? imageRef;
	const lastSlash = withoutDigest.lastIndexOf("/");
	const lastColon = withoutDigest.lastIndexOf(":");
	return lastColon > lastSlash ? withoutDigest.slice(lastColon + 1) : null;
}

function readString(value: unknown): string | null {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return null;
}

function readBool(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (value.toLowerCase() === "true") return true;
		if (value.toLowerCase() === "false") return false;
	}
	return null;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function newestIso(values: (string | null | undefined)[]): string | null {
	let newest: string | null = null;
	for (const value of values) {
		if (!value) continue;
		if (!newest || Date.parse(value) > Date.parse(newest)) newest = value;
	}
	return newest;
}

function compareIsoAsc(a: string | null | undefined, b: string | null | undefined): number {
	const at = a ? Date.parse(a) : Number.POSITIVE_INFINITY;
	const bt = b ? Date.parse(b) : Number.POSITIVE_INFINITY;
	if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
	if (Number.isNaN(at)) return 1;
	if (Number.isNaN(bt)) return -1;
	return at - bt;
}

function compareIsoDesc(a: string | null | undefined, b: string | null | undefined): number {
	const at = a ? Date.parse(a) : 0;
	const bt = b ? Date.parse(b) : 0;
	return bt - at;
}

function envSort(a: string, b: string): number {
	const order = ["ryzen", "dev", "staging"];
	return (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b));
}

function envStageSort(a: string, b: string): number {
	const [aw, ae] = a.split("::");
	const [bw, be] = b.split("::");
	if (aw !== bw) return aw.localeCompare(bw);
	return envSort(ae ?? "", be ?? "");
}
