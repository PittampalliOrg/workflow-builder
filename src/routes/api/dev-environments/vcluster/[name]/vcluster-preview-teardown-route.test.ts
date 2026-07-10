import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("vcluster preview teardown route (E3 archive-on-teardown)", () => {
	const source = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
		"utf8",
	);

	it("archives BEFORE issuing the SEA teardown", () => {
		const archiveAt = source.indexOf("previewArchive.archivePreview");
		const teardownAt = source.indexOf("vclusterPreviews.teardown");
		expect(archiveAt).toBeGreaterThan(-1);
		expect(teardownAt).toBeGreaterThan(archiveAt);
	});

	it("treats mutable-live archive as a teardown precondition", () => {
		expect(source).toContain("previewArchiveOnTeardownEnabled");
		expect(source).toContain("archiveRequired");
		expect(source).toContain("teardown refused");
		expect(source.indexOf("catch")).toBeLessThan(
			source.indexOf("vclusterPreviews.teardown"),
		);
	});

	it("stays session-gated and adapter-free", () => {
		expect(source).toContain("locals.session?.userId");
		expect(source).toContain("previewAccess.authorize");
		expect(source).not.toContain("$lib/server/application/adapters");
		expect(source).not.toContain("$lib/server/db");
	});
});
