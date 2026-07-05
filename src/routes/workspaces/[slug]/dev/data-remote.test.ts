import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "data.remote.ts"),
	"utf8",
);

describe("dev hub data remote", () => {
	it("delegates reads/mutations to the application services (never the DB/legacy)", () => {
		expect(source).toContain("vclusterPreviews.list");
		expect(source).toContain("vclusterPreviews.launch");
		expect(source).toContain("vclusterPreviews.sleep");
		expect(source).toContain("vclusterPreviews.wake");
		expect(source).toContain("vclusterPreviews.teardown");
		expect(source).toContain("workflowData.listDevEnvironmentGroups");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/workflows/vcluster-preview");
	});

	it("uses the resume-safe PR-preview snapshot (never the resuming status())", () => {
		expect(source).toContain("prPreviews.listStatuses");
		// A browser poll must never kick a pipeline — the resuming status()/peek()
		// belong to the machine route, not this UI read.
		expect(source).not.toContain("prPreviews.status(");
		expect(source).not.toContain("prPreviews.peek(");
	});

	it("guards every query/command on the session and composes archive-before-teardown", () => {
		expect(source).toContain("getRequestEvent");
		expect(source).toContain("Authentication required");
		expect(source).toContain("command(");
		// Teardown archives first (flag-gated) then tears down.
		const archiveAt = source.indexOf("previewArchive.archivePreview");
		const teardownAt = source.indexOf("vclusterPreviews.teardown");
		expect(archiveAt).toBeGreaterThan(-1);
		expect(teardownAt).toBeGreaterThan(archiveAt);
	});
});
