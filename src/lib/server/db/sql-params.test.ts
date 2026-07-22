import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { toPostgresTimestampParam } from "./sql-params";

describe("toPostgresTimestampParam", () => {
  it("keeps raw Drizzle SQL parameters compatible with postgres-js", () => {
    const timestamp = new Date("2026-07-22T06:06:42.385Z");
    const query = new PgDialect().sqlToQuery(
      sql`select ${toPostgresTimestampParam(timestamp)}`,
    );

    expect(query.params).toEqual(["2026-07-22T06:06:42.385Z"]);
    expect(query.params[0]).not.toBeInstanceOf(Date);
  });

  it("preserves timestamp strings returned by raw postgres-js queries", () => {
    const timestamp = "2026-07-22 01:02:03.456";

    expect(toPostgresTimestampParam(timestamp)).toBe(timestamp);
  });

  it("rejects invalid dates before they reach the database driver", () => {
    expect(() => toPostgresTimestampParam(new Date(Number.NaN))).toThrow(
      "PostgreSQL timestamp parameter must be a valid Date",
    );
  });

  it("rejects empty timestamp strings", () => {
    expect(() => toPostgresTimestampParam("  ")).toThrow(
      "PostgreSQL timestamp parameter must not be empty",
    );
  });
});
