import { createHash } from "node:crypto";

import type {
	GitOpsActivityEvent,
	GitOpsResourceRef,
} from "$lib/types/gitops-activity";

type JsonRecord = Record<string, unknown>;

type GitOpsActivityType =
	| "github.push"
	| "github.pull_request"
	| "github.event"
	| "tekton.pipelinerun"
	| "tekton.taskrun"
	| "promoter.promotionstrategy"
	| "promoter.changetransferpolicy"
	| "promoter.pullrequest"
	| "promoter.commitstatus"
	| "argocd.application"
	| "gitops.inventory"
	| "kubernetes.resource";

export type NormalizedGitOpsActivityEvent = {
	eventId: string;
	source: string;
	resourceRef: GitOpsResourceRef;
	activityKey: string;
	activityType: string;
	phase: string | null;
	reason: string | null;
	message: string | null;
	observedAt: Date;
	correlation: JsonRecord;
	raw: JsonRecord;
};

export type GitOpsActivityEventRow = {
	eventId: string;
	sequence: number;
	source: string;
	activityKey: string;
	activityType: string;
	phase: string | null;
	reason: string | null;
	message: string | null;
	resourceGroup: string | null;
	resourceVersion: string | null;
	resourceResource: string | null;
	resourceKind: string | null;
	resourceNamespace: string | null;
	resourceName: string | null;
	resourceUid: string | null;
	observedAt: Date;
	correlation: JsonRecord;
	raw: JsonRecord;
	createdAt: Date;
	updatedAt: Date;
};

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export function normalizeGitOpsActivityEvent(payload: unknown): NormalizedGitOpsActivityEvent {
	const input = asRecord(payload) ?? {};
	const rawEnvelope = asRecord(input.raw) ?? asRecord(input.rawEvent) ?? eventEnvelope(input);
	const context = asRecord(rawEnvelope.context) ?? asRecord(input.context) ?? {};
	const data = asRecord(rawEnvelope.data) ?? asRecord(input.data) ?? {};
	const body = normalizeBody(data.body ?? rawEnvelope.body ?? input.body);
	const metadata = asRecord(body.metadata) ?? {};
	const status = asRecord(body.status) ?? {};
	const spec = asRecord(body.spec) ?? {};

	const apiVersion = readString(body.apiVersion);
	const apiParts = parseApiVersion(apiVersion);
	const resourceRef = normalizeResourceRef(input, data, body, metadata, apiParts);
	const source = readString(input.source) ?? (isGitHubBody(body) ? "github" : classifySource(resourceRef));
	const activityType =
		readString(input.activityType) ??
		(isGitHubBody(body) ? classifyGitHubActivityType(body) : classifyActivityType(resourceRef).activityType);
	const observedAt = normalizeDate(
		input.observedAt ??
			context.time ??
			latestTransitionTime(status) ??
			status.completionTime ??
			status.startTime ??
			metadata.creationTimestamp,
	);

	const phase =
		readString(input.phase) ??
		phaseFromResource(resourceRef, data, body, status);
	const reason =
		readString(input.reason) ??
		reasonFromResource(resourceRef, status);
	const message =
		readString(input.message) ??
		messageFromResource(resourceRef, status);
	const correlation = compactObject({
		...extractCorrelation(resourceRef, data, body, metadata, spec, status),
		...asRecord(input.correlation),
	});
	const activityKey =
		readString(input.activityKey) ??
		defaultActivityKey(source, resourceRef, correlation);
	const eventId =
		readString(input.eventId) ??
		deterministicEventId({
			source,
			resourceRef,
			activityType,
			eventType: readString(data.type),
			resourceVersion: readString(metadata.resourceVersion),
			observedAt,
			phase,
			correlation,
		});

	if (lower(resourceRef.kind) === "configmap" || lower(resourceRef.resource) === "configmaps") {
		trimConfigMapRawPayload(rawEnvelope);
	}

	return {
		eventId,
		source,
		resourceRef,
		activityKey,
		activityType,
		phase,
		reason,
		message,
		observedAt,
		correlation,
		raw: rawEnvelope,
	};
}

// ConfigMap bodies can be huge (the inventory ConfigMap embeds the whole
// inventory.json) — keep only structural fields in the persisted raw envelope.
function trimConfigMapRawPayload(rawEnvelope: JsonRecord): void {
	for (const holder of [rawEnvelope, asRecord(rawEnvelope.data)]) {
		if (!holder || !("body" in holder)) continue;
		const body = holder.body;
		if (typeof body === "string") {
			try {
				const parsed = asRecord(JSON.parse(body));
				if (parsed && "data" in parsed) {
					delete parsed.data;
					delete parsed.binaryData;
					holder.body = JSON.stringify(parsed);
				}
			} catch {
				// leave unparseable bodies untouched
			}
			continue;
		}
		const record = asRecord(body);
		if (record) {
			delete record.data;
			delete record.binaryData;
		}
	}
}

export function gitOpsActivityEventStorageValues(
	event: NormalizedGitOpsActivityEvent,
	now: Date = new Date(),
) {
	return {
		eventId: event.eventId,
		source: event.source,
		activityKey: event.activityKey,
		activityType: event.activityType,
		phase: event.phase,
		reason: event.reason,
		message: event.message,
		resourceGroup: event.resourceRef.group,
		resourceVersion: event.resourceRef.version,
		resourceResource: event.resourceRef.resource,
		resourceKind: event.resourceRef.kind,
		resourceNamespace: event.resourceRef.namespace,
		resourceName: event.resourceRef.name,
		resourceUid: event.resourceRef.uid,
		observedAt: event.observedAt,
		correlation: event.correlation,
		raw: event.raw,
		updatedAt: now,
	};
}

export function clampGitOpsActivityEventLimit(limit?: number): number {
	return clampLimit(limit);
}

export function parseGitOpsActivitySinceDate(since?: string | null): Date | null {
	return parseSinceDate(since);
}

export function rowToEvent(row: GitOpsActivityEventRow): GitOpsActivityEvent {
	return {
		eventId: row.eventId,
		sequence: row.sequence,
		source: row.source,
		activityKey: row.activityKey,
		activityType: row.activityType,
		phase: row.phase,
		reason: row.reason,
		message: row.message,
		resourceRef: {
			group: row.resourceGroup,
			version: row.resourceVersion,
			resource: row.resourceResource,
			kind: row.resourceKind,
			namespace: row.resourceNamespace,
			name: row.resourceName,
			uid: row.resourceUid,
		},
		observedAt: row.observedAt.toISOString(),
		correlation: row.correlation,
		raw: row.raw,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function eventEnvelope(input: JsonRecord): JsonRecord {
	if (asRecord(input.context) || asRecord(input.data)) return input;
	return { data: { body: input } };
}

function normalizeBody(value: unknown): JsonRecord {
	if (typeof value === "string") {
		try {
			return asRecord(JSON.parse(value)) ?? { value };
		} catch {
			return { value };
		}
	}
	return asRecord(value) ?? {};
}

function normalizeResourceRef(
	input: JsonRecord,
	data: JsonRecord,
	body: JsonRecord,
	metadata: JsonRecord,
	apiParts: { group: string | null; version: string | null },
): GitOpsResourceRef {
	const explicit = asRecord(input.resourceRef) ?? {};
	const githubRepo = asRecord(body.repository);
	if (!Object.keys(explicit).length && githubRepo) {
		const fullName = readString(githubRepo.full_name);
		const [owner, name] = fullName?.split("/") ?? [];
		return {
			group: "github.com",
			version: "v3",
			resource: asRecord(body.pull_request) ? "pullrequests" : "pushes",
			kind: asRecord(body.pull_request) ? "PullRequest" : "Push",
			namespace: owner ?? null,
			name: name ?? fullName ?? null,
			uid: readString(body.delivery) ?? null,
		};
	}
	const resource = readString(explicit.resource) ?? readString(data.resource);
	const kind =
		readString(explicit.kind) ??
		readString(body.kind) ??
		kindFromResource(resource);
	return {
		group:
			readString(explicit.group) ??
			readString(data.group) ??
			apiParts.group,
		version:
			readString(explicit.version) ??
			readString(data.version) ??
			apiParts.version,
		resource,
		kind,
		namespace:
			readString(explicit.namespace) ??
			readString(metadata.namespace),
		name:
			readString(explicit.name) ??
			readString(metadata.name),
		uid:
			readString(explicit.uid) ??
			readString(metadata.uid),
	};
}

function classifySource(ref: GitOpsResourceRef): string {
	if (ref.group === "tekton.dev") return "tekton";
	if (ref.group === "promoter.argoproj.io") return "promoter";
	if (ref.group === "argoproj.io" && lower(ref.kind) === "application") return "argocd";
	if (isInventoryConfigMapRef(ref)) return "inventory";
	return "kubernetes";
}

// The hub `gitops-deployment-inventory` ConfigMap UPDATE is the signal that a
// fresh inventory snapshot is available — it drives metadata refresh, not the
// user-visible activity feed.
export const GITOPS_INVENTORY_CONFIGMAP_NAME = "gitops-deployment-inventory";

function isInventoryConfigMapRef(ref: GitOpsResourceRef): boolean {
	if (ref.group !== "" && ref.group !== null) return false;
	const kind = lower(ref.kind);
	const resource = lower(ref.resource);
	if (kind !== "configmap" && resource !== "configmaps") return false;
	return ref.name === GITOPS_INVENTORY_CONFIGMAP_NAME;
}

function classifyActivityType(ref: GitOpsResourceRef): { activityType: GitOpsActivityType } {
	const kind = lower(ref.kind);
	const resource = lower(ref.resource);
	if (ref.group === "tekton.dev" && (kind === "pipelinerun" || resource === "pipelineruns")) {
		return { activityType: "tekton.pipelinerun" };
	}
	if (ref.group === "tekton.dev" && (kind === "taskrun" || resource === "taskruns")) {
		return { activityType: "tekton.taskrun" };
	}
	if (ref.group === "promoter.argoproj.io") {
		if (kind === "promotionstrategy" || resource === "promotionstrategies") {
			return { activityType: "promoter.promotionstrategy" };
		}
		if (kind === "changetransferpolicy" || resource === "changetransferpolicies") {
			return { activityType: "promoter.changetransferpolicy" };
		}
		if (kind === "pullrequest" || resource === "pullrequests") {
			return { activityType: "promoter.pullrequest" };
		}
		if (kind === "commitstatus" || resource === "commitstatuses") {
			return { activityType: "promoter.commitstatus" };
		}
		if (kind === "argocdcommitstatus" || resource === "argocdcommitstatuses") {
			return { activityType: "promoter.commitstatus" };
		}
		if (kind === "timedcommitstatus" || resource === "timedcommitstatuses") {
			return { activityType: "promoter.commitstatus" };
		}
	}
	if (ref.group === "argoproj.io" && (kind === "application" || resource === "applications")) {
		return { activityType: "argocd.application" };
	}
	if (isInventoryConfigMapRef(ref)) {
		return { activityType: "gitops.inventory" };
	}
	return { activityType: "kubernetes.resource" };
}

function classifyGitHubActivityType(body: JsonRecord): GitOpsActivityType {
	if (asRecord(body.pull_request)) return "github.pull_request" as GitOpsActivityType;
	if (readString(body.ref) || Array.isArray(body.commits)) return "github.push" as GitOpsActivityType;
	return "github.event" as GitOpsActivityType;
}

function phaseFromResource(
	ref: GitOpsResourceRef,
	data: JsonRecord,
	body: JsonRecord,
	status: JsonRecord,
): string | null {
	const condition = succeededCondition(status);
	if (condition) {
		const conditionStatus = readString(condition.status);
		if (conditionStatus === "True") return "Succeeded";
		if (conditionStatus === "False") return "Failed";
		if (conditionStatus === "Unknown") return "Running";
	}
	if (ref.group === "argoproj.io" && lower(ref.kind) === "application") {
		const health = asRecord(status.health);
		const sync = asRecord(status.sync);
		return readString(health?.status) ?? readString(sync?.status);
	}
	if (ref.group === "promoter.argoproj.io") {
		const health = asRecord(status.health);
		return (
			readString(status.phase) ??
			readString(health?.status) ??
			promoterPhase(body)
		);
	}
	return readString(status.phase) ?? readString(data.type);
}

function reasonFromResource(ref: GitOpsResourceRef, status: JsonRecord): string | null {
	const condition = succeededCondition(status);
	if (condition) return readString(condition.reason);
	if (ref.group === "argoproj.io" && lower(ref.kind) === "application") {
		const operation = asRecord(status.operationState);
		const sync = asRecord(status.sync);
		return readString(operation?.phase) ?? readString(sync?.status);
	}
	return readString(status.reason);
}

function messageFromResource(ref: GitOpsResourceRef, status: JsonRecord): string | null {
	const condition = succeededCondition(status);
	if (condition) return readString(condition.message);
	if (ref.group === "argoproj.io" && lower(ref.kind) === "application") {
		const health = asRecord(status.health);
		return readString(health?.message);
	}
	return readString(status.message);
}

function extractCorrelation(
	ref: GitOpsResourceRef,
	data: JsonRecord,
	body: JsonRecord,
	metadata: JsonRecord,
	spec: JsonRecord,
	status: JsonRecord,
): JsonRecord {
	const labels = asRecord(metadata.labels) ?? {};
	const annotations = asRecord(metadata.annotations) ?? {};
	const params = paramsMap(spec.params);
	const pipelineResults = {
		...resultsMap(status.pipelineResults),
		...resultsMap(status.results),
	};
	const sync = asRecord(status.sync) ?? {};
	const promotion = asRecord(body.status) ?? {};
	const appName = ref.group === "argoproj.io" ? ref.name : null;
	const branch =
		readString(spec.branch) ??
		readString(spec.targetBranch) ??
		readString(spec.sourceBranch) ??
		readString(labels["promoter.argoproj.io/environment"]) ??
		branchFromPromoterStatus(promotion);
	const imageRef =
		readString(pipelineResults.image_ref) ??
		readString(pipelineResults.IMAGE_REF) ??
		readString(params.image_ref) ??
		readString(params.image);
	const gitSha =
		readString(params.git_sha) ??
		readString(params.git_revision) ??
		readString(params.git_revision_short) ??
		readString(labels["workflow-builder.io/git-sha"]) ??
		commitShaFromImage(imageRef) ??
		readString(sync.revision);
	const imageName =
		readString(params.image_name) ??
		readString(labels["workflow-builder.io/image-name"]) ??
		imageNameFromRef(imageRef);
	const pipelineRun =
		ref.resource === "pipelineruns" || ref.kind === "PipelineRun"
			? ref.name
			: readString(labels["tekton.dev/pipelineRun"]) ?? readString(params.pipeline_run);

	return compactObject({
		cluster: clusterFromNamespace(ref.namespace),
		eventType: readString(data.type),
		pipelineRun,
		taskRun: ref.kind === "TaskRun" ? ref.name : null,
		pipelineTask: readString(labels["tekton.dev/pipelineTask"]),
		// dev-env-v2 lane correlation: the pr-preview dispatch + dev-image rebuild
		// pipelines stamp these (TriggerTemplate-pr-preview-dispatch /
		// TriggerTemplate-dev-images on the hub). `buildLoop` is `pr-preview` for
		// preview runs, `outer` for the dev-images pipeline (keyed on run name).
		pullRequestNumber: readString(params.pr_number) ?? readString(labels["stacks.io/pr-number"]),
		buildLoop: readString(labels["stacks.io/build-loop"]),
		imageName,
		imageRef,
		imageDigest:
			readString(pipelineResults.image_digest) ??
			readString(pipelineResults.IMAGE_DIGEST),
		gitSha,
		argocdApp: appName,
		syncRevision: readString(sync.revision),
		syncStatus: readString(sync.status),
		healthStatus: readString(asRecord(status.health)?.status),
		branch,
		drySha:
			readString(promotion.drySha) ??
			readString(annotations["promoter.argoproj.io/dry-sha"]),
		hydratedSha:
			readString(promotion.hydratedSha) ??
			readString(annotations["promoter.argoproj.io/hydrated-sha"]),
		commitStatusKey:
			ref.kind === "CommitStatus" ||
			ref.kind === "ArgoCDCommitStatus" ||
			ref.kind === "TimedCommitStatus"
				? ref.name
				: readString(labels["promoter.argoproj.io/commit-status-key"]),
		...extractGitHubCorrelation(body),
	});
}

function extractGitHubCorrelation(body: JsonRecord): JsonRecord {
	if (!isGitHubBody(body)) return {};
	const repo = asRecord(body.repository);
	const repoFullName = readString(repo?.full_name);
	const pr = asRecord(body.pull_request);
	const head = asRecord(pr?.head);
	const base = asRecord(pr?.base);
	const ref = readString(body.ref);
	const branch = ref?.startsWith("refs/heads/")
		? ref.slice("refs/heads/".length)
		: readString(head?.ref) ?? readString(base?.ref);
	const commitSha =
		readString(body.after) ??
		readString(asRecord(body.head_commit)?.id) ??
		readString(pr?.merge_commit_sha) ??
		readString(head?.sha);
	const files = githubChangedFiles(body);
	const imageName = imageNameFromGitHubFiles(files);
	const pinCommit =
		repoFullName?.toLowerCase().endsWith("/stacks") && files.some(isReleasePinPath)
			? commitSha
			: null;
	const title = readString(pr?.title) ?? readString(asRecord(body.head_commit)?.message);
	// D1 preview lifecycle signal: the PR carries (or the event just applied) the
	// `preview` label that gates a per-PR preview.
	const previewLabeled = hasPreviewLabel(body);
	return compactObject({
		repo: repoFullName,
		branch,
		targetBranch: readString(base?.ref),
		commitSha,
		pullRequestNumber: readString(body.number) ?? readString(pr?.number),
		pullRequestUrl: readString(pr?.html_url),
		merged: typeof pr?.merged === "boolean" ? pr.merged : null,
		title,
		// PR webhook action (opened/closed/labeled/synchronize/reopened) — lets the
		// journey model distinguish a preview label event from a code push.
		prAction: readString(body.action),
		previewLabeled: previewLabeled ? true : null,
		actor: readString(asRecord(body.sender)?.login),
		senderLogin: readString(asRecord(body.sender)?.login),
		pusherEmail: readString(asRecord(body.pusher)?.email),
		authorEmail: readString(asRecord(asRecord(body.head_commit)?.author)?.email),
		imageName,
		pinCommit,
		expectedGitOpsLane: expectedGitOpsLane(repoFullName, branch, files, { title, previewLabeled }),
	});
}

/** True when the `preview` label is on the PR (or is the label this event just
 * added/removed) — gates the per-PR preview pipeline. */
function hasPreviewLabel(body: JsonRecord): boolean {
	const single = asRecord(body.label);
	if (readString(single?.name)?.toLowerCase() === "preview") return true;
	const pr = asRecord(body.pull_request);
	const labels = Array.isArray(pr?.labels) ? pr.labels : [];
	return labels.some((item) => readString(asRecord(item)?.name)?.toLowerCase() === "preview");
}

function isGitHubBody(body: JsonRecord): boolean {
	return Boolean(asRecord(body.repository) && (readString(body.ref) || asRecord(body.pull_request) || Array.isArray(body.commits)));
}

function githubChangedFiles(body: JsonRecord): string[] {
	const files = new Set<string>();
	const commits = Array.isArray(body.commits) ? body.commits : [];
	for (const item of commits) {
		const commit = asRecord(item);
		for (const key of ["added", "modified", "removed"] as const) {
			const paths = Array.isArray(commit?.[key]) ? commit[key] : [];
			for (const path of paths) {
				const value = readString(path);
				if (value) files.add(value);
			}
		}
	}
	const pr = asRecord(body.pull_request);
	for (const item of [readString(pr?.changed_files)]) {
		if (item) files.add(item);
	}
	return [...files];
}

function imageNameFromGitHubFiles(files: string[]): string | null {
	for (const path of files) {
		const match = path.match(/^services\/([^/]+)\//);
		if (match?.[1]) return match[1];
	}
	return null;
}

function isReleasePinPath(path: string): boolean {
	return (
		path.includes("release-pins/workflow-builder-images") ||
		path.includes("workflow-builder-system-overlays") ||
		path.includes("workflow-builder-ryzen-image")
	);
}

function expectedGitOpsLane(
	repo: string | null,
	branch: string | null,
	files: string[],
	opts: { title?: string | null; previewLabeled?: boolean } = {},
): string | null {
	const lowerRepo = repo?.toLowerCase() ?? "";
	// New dev-env-v2 lanes are resolved BEFORE the branch-substring branches: a
	// `preview`-labeled PR and a `chore(dev-images):` pin bump both otherwise fall
	// through to promoter-dev (the "dev" substring foot-gun this fixes downstream).
	if (opts.previewLabeled) return "pr-preview";
	const title = opts.title?.toLowerCase() ?? "";
	if (title.startsWith("chore(dev-images)") || files.some(isDevImagePinPath)) return "dev-images";
	if (branch?.includes("spokes-dev")) return "promoter-dev";
	if (branch?.includes("ryzen")) return "direct-ryzen";
	if (lowerRepo.endsWith("/workflow-builder") && branch === "main") {
		return files.some((path) => path.startsWith("services/") || path.startsWith("src/") || path === "Dockerfile" || path === "package.json")
			? "promoter-dev"
			: "skipped";
	}
	if (lowerRepo.endsWith("/stacks") && branch === "main") return "direct-ryzen+promoter-dev";
	return null;
}

/** Dev-preview image pins (the `outer-loop-dev-images` lane targets) live in the
 * preview overlay + dev deployments, distinct from the prod release-pins path. */
function isDevImagePinPath(path: string): boolean {
	return path.includes("workflow-builder-preview");
}

function defaultActivityKey(
	source: string,
	ref: GitOpsResourceRef,
	correlation: JsonRecord,
): string {
	if (typeof correlation.imageName === "string" && correlation.cluster) {
		return `${correlation.imageName}:${correlation.cluster}`;
	}
	if (typeof correlation.imageName === "string") return correlation.imageName;
	if (typeof correlation.argocdApp === "string") return correlation.argocdApp;
	return [source, ref.kind ?? ref.resource ?? "resource", `${ref.namespace ?? "_cluster"}/${ref.name ?? "_"}`]
		.join(":")
		.toLowerCase();
}

function deterministicEventId(input: {
	source: string;
	resourceRef: GitOpsResourceRef;
	activityType: string;
	eventType: string | null;
	resourceVersion: string | null;
	observedAt: Date;
	phase: string | null;
	correlation: JsonRecord;
}): string {
	const stable = JSON.stringify({
		source: input.source,
		activityType: input.activityType,
		eventType: input.eventType,
		resource: input.resourceRef,
		resourceVersion: input.resourceVersion,
		observedAt: input.resourceVersion ? null : input.observedAt.toISOString(),
		phase: input.phase,
		correlation: input.correlation,
	});
	return `gitops_${createHash("sha256").update(stable).digest("hex").slice(0, 32)}`;
}

function succeededCondition(status: JsonRecord): JsonRecord | null {
	const conditions = Array.isArray(status.conditions) ? status.conditions : [];
	for (const condition of conditions) {
		const row = asRecord(condition);
		if (readString(row?.type) === "Succeeded") return row;
	}
	return null;
}

function latestTransitionTime(status: JsonRecord): string | null {
	const conditions = Array.isArray(status.conditions) ? status.conditions : [];
	let latest: string | null = null;
	for (const condition of conditions) {
		const transition = readString(asRecord(condition)?.lastTransitionTime);
		if (!transition) continue;
		if (!latest || new Date(transition).getTime() > new Date(latest).getTime()) latest = transition;
	}
	return latest;
}

function promoterPhase(body: JsonRecord): string | null {
	const status = asRecord(body.status);
	const environments = Array.isArray(status?.environments) ? status.environments : [];
	if (environments.some((env) => asRecord(env)?.proposed)) return "Progressing";
	if (environments.some((env) => asRecord(env)?.active)) return "Ready";
	return null;
}

function paramsMap(value: unknown): JsonRecord {
	const out: JsonRecord = {};
	if (!Array.isArray(value)) return out;
	for (const item of value) {
		const row = asRecord(item);
		const name = readString(row?.name);
		if (!name) continue;
		out[name] = row?.value;
	}
	return out;
}

function resultsMap(value: unknown): JsonRecord {
	const out: JsonRecord = {};
	if (!Array.isArray(value)) return out;
	for (const item of value) {
		const row = asRecord(item);
		const name = readString(row?.name);
		if (!name) continue;
		out[name] = row?.value;
	}
	return out;
}

function parseApiVersion(apiVersion: string | null): { group: string | null; version: string | null } {
	if (!apiVersion) return { group: null, version: null };
	const parts = apiVersion.split("/");
	if (parts.length === 1) return { group: "", version: parts[0] ?? null };
	return { group: parts.slice(0, -1).join("/"), version: parts.at(-1) ?? null };
}

function kindFromResource(resource: string | null | undefined): string | null {
	if (!resource) return null;
	const singular = resource.endsWith("ies")
		? `${resource.slice(0, -3)}y`
		: resource.endsWith("s")
			? resource.slice(0, -1)
			: resource;
	return singular
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

function branchFromPromoterStatus(status: JsonRecord): string | null {
	const environments = Array.isArray(status.environments) ? status.environments : [];
	for (const item of environments) {
		const env = asRecord(item);
		const branch = readString(env?.branch);
		if (branch) return branch;
	}
	return null;
}

function clusterFromNamespace(namespace: string | null): string | null {
	if (namespace === "dev" || namespace === "ryzen" || namespace === "staging") return namespace;
	return null;
}

function imageNameFromRef(imageRef: string | null): string | null {
	if (!imageRef) return null;
	const withoutDigest = imageRef.split("@", 1)[0] ?? imageRef;
	const withoutTag = withoutDigest.replace(/:[^/:]+$/, "");
	const name = withoutTag.split("/").at(-1);
	return name || null;
}

function commitShaFromImage(imageRef: string | null): string | null {
	if (!imageRef) return null;
	const match = imageRef.match(/:git-([0-9a-f]{7,40})(?:@|$)/i);
	return match?.[1]?.toLowerCase() ?? null;
}

function normalizeDate(value: unknown): Date {
	if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
	if (typeof value === "string" || typeof value === "number") {
		const date = new Date(value);
		if (!Number.isNaN(date.getTime())) return date;
	}
	return new Date();
}

function parseSinceDate(value: string | null | undefined): Date | null {
	if (!value || /^\d+$/.test(value)) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function asRecord(value: unknown): JsonRecord | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function readString(value: unknown): string | null {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return null;
}

function lower(value: unknown): string {
	return typeof value === "string" ? value.toLowerCase() : "";
}

function compactObject(value: JsonRecord): JsonRecord {
	const out: JsonRecord = {};
	for (const [key, item] of Object.entries(value)) {
		if (item === undefined || item === null || item === "") continue;
		out[key] = item;
	}
	return out;
}

function clampLimit(limit: number | null | undefined): number {
	if (!Number.isFinite(limit ?? NaN)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(Number(limit))));
}
