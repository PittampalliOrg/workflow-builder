import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewDatabaseProvisioner } from "$lib/server/application/ports";
import {
	provisionDevPreview,
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
