import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("capacity overview data remote", () => {
	it("delegates read-model work to the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "data.remote.ts"),
			"utf8",
		);

		expect(source).toContain("capacityOverview.getSchedulingLatency");
		expect(source).toContain("capacityOverview.getOverview");
		expect(source).toContain("getRequestEvent");
		expect(source).not.toContain("@opentelemetry/api");
		expect(source).not.toContain("$lib/server/otel/clickhouse");
		expect(source).not.toContain("$lib/server/otel/metrics");
		expect(source).not.toContain("$lib/server/capacity/");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});
