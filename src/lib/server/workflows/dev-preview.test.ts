import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
