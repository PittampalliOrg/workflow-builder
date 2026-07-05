import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("preview execution detail proxy route (E2)", () => {
	const source = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
		"utf8",
	);

	it("is session-gated, flag-gated, and served by the application service", () => {
		expect(source).toContain("locals.session?.userId");
		expect(source).toContain("previewReadProxyEnabled");
		expect(source).toContain("previewReadProxy.getPreviewExecution");
		expect(source).not.toContain("$lib/server/application/adapters");
		expect(source).not.toContain("$lib/server/db");
	});
});
