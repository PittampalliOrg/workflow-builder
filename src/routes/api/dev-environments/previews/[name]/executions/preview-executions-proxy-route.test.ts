import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("preview executions proxy route (E2)", () => {
	const source = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
		"utf8",
	);

	it("is session-gated and flag-gated (404 when off)", () => {
		expect(source).toContain("locals.session?.userId");
		expect(source).toContain("previewReadProxyEnabled");
	});

	it("goes through the application service, not adapters or raw fetch", () => {
		expect(source).toContain("previewReadProxy.listPreviewExecutions");
		expect(source).not.toContain("$lib/server/application/adapters");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("fetch(");
	});
});
