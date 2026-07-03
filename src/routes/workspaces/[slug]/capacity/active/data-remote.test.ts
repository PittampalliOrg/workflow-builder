import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("capacity active data remote", () => {
	it("delegates fleet activity reads to the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "data.remote.ts"),
			"utf8",
		);

		expect(source).toContain("capacityActive.getFleetActivity");
		expect(source).toContain("getRequestEvent");
		expect(source).not.toContain("$lib/server/sessions/fleet-activity");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});
