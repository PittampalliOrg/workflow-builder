import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewDatabaseProvisioner } from "$lib/server/application/ports";
import {
	provisionDevPreview,
	provisionDevPreviews,
	type DevPreviewPersistence,
} from "./dev-preview";

function fakePersistence(): DevPreviewPersistence {
	return {
		upsertWorkflowWorkspaceSession: vi.fn(async (input) => ({
			workspaceRef: input.workspaceRef,
		})),
		listWorkflowWorkspaceSessionsByExecutionId: vi.fn(async () => []),
		markWorkflowWorkspaceSessionCleaned: vi.fn(async () => true),
		getExecutionById: vi.fn(async () => ({
			id: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		})),
		persistSourceBundleArtifact: vi.fn(async () => ({
			id: "artifact-1",
			fileId: "file-1",
			bytes: 12,
		})),
	};
}

function fakePreviewDatabases(): PreviewDatabaseProvisioner {
	return {
		provision: vi.fn(async () => ({
			databaseUrl: "postgres://preview-db",
			sourceUrl: "postgres://source-db",
			dbName: "preview_exec1",
		})),
		drop: vi.fn(async () => undefined),
	};
}

describe("dev-preview portability boundary", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("keeps dev-preview persistence behind an injected port", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "dev-preview.ts"),
			"utf8",
		);

		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("from \"postgres\"");
		expect(source).not.toContain("workflows/preview-database");
		expect(source).not.toContain("$lib/server/files/registry");
		expect(source).not.toContain("persistSourceBundle(");
	});

	it("persists provisioned preview sessions through the injected port", async () => {
		vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
		const fetchMock = vi.fn(async () =>
			new Response(
				JSON.stringify({
					sandboxName: "dev-preview-exec-1",
					podIP: "10.0.0.12",
					port: 8080,
					syncPort: 8001,
					url: "http://10.0.0.12:8080",
					syncUrl: "http://10.0.0.12:8001/__sync",
					ready: true,
					status: "running",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		const persistence = fakePersistence();

		const info = await provisionDevPreview(
			{
				executionId: "exec-1",
				service: "function-router",
			},
			persistence,
		);

		expect(info.sandboxName).toBe("dev-preview-exec-1");
		expect(fetchMock).toHaveBeenCalledWith(
			"http://sandbox-api/internal/dev-preview",
			expect.objectContaining({ method: "POST" }),
		);
		expect(persistence.upsertWorkflowWorkspaceSession).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceRef: "dev-preview-exec-1",
				workflowExecutionId: "exec-1",
				name: "dev-preview",
				backend: "juicefs",
				status: "active",
			}),
		);
	});

	it("forces applyDaprShadowDefaults:false for a preview-native provision", async () => {
		// The workflow-orchestrator descriptor does NOT set applyDaprShadowDefaults,
		// so pre-fix the request omitted it and the SEA default (true) injected
		// PUBSUB_NAME=pubsub-dev into a vcluster whose component is named `pubsub`.
		vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
						podIP: "10.0.0.13",
						port: 8080,
						syncPort: 8001,
						ready: true,
						status: "running",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		await provisionDevPreview(
			{
				executionId: "exec-1",
				service: "workflow-orchestrator",
				mode: "preview-native",
			},
			fakePersistence(),
		);

		const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const body = JSON.parse(String(request.body));
		expect(body.previewNative).toBe(true);
		expect(body.applyDaprShadowDefaults).toBe(false);
		// The host-only shadow pubsub name must NOT leak into a preview-native pod.
		expect(body.env?.PUBSUB_NAME).toBeUndefined();
	});

	it("touches the vcluster preview on a preview-native provision with an origin", async () => {
		// A4: a dev pod landing INSIDE a vcluster preview is activity on that preview —
		// the provision pings SEA's touch endpoint (alias derived from the wfb-<name>
		// origin host) so the lifecycle reaper never sleeps a preview mid-session.
		vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
		const calls: string[] = [];
		const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
			calls.push(url);
			if (url.endsWith("/touch"))
				return new Response(
					JSON.stringify({ name: "myprev", state: "hot", resuming: false }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			return new Response(
				JSON.stringify({
					sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
					podIP: "10.0.0.13",
					port: 3000,
					syncPort: 3000,
					ready: true,
					status: "running",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		await provisionDevPreview(
			{
				executionId: "exec-1",
				service: "workflow-builder",
				mode: "preview-native",
				origin: "https://wfb-myprev.tail286401.ts.net",
			},
			fakePersistence(),
		);

		expect(calls).toContain(
			"http://sandbox-api/internal/vcluster-preview/myprev/touch",
		);
	});

	it("does not touch on a host-throwaway provision or without an origin", async () => {
		vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
		const calls: string[] = [];
		const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
			calls.push(url);
			return new Response(
				JSON.stringify({
					sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
					ready: true,
					status: "running",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		// preview-native but NO origin -> no alias to touch.
		await provisionDevPreview(
			{ executionId: "exec-1", service: "workflow-orchestrator", mode: "preview-native" },
			fakePersistence(),
		);
		expect(calls.some((u) => u.endsWith("/touch"))).toBe(false);
	});

	it("omits applyDaprShadowDefaults for a shadow-default host provision", async () => {
		// A host-throwaway orchestrator preview keeps the SEA default (the shadow env
		// IS the host-isolation mechanism there), so the BFF sends no override.
		vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						sandboxName: "wfb-dev-preview-exec-1",
						ready: true,
						status: "running",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		await provisionDevPreview(
			{ executionId: "exec-1", service: "workflow-orchestrator" },
			fakePersistence(),
		);

		const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const body = JSON.parse(String(request.body));
		expect(body.previewNative).toBeUndefined();
		expect("applyDaprShadowDefaults" in body).toBe(false);
	});

	it("fans out provisionDevPreviews and keeps successes on partial failure", async () => {
		vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
		const fetchMock = vi.fn(async (_url, init) => {
			const body = JSON.parse(String((init as RequestInit).body));
			if (body.service === "workflow-orchestrator") {
				return new Response(JSON.stringify({ detail: "boom" }), {
					status: 503,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(
				JSON.stringify({
					sandboxName: `wfb-dev-preview-${body.service}-exec-1`,
					podIP: "10.0.0.5",
					port: 3000,
					syncPort: 3000,
					ready: true,
					status: "running",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		const persistence = fakePersistence();

		const result = await provisionDevPreviews(
			{
				executionId: "exec-1",
				services: ["workflow-builder", "workflow-orchestrator"],
				mode: "preview-native",
			},
			persistence,
		);

		expect(result.ok).toBe(false);
		const bySvc = Object.fromEntries(
			result.services.map((s) => [s.service, s]),
		);
		expect(bySvc["workflow-builder"].ok).toBe(true);
		expect(bySvc["workflow-builder"].info?.sandboxName).toBe(
			"wfb-dev-preview-workflow-builder-exec-1",
		);
		expect(bySvc["workflow-orchestrator"].ok).toBe(false);
		expect(bySvc["workflow-orchestrator"].error).toContain("boom");
		// The service that came up is persisted and NOT torn down (session still useful).
		expect(persistence.upsertWorkflowWorkspaceSession).toHaveBeenCalledTimes(1);
	});

	it("forwards the sidecar /__run command allowlist + extraSync to SEA", async () => {
		vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
						podIP: "10.0.0.13",
						port: 8080,
						syncPort: 8001,
						ready: true,
						status: "running",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const info = await provisionDevPreview(
			{ executionId: "exec-1", service: "workflow-orchestrator" },
			fakePersistence(),
		);

		const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const body = JSON.parse(String(request.body));
		// deps + the contract test lane travel to SEA (→ DEV_SYNC_COMMANDS_JSON).
		expect(body.devSyncCommands).toEqual({
			deps: "pip install -r requirements.txt && touch /app/app.py",
			contract: "python -m pytest tests/test_workflow_data_activity_migration.py -q",
		});
		// The returned info carries the extraSync sources the sync client stages.
		expect(info.extraSync).toEqual([
			{ from: "../shared/workflow-data-contract", to: ".contract-fixtures" },
		]);
	});

	it("provisions functional preview databases through the injected port", async () => {
		vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
		const fetchMock = vi.fn(async (_url, init) => {
			const body = JSON.parse(String((init as RequestInit).body));
			return new Response(
				JSON.stringify({
					sandboxName: "dev-preview-exec-1",
					podIP: "10.0.0.12",
					port: 3000,
					syncPort: 3000,
					url: "http://10.0.0.12:3000",
					syncUrl: "http://10.0.0.12:3000/__sync",
					ready: true,
					status: "running",
					serviceSecretEnv: body.serviceSecretEnv,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		const persistence = fakePersistence();
		const previewDatabases = fakePreviewDatabases();

		await provisionDevPreview(
			{
				executionId: "exec-1",
				service: "workflow-builder",
			},
			persistence,
			previewDatabases,
		);

		expect(previewDatabases.provision).toHaveBeenCalledWith({
			executionId: "exec-1",
		});
		const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const body = JSON.parse(String(request.body));
		expect(body.serviceSecretEnv).toMatchObject({
			DATABASE_URL: "postgres://preview-db",
			PREVIEW_SOURCE_DATABASE_URL: "postgres://source-db",
		});
	});
});
