import { nanoid } from "nanoid";
import type {
	PublishedRuntimeMetadata,
	PublishedWorkflowRevision,
} from "@/lib/workflow-spec/types";

export function buildPublishedWorkflowName(workflowId: string): string {
	return `wf_${workflowId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export function buildPublishedVersion(): string {
	return `pub_${Date.now()}_${nanoid(6).toLowerCase()}`;
}

export function extractPublishedRuntime(
	spec: unknown,
): PublishedRuntimeMetadata | null {
	if (!spec || typeof spec !== "object") {
		return null;
	}
	const metadata = (spec as Record<string, unknown>).metadata;
	if (!metadata || typeof metadata !== "object") {
		return null;
	}
	const publishedRuntime = (metadata as Record<string, unknown>)
		.publishedRuntime;
	if (!publishedRuntime || typeof publishedRuntime !== "object") {
		return null;
	}
	return publishedRuntime as PublishedRuntimeMetadata;
}

export function sanitizePublishedRevisions(
	revisions: PublishedWorkflowRevision[] | unknown,
): PublishedWorkflowRevision[] {
	if (!Array.isArray(revisions)) {
		return [];
	}
	return revisions.filter((revision): revision is PublishedWorkflowRevision => {
		if (!revision || typeof revision !== "object") {
			return false;
		}
		const candidate = revision as Record<string, unknown>;
		return (
			typeof candidate.version === "string" &&
			candidate.version.length > 0 &&
			typeof candidate.publishedAt === "string" &&
			candidate.publishedAt.length > 0 &&
			candidate.definition !== null &&
			typeof candidate.definition === "object"
		);
	});
}

export function resolvePublishedRevision(
	publishedRuntime: PublishedRuntimeMetadata | null,
	version: string,
): PublishedWorkflowRevision | null {
	if (!publishedRuntime) {
		return null;
	}
	const revisions = sanitizePublishedRevisions(publishedRuntime.revisions);
	if (revisions.length === 0) {
		return null;
	}
	if (version === "latest") {
		return (
			revisions.find(
				(revision) => revision.version === publishedRuntime.latestVersion,
			) ?? revisions[revisions.length - 1]!
		);
	}
	return revisions.find((revision) => revision.version === version) ?? null;
}
