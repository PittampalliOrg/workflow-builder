import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("internal workflow execution dev-preview snapshot route", () => {
	it("resolves canonical execution ids through workflow-data", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("requirePreviewActionInternal(request)");
		expect(source).not.toContain("requireInternal(request)");
		expect(source).toContain("workflowData.resolveCanonicalExecutionId");
		expect(source).toContain(
			"devPreviewSourceCapture.captureAcceptanceCandidate",
		);
		expect(source).toContain("expectedServices: services");
		expect(source).not.toContain("requireImmutableProvenance");
		expect(source).not.toContain("captureAllDevPreviewSources");
		expect(source).not.toContain("captureDevPreviewSource(");
		expect(source).not.toContain("$lib/server/workflows/dev-preview");
		expect(source).not.toContain("$lib/server/workflows/dev-environments");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("uses the same atomic capture for live PR promotion", () => {
		const source = readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				"..",
				"promote",
				"+server.ts",
			),
			"utf8",
		);

		expect(source).toContain(
			"devPreviewSourceCapture.captureAcceptanceCandidate",
		);
		expect(source).toContain("previewSourcePromotion.promote");
		expect(source).toContain("artifactId: artifact.id");
		expect(source).not.toContain("previewAcceptanceTrust");
		expect(source).not.toContain("attestSuccessfulPromotion");
		expect(source).not.toContain("PREVIEW_ACCEPTANCE_ATTESTATION_HMAC_KEY");
		expect(source).toContain("expectedServices");
		expect(source).not.toContain("requireImmutableProvenance");
		expect(source).not.toContain("captureAllDevPreviewSources");
		expect(source).not.toContain("captureDevPreviewSource(");
		expect(source).not.toContain("$lib/server/workflows/dev-preview");
		expect(source).not.toContain("HelperPodSourceBundlePromotionRunner");
		expect(source).not.toContain("GithubPreviewControlSourceAdapter");
	});
});
