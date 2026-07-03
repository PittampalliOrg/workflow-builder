import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("AI assistant messages route", () => {
	it("uses workflow-data for message history persistence", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "[workflowId]/+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("listAiAssistantMessages");
		expect(source).toContain("deleteAiAssistantMessages");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});
});
