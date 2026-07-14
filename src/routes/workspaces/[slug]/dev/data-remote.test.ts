import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "data.remote.ts"),
	"utf8",
);
const pageSource = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "+page.svelte"),
	"utf8",
);

describe("dev hub data remote", () => {
	it("delegates reads/mutations to the application services (never the DB/legacy)", () => {
		expect(source).toContain("vclusterPreviews.list");
		expect(source).toContain("previewEnvironments.launchForUser");
		expect(source).toContain("vclusterPreviews.presentLaunch");
		expect(source).toContain("vclusterPreviews.sleep");
		expect(source).toContain("vclusterPreviews.wake");
		expect(source).toContain("previewTeardown.teardown");
		expect(source).not.toContain("previewArchive.archivePreview");
		expect(source).not.toContain("vclusterPreviews.teardown");
		expect(source).toContain("workflowData.listDevEnvironmentGroups");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/application/adapters");
		expect(source).not.toContain("$lib/server/workflows/vcluster-preview");
	});

	it("accepts the extended launch DTO without accepting client owner or trust", () => {
		expect(source).toContain("PreviewEnvironmentLaunchRequest");
		expect(source).toContain("platformRevision: input.platformRevision");
		expect(source).toContain("platformRef: input.platformRef");
		expect(source).toContain("sourceRevision: input.sourceRevision");
		expect(source).toContain("sourceRef: input.sourceRef");
		expect(source).toContain("services: input.services");
		expect(source).not.toContain("trustedCode:");
		expect(source).not.toContain("owner:");
	});

	it("uses the resume-safe PR-preview snapshot (never the resuming status())", () => {
		expect(source).toContain("prPreviews.listStatuses");
		// A browser poll must never kick a pipeline — the resuming status()/peek()
		// belong to the machine route, not this UI read.
		expect(source).not.toContain("prPreviews.status(");
		expect(source).not.toContain("prPreviews.peek(");
	});

	it("uses an owner-authorized single-preview read inside a preview", () => {
		expect(source).toContain("export const getVclusterPreview");
		expect(source).toContain("adapters.previewAccess.authorize");
		expect(source).toContain("vclusterPreviews.present(access.preview)");
		expect(pageSource).toContain("? getVclusterPreview(previewEnvironmentId)");
		expect(pageSource).toContain("controlPlane ? getPrPreviews() : null");
		expect(pageSource).not.toContain("teardownProgress={visibleTeardowns}");
	});

	it("starts the visibility poll outside reactive dependency tracking", () => {
		expect(pageSource).toContain("untrack(onVisibility)");
		expect(pageSource).toContain("untrack(() => void tick())");
		expect(pageSource).not.toContain("\n\t\tonVisibility();");
	});

	it("guards every query/command and maps application teardown refusals", () => {
		expect(source).toContain("getRequestEvent");
		expect(source).toContain("Authentication required");
		expect(source).toContain("requirePlatformAdmin");
		expect(source).toContain("requireAdminSession");
		expect(source).toContain("command(");
		expect(source).toContain("input.forceFailed === true");
		expect(source).toContain("expectedRequestId: input.expectedRequestId");
		expect(source).toContain("expectedSourceRevision: input.expectedSourceRevision");
		expect(source).toContain("PreviewAccessDeniedError");
		expect(source).toContain("PreviewTeardownRefusedError");
		expect(source).toContain("PreviewEnvironmentDesiredStateOwnershipError");
		expect(source).toContain("PreviewEnvironmentDesiredStateError");
		expect(source).toContain("error(403");
		expect(source).toContain("error(409");
		expect(source).toContain("error(503");
	});
});
