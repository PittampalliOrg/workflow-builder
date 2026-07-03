import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	getLatestGitOpsActivitySequence,
	ingestGitOpsActivityEvent,
	listGitOpsActivityEvents,
	subscribeGitOpsActivityEvents,
} from "$lib/server/gitops/activity-events";
import { requireInternal } from "$lib/server/internal-auth";
import { requirePlatformAdmin } from "$lib/server/platform-admin";
import { POST as postIngest } from "./internal/gitops/events/ingest/+server";
import { GET as getEvents } from "./v1/gitops/events/+server";
import { GET as getStream } from "./v1/gitops/events/stream/+server";

vi.mock("$lib/server/gitops/activity-events", () => ({
	getLatestGitOpsActivitySequence: vi.fn(),
	ingestGitOpsActivityEvent: vi.fn(),
	listGitOpsActivityEvents: vi.fn(),
	subscribeGitOpsActivityEvents: vi.fn(),
}));
vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: vi.fn(),
}));
vi.mock("$lib/server/platform-admin", () => ({
	requirePlatformAdmin: vi.fn(),
}));

describe("GitOps activity event APIs", () => {
	beforeEach(() => {
		vi.mocked(getLatestGitOpsActivitySequence).mockReset();
		vi.mocked(ingestGitOpsActivityEvent).mockReset();
		vi.mocked(listGitOpsActivityEvents).mockReset();
		vi.mocked(subscribeGitOpsActivityEvents).mockReset();
		vi.mocked(requireInternal).mockReset();
		vi.mocked(requirePlatformAdmin).mockReset();
	});

	it("rejects non-admin event list callers", async () => {
		const forbidden = Object.assign(new Error("Admin access required"), { status: 403 });
		vi.mocked(requirePlatformAdmin).mockRejectedValue(forbidden);

		await expect(
			getEvents({
				locals: { session: { userId: "member-1" } },
				url: new URL("http://localhost/api/v1/gitops/events"),
			} as never),
		).rejects.toMatchObject({ status: 403 });
	});

	it("lists durable events for admins with since replay", async () => {
		vi.mocked(listGitOpsActivityEvents).mockResolvedValue([
			{
				eventId: "evt-1",
				sequence: 8,
				source: "tekton",
				activityKey: "workflow-builder:dev",
				activityType: "tekton.pipelinerun",
				phase: "Running",
				reason: null,
				message: null,
				resourceRef: {
					group: "tekton.dev",
					version: "v1",
					resource: "pipelineruns",
					kind: "PipelineRun",
					namespace: "tekton-pipelines",
					name: "pr",
					uid: "uid",
				},
				observedAt: "2026-06-05T12:00:00Z",
				correlation: {},
				raw: {},
				createdAt: "2026-06-05T12:00:00Z",
				updatedAt: "2026-06-05T12:00:00Z",
			},
		]);

		const response = (await getEvents({
			locals: { session: { userId: "admin-1" } },
			url: new URL("http://localhost/api/v1/gitops/events?since=7&limit=25"),
		} as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			events: [{ eventId: "evt-1", sequence: 8 }],
		});
		expect(listGitOpsActivityEvents).toHaveBeenCalledWith({
			since: "7",
			afterSequence: 7,
			limit: 25,
		});
	});

	it("ingests internal events behind the shared token gate", async () => {
		vi.mocked(ingestGitOpsActivityEvent).mockResolvedValue({
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
		});

		const response = (await postIngest({
			request: new Request("http://localhost/api/internal/gitops/events/ingest", {
				method: "POST",
				body: JSON.stringify({ source: "argocd" }),
			}),
		} as never)) as Response;

		expect(response.status).toBe(202);
		expect(requireInternal).toHaveBeenCalled();
		expect(ingestGitOpsActivityEvent).toHaveBeenCalledWith({ source: "argocd" });
	});

	it("streams events through the activity subscription port", async () => {
		const abort = new AbortController();
		const unlisten = vi.fn().mockResolvedValue(undefined);
		vi.mocked(getLatestGitOpsActivitySequence).mockResolvedValue(9);
		vi.mocked(listGitOpsActivityEvents).mockResolvedValueOnce([
			{
				eventId: "evt-10",
				sequence: 10,
				source: "tekton",
				activityKey: "workflow-builder:dev",
				activityType: "tekton.pipelinerun",
				phase: "Succeeded",
				reason: null,
				message: null,
				resourceRef: {
					group: "tekton.dev",
					version: "v1",
					resource: "pipelineruns",
					kind: "PipelineRun",
					namespace: "tekton-pipelines",
					name: "pr",
					uid: "uid",
				},
				observedAt: "2026-06-05T12:00:00Z",
				correlation: {},
				raw: {},
				createdAt: "2026-06-05T12:00:00Z",
				updatedAt: "2026-06-05T12:00:00Z",
			},
		]);
		vi.mocked(listGitOpsActivityEvents).mockResolvedValue([]);
		vi.mocked(subscribeGitOpsActivityEvents).mockResolvedValue(unlisten);

		const response = (await getStream({
			locals: { session: { userId: "admin-1" } },
			request: new Request("http://localhost/api/v1/gitops/events/stream?since=latest", {
				signal: abort.signal,
			}),
			url: new URL("http://localhost/api/v1/gitops/events/stream?since=latest"),
		} as never)) as Response;

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		await vi.waitFor(() => {
			expect(subscribeGitOpsActivityEvents).toHaveBeenCalledTimes(1);
		});
		expect(getLatestGitOpsActivitySequence).toHaveBeenCalled();
		expect(listGitOpsActivityEvents).toHaveBeenCalledWith({
			afterSequence: 9,
			ascending: true,
			limit: 500,
		});

		abort.abort();
		await vi.waitFor(() => {
			expect(unlisten).toHaveBeenCalled();
		});
	});

	it("keeps the stream route free of direct DB imports", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "v1/gitops/events/stream/+server.ts"),
			"utf8",
		);

		expect(source).toContain("subscribeGitOpsActivityEvents");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain(".listen(");
	});
});
