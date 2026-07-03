import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireInternal } from "$lib/server/internal-auth";
import { requirePlatformAdmin } from "$lib/server/platform-admin";
import { POST as postIngest } from "./internal/gitops/events/ingest/+server";
import { GET as getEvents } from "./v1/gitops/events/+server";
import { GET as getStream } from "./v1/gitops/events/stream/+server";

const mocks = vi.hoisted(() => ({
	gitOpsActivityEvents: {
		getLatestSequence: vi.fn(),
		ingest: vi.fn(),
		list: vi.fn(),
		subscribe: vi.fn(),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		gitOpsActivityEvents: mocks.gitOpsActivityEvents,
	}),
}));
vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: vi.fn(),
}));
vi.mock("$lib/server/platform-admin", () => ({
	requirePlatformAdmin: vi.fn(),
}));

describe("GitOps activity event APIs", () => {
	beforeEach(() => {
		mocks.gitOpsActivityEvents.getLatestSequence.mockReset();
		mocks.gitOpsActivityEvents.ingest.mockReset();
		mocks.gitOpsActivityEvents.list.mockReset();
		mocks.gitOpsActivityEvents.subscribe.mockReset();
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
		mocks.gitOpsActivityEvents.list.mockResolvedValue([
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
		expect(mocks.gitOpsActivityEvents.list).toHaveBeenCalledWith({
			since: "7",
			afterSequence: 7,
			limit: 25,
		});
	});

	it("ingests internal events behind the shared token gate", async () => {
		mocks.gitOpsActivityEvents.ingest.mockResolvedValue({
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
		expect(mocks.gitOpsActivityEvents.ingest).toHaveBeenCalledWith({ source: "argocd" });
	});

	it("streams events through the activity subscription port", async () => {
		const abort = new AbortController();
		const unlisten = vi.fn().mockResolvedValue(undefined);
		mocks.gitOpsActivityEvents.getLatestSequence.mockResolvedValue(9);
		mocks.gitOpsActivityEvents.list.mockResolvedValueOnce([
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
		mocks.gitOpsActivityEvents.list.mockResolvedValue([]);
		mocks.gitOpsActivityEvents.subscribe.mockResolvedValue(unlisten);

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
			expect(mocks.gitOpsActivityEvents.subscribe).toHaveBeenCalledTimes(1);
		});
		expect(mocks.gitOpsActivityEvents.getLatestSequence).toHaveBeenCalled();
		expect(mocks.gitOpsActivityEvents.list).toHaveBeenCalledWith({
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
		const routeDir = dirname(fileURLToPath(import.meta.url));
		for (const routePath of [
			"internal/gitops/events/ingest/+server.ts",
			"v1/gitops/events/+server.ts",
			"v1/gitops/events/stream/+server.ts",
		]) {
			const source = readFileSync(join(routeDir, routePath), "utf8");
			expect(source).toContain("gitOpsActivityEvents");
			expect(source).not.toContain("$lib/server/gitops/activity-events");
			expect(source).not.toContain("$lib/server/db");
			expect(source).not.toContain("drizzle-orm");
			expect(source).not.toContain(".listen(");
		}
	});
});
