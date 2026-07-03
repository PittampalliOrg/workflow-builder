import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("compiled-capabilities source boundary", () => {
	it("keeps project persistence behind application adapters", () => {
		const source = readFileSync(
			new URL("./compiled-capabilities.ts", import.meta.url),
			"utf8",
		);

		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/db/schema");
	});
});
