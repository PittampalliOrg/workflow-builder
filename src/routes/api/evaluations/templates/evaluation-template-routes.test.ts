import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const routeRoot = new URL(".", import.meta.url).pathname;

describe("evaluation template route boundaries", () => {
	it.each([
		["swebench/+server.ts", "evaluationTemplates.createSwebench"],
		["humaneval/+server.ts", "evaluationTemplates.createCodeEval"],
		["mbpp/+server.ts", "evaluationTemplates.createCodeEval"],
		["bigcodebench/+server.ts", "evaluationTemplates.createCodeEval"],
	])("keeps %s behind application services", (file, serviceCall) => {
		const source = readFileSync(join(routeRoot, file), "utf8");
		expect(source).toContain(serviceCall);
		expect(source).not.toContain("$lib/server/evaluations/service");
		expect(source).not.toContain("$lib/server/benchmarks/swebench");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});
