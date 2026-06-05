import { createHash } from "node:crypto";
import { and, asc, desc, gt, gte, sql as drizzleSql } from "drizzle-orm";

import { db } from "$lib/server/db";
import {
	gitopsActivityEvents,
	type GitOpsActivityType,
} from "$lib/server/db/schema";
import type {
	GitOpsActivityEvent,
	GitOpsResourceRef,
} from "$lib/types/gitops-activity";

type JsonRecord = Record<string, unknown>;

type NormalizedGitOpsActivityEvent = {
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

type ListOptions = {
	limit?: number;
	since?: string | null;
	afterSequence?: number | null;
	ascending?: boolean;
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
	const source = readString(input.source) ?? classifySource(resourceRef);
	const activityType =
		readString(input.activityType) ??
		classifyActivityType(resourceRef).activityType;
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
		...asRecord(input.correlation),
		...extractCorrelation(resourceRef, data, body, metadata, spec, status),
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

export async function ingestGitOpsActivityEvent(payload: unknown): Promise<GitOpsActivityEvent> {
	const event = normalizeGitOpsActivityEvent(payload);
	const database = requireDb();
	const values = {
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
		updatedAt: new Date(),
	};
	const [row] = await database
		.insert(gitopsActivityEvents)
		.values(values)
		.onConflictDoUpdate({
			target: gitopsActivityEvents.eventId,
			set: {
				source: drizzleSql`excluded.source`,
				activityKey: drizzleSql`excluded.activity_key`,
				activityType: drizzleSql`excluded.activity_type`,
				phase: drizzleSql`excluded.phase`,
				reason: drizzleSql`excluded.reason`,
				message: drizzleSql`excluded.message`,
				resourceGroup: drizzleSql`excluded.resource_group`,
				resourceVersion: drizzleSql`excluded.resource_version`,
				resourceResource: drizzleSql`excluded.resource_resource`,
				resourceKind: drizzleSql`excluded.resource_kind`,
				resourceNamespace: drizzleSql`excluded.resource_namespace`,
				resourceName: drizzleSql`excluded.resource_name`,
				resourceUid: drizzleSql`excluded.resource_uid`,
				observedAt: drizzleSql`excluded.observed_at`,
				correlation: drizzleSql`excluded.correlation`,
				raw: drizzleSql`excluded.raw`,
				updatedAt: new Date(),
			},
		})
		.returning();
	return rowToEvent(row);
}

export async function listGitOpsActivityEvents(
	options: ListOptions = {},
): Promise<GitOpsActivityEvent[]> {
	const database = requireDb();
	const limit = clampLimit(options.limit);
	const conditions = [];
	if (Number.isFinite(options.afterSequence ?? NaN)) {
		conditions.push(gt(gitopsActivityEvents.sequence, Number(options.afterSequence)));
	}
	const sinceDate = parseSinceDate(options.since);
	if (sinceDate) {
		conditions.push(gte(gitopsActivityEvents.observedAt, sinceDate));
	}
	const order = options.ascending
		? [asc(gitopsActivityEvents.sequence)]
		: [desc(gitopsActivityEvents.observedAt), desc(gitopsActivityEvents.sequence)];
	const query = database
		.select()
		.from(gitopsActivityEvents)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(...order)
		.limit(limit);
	const rows = await query;
	return rows.map(rowToEvent);
}

export async function getLatestGitOpsActivitySequence(): Promise<number> {
	const database = requireDb();
	const [row] = await database
		.select({ sequence: gitopsActivityEvents.sequence })
		.from(gitopsActivityEvents)
		.orderBy(desc(gitopsActivityEvents.sequence))
		.limit(1);
	return row?.sequence ?? 0;
}

export function rowToEvent(row: typeof gitopsActivityEvents.$inferSelect): GitOpsActivityEvent {
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

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
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
	return "kubernetes";
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
	return { activityType: "kubernetes.resource" };
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
	});
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
