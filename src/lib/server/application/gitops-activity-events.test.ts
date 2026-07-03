import { describe, expect, it, vi } from "vitest";

import {
	ApplicationGitOpsActivityEventService,
	type GitOpsActivityEventStore,
} from "$lib/server/application/gitops-activity-events";
import type { GitOpsActivityEvent } from "$lib/types/gitops-activity";

const event: GitOpsActivityEvent = {
	eventId: "evt-1",
	sequence: 1,
	source: "argocd",
	activityKey: "dev-workflow-builder",
	activityType: "argocd.application",
	phase: "Healthy",
	reason: null,
	message: null,
	resourceRef: {
		group: "argoproj.io",
		version: "v1alpha1",
		resource: "applications",
		kind: "Application",
		namespace: "dev",
		name: "dev-workflow-builder",
		uid: "uid",
	},
	observedAt: "2026-06-05T12:00:00Z",
	correlation: {},
	raw: {},
	createdAt: "2026-06-05T12:00:00Z",
	updatedAt: "2026-06-05T12:00:00Z",
};

describe("ApplicationGitOpsActivityEventService", () => {
	it("routes ingest/list/latest/subscribe through the activity event store port", async () => {
		const unlisten = vi.fn(async () => undefined);
		const store: GitOpsActivityEventStore = {
			ingest: vi.fn(async () => event),
			list: vi.fn(async () => [event]),
			getLatestSequence: vi.fn(async () => 7),
			subscribe: vi.fn(async () => unlisten),
		};
		const service = new ApplicationGitOpsActivityEventService(store);
		const payload = { source: "argocd" };
		const onEvent = vi.fn();

		await expect(service.ingest(payload)).resolves.toEqual(event);
		await expect(service.list({ afterSequence: 3, limit: 10 })).resolves.toEqual([
			event,
		]);
		await expect(service.getLatestSequence()).resolves.toBe(7);
		await expect(service.subscribe(onEvent)).resolves.toBe(unlisten);

		expect(store.ingest).toHaveBeenCalledWith(payload);
		expect(store.list).toHaveBeenCalledWith({ afterSequence: 3, limit: 10 });
		expect(store.getLatestSequence).toHaveBeenCalledWith();
		expect(store.subscribe).toHaveBeenCalledWith(onEvent);
	});
});
