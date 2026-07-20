import { readFileSync } from "node:fs";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

const source = readFileSync(
	new URL("./seed-workflows.ts", import.meta.url),
	"utf8",
);
const bundle = readFileSync(
	new URL("./seed-workflows.bundle.js", import.meta.url),
	"utf8",
);

function cliShowcaseHelper(text: string): string {
	const start = text.indexOf("async function ensureCliShowcaseAgentFor(");
	const end = text.indexOf("async function ensureCliShowcaseAgent(", start);
	if (start < 0 || end < 0) {
		throw new Error("ensureCliShowcaseAgentFor is missing or incomplete");
	}
	return text.slice(start, end);
}

describe("showcase agent version config persistence", () => {
	it("binds configs as JSON objects in source and the generated bundle", () => {
		for (const text of [source, bundle]) {
			const showcaseStart = text.indexOf("async function ensureShowcaseAgent(");
			const showcaseEnd = text.indexOf(
				"async function seedGeneratorCriticShowcases(",
				showcaseStart,
			);
			const showcaseHelpers = text.slice(showcaseStart, showcaseEnd);
			const helper = cliShowcaseHelper(text);
			expect(helper).toContain("sqlClient.json(config");
			expect(showcaseHelpers.match(/sqlClient\.json\(config/g)).toHaveLength(3);
			expect(showcaseHelpers).not.toContain(
				"${JSON.stringify(config)}::jsonb",
			);
		}
	});

	it("repairs a current version whose config is a JSONB scalar string", () => {
		for (const text of [source, bundle]) {
			const helper = cliShowcaseHelper(text);
			expect(helper).toContain("jsonb_typeof(config) as config_type");
			expect(helper).toContain('config_type === "object"');
		}
	});

	it("serializes the object exactly once at the postgres boundary", async () => {
		const sql = postgres("postgres://localhost/workflow", { max: 1 });
		const config = {
			runtime: "dapr-agent-py",
			modelSpec: "kimi/kimi-k3",
			reasoningEffort: "max",
			contextWindowTokens: 1_048_576,
		};

		try {
			const parameter = sql.json(config);
			const encodeJson = sql.options.serializers[3802];
			const encoded = encodeJson(parameter.value) as string;
			expect(parameter.value).toEqual(config);
			expect(JSON.parse(encoded)).toEqual(config);
			expect(typeof JSON.parse(encoded)).toBe("object");

			const doubleEncoded = encodeJson(JSON.stringify(config)) as string;
			expect(typeof JSON.parse(doubleEncoded)).toBe("string");
		} finally {
			await sql.end({ timeout: 0 });
		}
	});
});
