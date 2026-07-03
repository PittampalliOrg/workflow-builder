import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routeFiles = [
	"aggregate/+server.ts",
	"../v1/capacity/rightsizing/+server.ts",
	"../internal/sessions/resource-sample/+server.ts",
];

const forbidden = [
	"$lib/server/metrics/aggregate",
	"$lib/server/metrics/session-usage",
	"$lib/server/db",
	"$lib/server/db/schema",
	"drizzle-orm",
];

describe("resource metrics route boundary", () => {
	it("delegates metric read and sample commands to the application service", () => {
		const root = dirname(fileURLToPath(import.meta.url));

		for (const file of routeFiles) {
			const source = readFileSync(join(root, file), "utf8");
			expect(source).toContain("resourceMetrics.");
			for (const token of forbidden) {
				expect(source).not.toContain(token);
			}
		}
	});
});
