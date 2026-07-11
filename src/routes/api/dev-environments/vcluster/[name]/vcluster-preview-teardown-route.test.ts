import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("vcluster preview teardown route (E3 archive-on-teardown)", () => {
	const source = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
		"utf8",
	);

	it("delegates teardown policy to the hexagonal application service", () => {
		expect(source).toContain("previewTeardown.teardown");
		expect(source).not.toContain("previewArchive.archivePreview");
		expect(source).not.toContain("vclusterPreviews.teardown");
		expect(source).not.toContain("previewArchiveOnTeardownEnabled");
	});

	it("opts into forced failed cleanup only for the exact query value", () => {
		expect(source).toContain("url.searchParams.get('forceFailed') === 'true'");
		expect(source).toContain("PreviewAccessDeniedError");
		expect(source).toContain("PreviewTeardownRefusedError");
		expect(source).toContain("error(403");
		expect(source).toContain("error(409");
	});

	it("stays session-gated and adapter-free", () => {
		expect(source).toContain("locals.session?.userId");
		expect(source).toContain("previewAccess.authorize");
		expect(source).not.toContain("$lib/server/application/adapters");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});
