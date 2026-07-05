import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("dev-service sidecar proxy routes (B5)", () => {
	it("sidecar-status delegates to the application sidecar service", () => {
		const source = readFileSync(join(here, "sidecar-status", "+server.ts"), "utf8");
		expect(source).toContain("locals.session?.userId");
		expect(source).toContain("devPreviewSidecar.status");
		expect(source).not.toContain("$lib/server/workflows/dev-preview-sidecar");
		expect(source).not.toContain("$lib/server/application/adapters");
		expect(source).not.toContain("$lib/server/db");
	});

	it("run delegates to the application sidecar service (allowlist enforced behind the port)", () => {
		const source = readFileSync(join(here, "run", "+server.ts"), "utf8");
		expect(source).toContain("locals.session?.userId");
		expect(source).toContain("devPreviewSidecar.run");
		expect(source).not.toContain("$lib/server/workflows/dev-preview-sidecar");
		expect(source).not.toContain("$lib/server/application/adapters");
		expect(source).not.toContain("$lib/server/db");
	});
});
