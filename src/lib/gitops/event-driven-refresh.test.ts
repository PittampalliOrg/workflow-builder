import { describe, expect, it } from "vitest";

import {
	isInventoryActivityEvent,
	mergeActivityEvents,
	shouldRefreshGitOpsMetadata,
} from "./event-driven-refresh";
import type { GitOpsActivityEvent } from "$lib/types/gitops-activity";

function event(
	overrides: Partial<Omit<GitOpsActivityEvent, "resourceRef">> & {
		resourceRef?: Partial<GitOpsActivityEvent["resourceRef"]>;
	},
): GitOpsActivityEvent {
	const resource = overrides.resourceRef ?? {};
	const resourceRef: GitOpsActivityEvent["resourceRef"] = {
		group: resource.group ?? null,
		version: resource.version ?? null,
		resource: resource.resource ?? null,
		kind: resource.kind ?? null,
		namespace: resource.namespace ?? null,
		name: resource.name ?? null,
		uid: resource.uid ?? null,
	};
	return {
		eventId: "event-1",
		sequence: 1,
		source: "gitops.unknown",
		activityKey: "unknown",
		activityType: "unknown",
		phase: null,
		reason: null,
		message: null,
		observedAt: "2026-06-05T00:00:00.000Z",
		correlation: {},
		raw: {},
		createdAt: "2026-06-05T00:00:00.000Z",
		updatedAt: "2026-06-05T00:00:00.000Z",
		...overrides,
		resourceRef,
	};
}

describe("shouldRefreshGitOpsMetadata", () => {
	it("matches the resources that feed hub inventory", () => {
		expect(
			shouldRefreshGitOpsMetadata(
				event({ resourceRef: { resource: "pipelineruns", kind: "PipelineRun" } }),
			),
		).toBe(true);
		expect(
			shouldRefreshGitOpsMetadata(
				event({ resourceRef: { resource: "applications", kind: "Application" } }),
			),
		).toBe(true);
		expect(
			shouldRefreshGitOpsMetadata(
				event({ resourceRef: { resource: "promotionstrategies", kind: "PromotionStrategy" } }),
			),
		).toBe(true);
	});

	it("falls back to the known GitOps source names", () => {
		expect(shouldRefreshGitOpsMetadata(event({ source: "gitops.promoter" }))).toBe(true);
		expect(shouldRefreshGitOpsMetadata(event({ source: "gitops.argocd" }))).toBe(true);
		expect(shouldRefreshGitOpsMetadata(event({ source: "gitops.tekton" }))).toBe(true);
	});

	it("ignores unrelated activity", () => {
		expect(
			shouldRefreshGitOpsMetadata(
				event({
					source: "gitops.other",
					resourceRef: { resource: "configmaps", kind: "ConfigMap" },
				}),
			),
		).toBe(false);
	});

	it("refreshes on the hub inventory snapshot event", () => {
		expect(shouldRefreshGitOpsMetadata(event({ activityType: "gitops.inventory" }))).toBe(true);
	});
});

describe("isInventoryActivityEvent", () => {
	it("matches by activityType", () => {
		expect(isInventoryActivityEvent(event({ activityType: "gitops.inventory" }))).toBe(true);
	});

	it("falls back to the ConfigMap resourceRef for pre-classification rows", () => {
		expect(
			isInventoryActivityEvent(
				event({
					resourceRef: { kind: "ConfigMap", name: "gitops-deployment-inventory" },
				}),
			),
		).toBe(true);
	});

	it("does not match other ConfigMaps or events", () => {
		expect(
			isInventoryActivityEvent(
				event({
					resourceRef: { kind: "ConfigMap", name: "gitops-deployment-inventory-scripts" },
				}),
			),
		).toBe(false);
		expect(
			isInventoryActivityEvent(
				event({ resourceRef: { kind: "Application", name: "dev-workflow-builder" } }),
			),
		).toBe(false);
	});
});

describe("mergeActivityEvents", () => {
	it("dedupes by eventId with incoming winning", () => {
		const current = [event({ eventId: "a", sequence: 1, phase: "Running" })];
		const incoming = [event({ eventId: "a", sequence: 1, phase: "Succeeded" })];
		const merged = mergeActivityEvents(current, incoming);
		expect(merged).toHaveLength(1);
		expect(merged[0].phase).toBe("Succeeded");
	});

	it("sorts newest-first by sequence", () => {
		const merged = mergeActivityEvents(
			[event({ eventId: "a", sequence: 1 })],
			[event({ eventId: "b", sequence: 3 }), event({ eventId: "c", sequence: 2 })],
		);
		expect(merged.map((e) => e.sequence)).toEqual([3, 2, 1]);
	});

	it("honors the cap", () => {
		const incoming = Array.from({ length: 10 }, (_, i) =>
			event({ eventId: `e${i}`, sequence: i }),
		);
		const merged = mergeActivityEvents([], incoming, 3);
		expect(merged.map((e) => e.sequence)).toEqual([9, 8, 7]);
	});

	it("is idempotent on re-merge", () => {
		const incoming = [
			event({ eventId: "a", sequence: 1 }),
			event({ eventId: "b", sequence: 2 }),
		];
		const once = mergeActivityEvents([], incoming);
		const twice = mergeActivityEvents(once, incoming);
		expect(twice).toEqual(once);
	});
});
