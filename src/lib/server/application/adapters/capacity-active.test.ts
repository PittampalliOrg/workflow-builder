import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("SessionFleetActivityAdapter", () => {
	it("keeps fleet activity persistence inside the adapter", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "capacity-active.ts"),
			"utf8",
		);

		expect(source).toContain("$lib/server/db");
		expect(source).toContain("$lib/server/db/schema");
		expect(source).toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/sessions/fleet-activity");
		expect(source).not.toContain("summarizeFleetActivity");
	});
});
