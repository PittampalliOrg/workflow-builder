/**
 * Drizzle column setters encode Date values, but values interpolated into raw
 * `sql` templates use the no-op encoder. postgres-js rejects those Date objects,
 * so normalize raw timestamp parameters before interpolation.
 */
export function toPostgresTimestampParam(value: Date | string): string {
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      throw new TypeError("PostgreSQL timestamp parameter must not be empty");
    }
    return value;
  }
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError("PostgreSQL timestamp parameter must be a valid Date");
  }
  return value.toISOString();
}
