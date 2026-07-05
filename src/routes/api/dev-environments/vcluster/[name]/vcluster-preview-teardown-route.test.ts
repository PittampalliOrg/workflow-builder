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
		const teardownAt = source.indexOf("await teardownVclusterPreview");
		expect(archiveAt).toBeGreaterThan(-1);
		expect(teardownAt).toBeGreaterThan(archiveAt);
	});

	it("is flag-gated and archive failures cannot block teardown", () => {
		expect(source).toContain("previewArchiveOnTeardownEnabled");
		// The archive call is wrapped: a throw degrades to archived:false.
		expect(source).toContain("archived: false");
		expect(source.indexOf("catch")).toBeLessThan(
			source.indexOf("await teardownVclusterPreview"),
		);
	});

	it("stays session-gated and adapter-free", () => {
		expect(source).toContain("locals.session?.userId");
		expect(source).not.toContain("$lib/server/application/adapters");
		expect(source).not.toContain("$lib/server/db");
	});
});
