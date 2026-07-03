import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("piece metadata action source boundary", () => {
	it("keeps row transformation free of direct Postgres and Drizzle imports", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "piece-metadata-source.ts"),
			"utf8",
		);

		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});
});
