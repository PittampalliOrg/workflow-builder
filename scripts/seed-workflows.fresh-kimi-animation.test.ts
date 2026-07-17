import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./seed-workflows.ts", import.meta.url),
  "utf8",
);

describe("fresh Kimi K3 animation seed", () => {
  it("creates the new dynamic workflow without reconciling prior animation workflows", () => {
    expect(source).toContain("KIMI_K3_ANIMATION_WORKFLOW_ID");
    expect(source).toContain('engineType: "dynamic-script"');
    expect(source).not.toContain('"three-b-one-b-skill-animation"');
    expect(source).not.toContain('"three-b-one-b-skill-animation-cli"');
  });

  it("isolates raw JSON parameters from Drizzle's postgres serializers", async () => {
    expect(source).toContain("const drizzleSql = postgres(DATABASE_URL");
    expect(source).toContain("const db = drizzle(drizzleSql");
    expect(source).not.toContain("const db = drizzle(sql");

    const rawSql = postgres("postgres://localhost/workflow", { max: 1 });
    const drizzleSql = postgres("postgres://localhost/workflow", { max: 1 });
    try {
      drizzle(drizzleSql);
      expect(rawSql.options.serializers[3802]({ key: "value" })).toBe(
        '{"key":"value"}',
      );
      expect(drizzleSql.options.serializers[3802]({ key: "value" })).toEqual({
        key: "value",
      });
    } finally {
      await Promise.all([
        rawSql.end({ timeout: 0 }),
        drizzleSql.end({ timeout: 0 }),
      ]);
    }
  });
});
